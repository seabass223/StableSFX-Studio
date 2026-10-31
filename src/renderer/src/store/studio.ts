/** Generate-view state: parameters (with A/B slots and undo/redo), mode, source, current clip and takes. */
import { create } from 'zustand'
import { toast } from 'sonner'
import type { GenerateParams, JobInfo, JobMode, JobRequest, ModelId, Preset, ProcessOp, SfxItem } from '@shared/ipc'
import { engineApi } from '@/lib/api'

export const DEFAULT_PARAMS: GenerateParams = {
  model: 'small-sfx',
  prompt: '',
  negative_prompt: '',
  sfx_prefix: true,
  duration: 2,
  seed: -1,
  steps: null,
  cfg_scale: null,
  apg_scale: 1,
  cfg_interval: [0, 1],
  cfg_rescale: 0,
  cfg_norm_threshold: 0,
  sampler: null,
  duration_padding: 6,
  chunked_decode: null,
  shift: {
    type: 'default',
    anchor_length: 2000,
    anchor_logsnr: -6.2,
    rate: 0,
    logsnr_end: 2,
    min_length: 256,
    max_length: 4096,
    alpha_min: 6.93,
    alpha_max: 6.93,
    base_shift: 0.5,
    max_shift: 1.15
  },
  loras: []
}

export type Region = [number, number]

type UndoEntry = { kind: 'params'; before: GenerateParams; after: GenerateParams } | { kind: 'clip'; before: SfxItem | null; after: SfxItem | null }

interface StudioStore {
  params: GenerateParams
  slots: { A: GenerateParams; B: GenerateParams }
  slot: 'A' | 'B'
  presetId: string | null
  mode: JobMode
  variations: number
  strength: number
  inpaintStrength: number
  preserveOutside: boolean
  extendSeconds: number
  loopSeam: number
  regions: Region[]
  source: SfxItem | null
  clip: SfxItem | null
  takes: SfxItem[]
  jobId: string | null
  lastGenTime: number | null
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
  busyProcessing: boolean
  setParams(patch: Partial<GenerateParams>, opts?: { coalesce?: string }): void
  setModel(model: ModelId): void
  setMode(mode: JobMode): void
  set(patch: Partial<Pick<StudioStore, 'variations' | 'strength' | 'inpaintStrength' | 'preserveOutside' | 'extendSeconds' | 'loopSeam' | 'regions'>>): void
  switchSlot(slot: 'A' | 'B'): void
  copySlot(): void
  applyPreset(preset: Preset): void
  loadClip(item: SfxItem | null, opts?: { asSource?: boolean; record?: boolean }): void
  setSource(item: SfxItem | null): void
  clone(item: SfxItem, similarity?: 'close' | 'medium' | 'loose'): void
  generate(variations?: number, overrides?: Partial<JobRequest>): Promise<void>
  cancel(): Promise<void>
  onJob(job: JobInfo): void
  process(ops: ProcessOp[]): Promise<void>
  undo(): void
  redo(): void
}

const SIMILARITY = { close: 0.2, medium: 0.4, loose: 0.65 } as const
let coalesceKey: string | null = null
let coalesceTimer: ReturnType<typeof setTimeout> | null = null

