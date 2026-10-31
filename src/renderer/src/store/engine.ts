import { create } from 'zustand'
import type { EngineConfig, EngineEvent, EngineStatus, JobInfo, ModelInfo } from '@shared/ipc'
import { engineApi } from '@/lib/api'

type Phase = 'checking' | 'setup' | 'connecting' | 'ready' | 'error'

export interface ModelProgress {
  state: string
  done?: number
  total?: number
  error?: string
}

interface EngineStore {
  phase: Phase
  error: string | null
  setupLog: string[]
  connection: string
  status: EngineStatus | null
  models: ModelInfo[]
  config: EngineConfig | null
  modelProgress: Record<string, ModelProgress>
  jobs: Record<string, JobInfo>
  /** Bumped on library/history/presets events so views can refetch. */
  libraryVersion: number
  historyVersion: number
  presetsVersion: number
  logLines: string[]
  jobListeners: Set<(job: JobInfo) => void>
  init(): Promise<void>
  runSetup(): Promise<void>
  refresh(): Promise<void>
  refreshModels(): Promise<void>
  patchConfig(patch: Partial<EngineConfig>): Promise<void>
  onJob(fn: (job: JobInfo) => void): () => void
}

let wired = false

export const useEngine = create<EngineStore>((set, get) => ({
  phase: 'checking',
  error: null,
  setupLog: [],
  connection: 'connecting',
  status: null,
  models: [],
  config: null,
  modelProgress: {},
  jobs: {},
  libraryVersion: 0,
  historyVersion: 0,
  presetsVersion: 0,
  logLines: [],
  jobListeners: new Set(),

  async init() {
    if (!wired) {
      wired = true
      window.api.setup.onLog((line) => set((s) => ({ setupLog: [...s.setupLog.slice(-400), line] })))
      window.api.engine.onConnection((connection) => set({ connection }))
      window.api.engine.onEvent((e) => handleEvent(e, set, get))
    }
    set({ phase: 'checking', error: null })
    const state = await window.api.setup.state()
    if (!state.envReady) {
      set({ phase: 'setup' })
      await get().runSetup()
      return
    }
    await connect(set, get)
  },

  async runSetup() {
    set({ phase: 'setup', error: null })
    try {
      await window.api.setup.run()
      await connect(set, get)
    } catch (err) {
      set({ phase: 'error', error: (err as Error).message })
    }
  },

  async refresh() {
    const [status, models, config] = await Promise.all([engineApi.status(), engineApi.models(), engineApi.config()])
    set({ status, models, config })
  },

  async refreshModels() {
    set({ models: await engineApi.models() })
  },

  async patchConfig(patch) {
    const config = await engineApi.patchConfig(patch)
    set({ config })
  },

  onJob(fn) {
    get().jobListeners.add(fn)
    return () => get().jobListeners.delete(fn)
  }
}))

async function connect(
  set: (p: Partial<EngineStore>) => void,
  get: () => EngineStore
): Promise<void> {
  set({ phase: 'connecting' })
  const r = await window.api.engine.connect()
  if (!r.ok) {
    set({ phase: 'error', error: r.error ?? 'could not start the engine' })
    return
  }
  await get().refresh()
  set({ phase: 'ready', connection: 'connected' })
}

function handleEvent(
  e: EngineEvent,
  set: (fn: Partial<EngineStore> | ((s: EngineStore) => Partial<EngineStore>)) => void,
  get: () => EngineStore
): void {
  switch (e.type) {
    case 'status':
      set({ status: e.data })
      break
    case 'job':
      set((s) => ({ jobs: { ...s.jobs, [e.data.id]: e.data } }))
      for (const fn of get().jobListeners) fn(e.data)
      if (['done', 'error', 'cancelled'].includes(e.data.state)) {
        engineApi.status().then((status) => set({ status })).catch(() => undefined)
      }
      break
    case 'model':
      set((s) => ({ modelProgress: { ...s.modelProgress, [e.data.model]: e.data } }))
      if (['downloaded', 'loaded', 'unloaded', 'error'].includes(e.data.state)) {
        void get().refreshModels()
        engineApi.status().then((status) => set({ status })).catch(() => undefined)
      }
      break
    case 'config':
      set({ config: e.data })
      break
    case 'library':
      set((s) => ({ libraryVersion: s.libraryVersion + 1 }))
      break
    case 'history':
      set((s) => ({ historyVersion: s.historyVersion + 1 }))
      break
    case 'presets':
      set((s) => ({ presetsVersion: s.presetsVersion + 1 }))
      break
    case 'log':
      set((s) => ({ logLines: [...s.logLines.slice(-300), e.data.line] }))
      break
  }
}

export function modelDefaults(models: ModelInfo[], id: string): ModelInfo['defaults'] {
  return (
    models.find((m) => m.id === id)?.defaults ?? { steps: 8, cfg_scale: 1, sampler: 'pingpong', max_duration: 120 }
  )
}