export const useStudio = create<StudioStore>((set, get) => ({
  params: { ...DEFAULT_PARAMS },
  slots: { A: { ...DEFAULT_PARAMS }, B: { ...DEFAULT_PARAMS } },
  slot: 'A',
  presetId: null,
  mode: 'text',
  variations: 4,
  strength: 0.4,
  inpaintStrength: 1,
  preserveOutside: true,
  extendSeconds: 2,
  loopSeam: 0.75,
  regions: [],
  source: null,
  clip: null,
  takes: [],
  jobId: null,
  lastGenTime: null,
  undoStack: [],
  redoStack: [],
  busyProcessing: false,

  setParams(patch, opts) {
    const before = get().params
    const after = { ...before, ...patch }
    const stack = [...get().undoStack]
    // Coalesce rapid changes to the same control (knob drags, typing) into one undo step.
    if (opts?.coalesce && opts.coalesce === coalesceKey && stack.length && stack[stack.length - 1].kind === 'params') {
      const last = stack[stack.length - 1] as Extract<UndoEntry, { kind: 'params' }>
      stack[stack.length - 1] = { ...last, after }
    } else {
      stack.push({ kind: 'params', before, after })
    }
    coalesceKey = opts?.coalesce ?? null
    if (coalesceTimer) clearTimeout(coalesceTimer)
    coalesceTimer = setTimeout(() => (coalesceKey = null), 800)
    set((s) => ({ params: after, slots: { ...s.slots, [s.slot]: after }, undoStack: stack.slice(-200), redoStack: [] }))
  },

  setModel(model) {
    // Steps/guidance/sampler fall back to the new model's defaults.
    get().setParams({ model, steps: null, cfg_scale: null, sampler: null, sfx_prefix: !model.startsWith('small-music') })
  },

  setMode(mode) {
    const { clip, source } = get()
    set({ mode, source: mode === 'text' ? source : source ?? clip })
  },

  set(patch) {
    set(patch)
  },

  switchSlot(slot) {
    set((s) => ({ slots: { ...s.slots, [s.slot]: s.params }, slot, params: s.slots[slot] }))
  },

  copySlot() {
    set((s) => {
      const other = s.slot === 'A' ? 'B' : 'A'
      return { slots: { ...s.slots, [other]: s.params } }
    })
    toast.success(`Copied ${get().slot} → ${get().slot === 'A' ? 'B' : 'A'}`)
  },

  applyPreset(preset) {
    get().setParams({ ...DEFAULT_PARAMS, ...preset.params, shift: { ...DEFAULT_PARAMS.shift, ...preset.params.shift } })
    set({ presetId: preset.id, variations: preset.variations, mode: preset.mode ?? 'text' })
  },

  loadClip(item, opts) {
    const before = get().clip
    if (opts?.record && before?.id !== item?.id) {
      set((s) => ({ undoStack: [...s.undoStack, { kind: 'clip' as const, before, after: item }].slice(-200), redoStack: [] }))
    }
    set({ clip: item, regions: [] })
    if (opts?.asSource) set({ source: item })
  },

  setSource(item) {
    set({ source: item })
  },

  clone(item, similarity = 'close') {
    const prompt = item.prompt ?? ''
    if (!prompt) toast.info('This clip has no prompt yet: describe it so the model knows what to keep.')
    get().setParams({ prompt, ...(item.model ? { model: item.model as ModelId } : {}) })
    set({ mode: 'audio2audio', source: item, clip: item, strength: SIMILARITY[similarity], variations: 4, regions: [] })
  },

  async generate(variations, overrides) {
    const s = get()
    if (s.mode !== 'text' && !s.source) {
      toast.error('Load or pick a source clip first (drop a file on the waveform, or use a take).')
      return
    }
    if (s.mode === 'inpaint' && !s.regions.length) {
      toast.error('Drag on the waveform to select the region(s) to regenerate.')
      return
    }
    const body: JobRequest = {
      mode: s.mode,
      params: s.params,
      variations: variations ?? 1,
      source: s.mode === 'text' ? null : s.source?.id ?? null,
      strength: s.mode === 'audio2audio' ? s.strength : s.inpaintStrength,
      duration_from_source: true,
      regions: s.regions,
      preserve_outside: s.preserveOutside,
      extend_seconds: s.extendSeconds,
      loop_seam_seconds: s.loopSeam,
      target: 'history',
      folder: null,
      name: null,
      tags: [],
      post: [],
      origin: 'app',
      ...overrides
    }
    try {
      const job = await engineApi.submit(body)
      set({ jobId: job.id })
    } catch (err) {
      toast.error((err as Error).message)
    }
  },

  async cancel() {
    const id = get().jobId
    if (id) await engineApi.cancel(id).catch(() => undefined)
  },

  onJob(job) {
    if (job.id !== get().jobId) return
    if (job.state === 'done') {
      const results = job.results
      const gen = results[0]?.generation_time ?? null
      set({ takes: results, jobId: null, lastGenTime: gen })
      if (results[0]) get().loadClip(results[0], { record: true })
    } else if (job.state === 'error') {
      set({ jobId: null })
      toast.error('Generation failed', { description: job.error ?? undefined })
    } else if (job.state === 'cancelled') {
      set({ jobId: null })
    }
  },

  async process(ops) {
    const clip = get().clip
    if (!clip) return
    set({ busyProcessing: true })
    try {
      const next = await engineApi.process({ source: clip.id, ops, target: 'history' })
      get().loadClip(next, { record: true })
      set((s) => ({ takes: s.takes.map((t) => (t.id === clip.id ? next : t)) }))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      set({ busyProcessing: false })
    }
  },

  undo() {
    const stack = [...get().undoStack]
    const entry = stack.pop()
    if (!entry) return
    if (entry.kind === 'params') set((s) => ({ params: entry.before, slots: { ...s.slots, [s.slot]: entry.before } }))
    else set({ clip: entry.before, regions: [] })
    set((s) => ({ undoStack: stack, redoStack: [...s.redoStack, entry] }))
  },

  redo() {
    const stack = [...get().redoStack]
    const entry = stack.pop()
    if (!entry) return
    if (entry.kind === 'params') set((s) => ({ params: entry.after, slots: { ...s.slots, [s.slot]: entry.after } }))
    else set({ clip: entry.after, regions: [] })
    set((s) => ({ redoStack: stack, undoStack: [...s.undoStack, entry] }))
  }
}))
