import { Plus, Trash2 } from 'lucide-react'
import type { GenerateParams, LoraSpec, ShiftParams } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { FieldLabel, RangeField, SliderField } from './Field'
import { DEFAULT_PARAMS, useStudio } from '@/store/studio'
import { modelDefaults, useEngine } from '@/store/engine'

const SHIFT_HELP: Record<ShiftParams['type'], string> = {
  default: "The model's own inference schedule (recommended).",
  logsnr: 'Steps spaced uniformly in log-SNR; the start drops by `rate` per doubling of length.',
  flux: 'Flux/SD3-style shift: alpha > 1 spends more steps at high noise.',
  full: 'Length-dependent sigmoid shift between base and max shift.',
  none: 'Linear schedule, no shift.'
}

/** Every remaining Stable Audio 3 sampling parameter. */
export function AdvancedPanel() {
  const params = useStudio((s) => s.params)
  const setParams = useStudio((s) => s.setParams)
  const models = useEngine((s) => s.models)
  const d = modelDefaults(models, params.model)
  const shift = params.shift
  const setShift = (patch: Partial<ShiftParams>): void => setParams({ shift: { ...shift, ...patch } }, { coalesce: 'shift' })
  const set = (key: keyof GenerateParams) => (v: unknown) => setParams({ [key]: v } as Partial<GenerateParams>, { coalesce: key })
  const guidanceActive = (params.cfg_scale ?? d.cfg_scale) !== 1

  return (
    <div className="grid grid-cols-4 gap-x-8 gap-y-5 pt-4">
      <div className="col-span-2 flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <FieldLabel hint="What to steer away from. Only applied when guidance is not 1.0.">Negative prompt</FieldLabel>
          {!guidanceActive && <span className="text-[11px] text-warning">inactive at guidance 1.0</span>}
        </div>
        <Textarea
          rows={2}
          className="resize-none bg-panel text-sm"
          placeholder="e.g. music, speech, distortion"
          value={params.negative_prompt}
          onChange={(e) => setParams({ negative_prompt: e.target.value }, { coalesce: 'neg' })}
        />
      </div>
      <div className="flex flex-col gap-2">
        <FieldLabel hint="Diffusion sampler. Distilled models are trained for pingpong.">Sampler</FieldLabel>
        <Select value={params.sampler ?? 'default'} onValueChange={(v) => setParams({ sampler: v === 'default' ? null : (v as GenerateParams['sampler']) })}>
          <SelectTrigger className="w-full bg-panel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Model default ({d.sampler})</SelectItem>
            <SelectItem value="pingpong">pingpong</SelectItem>
            <SelectItem value="euler">euler</SelectItem>
            <SelectItem value="dpmpp">dpmpp</SelectItem>
            <SelectItem value="rk4">rk4 (4 evals/step)</SelectItem>
          </SelectContent>
        </Select>
        <div className="mt-2 flex items-center justify-between">
          <FieldLabel hint="Prepend 'TrackType: SFX, ' (upstream prompting guide: better SFX).">SFX prompt prefix</FieldLabel>
          <Switch checked={params.sfx_prefix} onCheckedChange={(v) => setParams({ sfx_prefix: v })} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <FieldLabel hint="Decode latents in overlapping chunks (less VRAM).">Chunked decode</FieldLabel>
        <Select
          value={params.chunked_decode === null || params.chunked_decode === undefined ? 'default' : params.chunked_decode ? 'on' : 'off'}
          onValueChange={(v) => setParams({ chunked_decode: v === 'default' ? null : v === 'on' })}
        >
          <SelectTrigger className="w-full bg-panel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Model default</SelectItem>
            <SelectItem value="on">On</SelectItem>
            <SelectItem value="off">Off</SelectItem>
          </SelectContent>
        </Select>
        <SliderField
          className="mt-2"
          label="Duration padding"
          hint="Extra seconds of latent headroom beyond the requested duration."
          value={params.duration_padding}
          min={0}
          max={30}
          step={0.5}
          decimals={1}
          unit=" s"
          onChange={set('duration_padding')}
        />
      </div>

      <SliderField label="APG" hint="Adaptive projected guidance: 1 = full APG, 0 = vanilla CFG. Needs guidance ≠ 1." value={params.apg_scale} min={0} max={1} step={0.01} onChange={set('apg_scale')} />
      <RangeField
        label="Guidance interval"
        hint="Guidance only applies while the noise level is inside this range."
        value={params.cfg_interval as [number, number]}
        min={0}
        max={1}
        step={0.01}
        onChange={set('cfg_interval')}
      />
      <SliderField label="CFG rescale" hint="Rescales guided output toward the conditional std (reduces over-saturation)." value={params.cfg_rescale} min={0} max={1} step={0.01} onChange={set('cfg_rescale')} />
      <SliderField label="CFG norm threshold" hint="Clamp the guidance delta norm (0 = off)." value={params.cfg_norm_threshold} min={0} max={100} step={0.5} decimals={1} onChange={set('cfg_norm_threshold')} />

      <div className="col-span-4 grid grid-cols-4 gap-x-8 gap-y-4 rounded-lg border border-border/60 p-4">
        <div className="flex flex-col gap-2">
          <FieldLabel hint={SHIFT_HELP[shift.type]}>Schedule shift</FieldLabel>
          <Select value={shift.type} onValueChange={(v) => setShift({ type: v as ShiftParams['type'] })}>
            <SelectTrigger className="w-full bg-panel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Model default</SelectItem>
              <SelectItem value="logsnr">Log-SNR</SelectItem>
              <SelectItem value="flux">Flux</SelectItem>
              <SelectItem value="full">Full (length-based)</SelectItem>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-snug text-muted-foreground">{SHIFT_HELP[shift.type]}</p>
        </div>
        {shift.type === 'logsnr' && (
          <>
            <SliderField label="Anchor log-SNR" value={shift.anchor_logsnr} min={-12} max={0} step={0.1} decimals={1} onChange={(v) => setShift({ anchor_logsnr: v })} />
            <SliderField label="Rate" value={shift.rate} min={-2} max={2} step={0.05} onChange={(v) => setShift({ rate: v })} />
            <SliderField label="Log-SNR end" value={shift.logsnr_end} min={-2} max={6} step={0.1} decimals={1} onChange={(v) => setShift({ logsnr_end: v })} />
            <SliderField label="Anchor length" value={shift.anchor_length} min={100} max={10000} step={50} decimals={0} onChange={(v) => setShift({ anchor_length: v })} />
          </>
        )}
        {shift.type === 'flux' && (
          <>
            <SliderField label="Alpha min" value={shift.alpha_min} min={0.1} max={20} step={0.01} onChange={(v) => setShift({ alpha_min: v })} />
            <SliderField label="Alpha max" value={shift.alpha_max} min={0.1} max={20} step={0.01} onChange={(v) => setShift({ alpha_max: v })} />
            <SliderField label="Min length" value={shift.min_length} min={1} max={10000} step={1} decimals={0} onChange={(v) => setShift({ min_length: v })} />
            <SliderField label="Max length" value={shift.max_length} min={1} max={10000} step={1} decimals={0} onChange={(v) => setShift({ max_length: v })} />
          </>
        )}
        {shift.type === 'full' && (
          <>
            <SliderField label="Base shift" value={shift.base_shift} min={0} max={5} step={0.01} onChange={(v) => setShift({ base_shift: v })} />
            <SliderField label="Max shift" value={shift.max_shift} min={0} max={5} step={0.01} onChange={(v) => setShift({ max_shift: v })} />
            <SliderField label="Min length" value={shift.min_length} min={1} max={10000} step={1} decimals={0} onChange={(v) => setShift({ min_length: v })} />
            <SliderField label="Max length" value={shift.max_length} min={1} max={10000} step={1} decimals={0} onChange={(v) => setShift({ max_length: v })} />
          </>
        )}
      </div>

      <LoraEditor loras={params.loras} onChange={(loras) => setParams({ loras })} />

      <div className="col-span-4 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setParams({ ...DEFAULT_PARAMS, model: params.model, prompt: params.prompt, duration: params.duration, seed: params.seed })
          }
        >
          Reset advanced to defaults
        </Button>
      </div>
    </div>
  )
}

function LoraEditor({ loras, onChange }: { loras: LoraSpec[]; onChange(l: LoraSpec[]): void }) {
  const update = (i: number, patch: Partial<LoraSpec>): void => onChange(loras.map((l, k) => (k === i ? { ...l, ...patch } : l)))
  return (
    <div className="col-span-4 flex flex-col gap-3 rounded-lg border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <FieldLabel hint="Style adapters (.safetensors). Changing the set reloads the model; strength changes are instant.">LoRAs</FieldLabel>
        <LoraAdd onAdd={(path) => onChange([...loras, { path, strength: 1, interval: [0, 1], layer_filter: '' }])} />
      </div>
      {loras.length === 0 && <p className="text-xs text-muted-foreground">No LoRAs. Add a .safetensors file trained for Stable Audio 3.</p>}
      {loras.map((l, i) => (
        <div key={l.path + i} className="grid grid-cols-[1fr_180px_180px_160px_auto] items-end gap-4">
          <div className="min-w-0">
            <span className="block truncate text-sm" title={l.path}>
              {l.path.split(/[\\/]/).pop()}
            </span>
          </div>
          <SliderField label="Strength" value={l.strength} min={0} max={10} step={0.05} onChange={(v) => update(i, { strength: v })} />
          <RangeField label="Interval" value={l.interval as [number, number]} min={0} max={1} step={0.01} onChange={(v) => update(i, { interval: v })} />
          <Input placeholder="layer filter" className="h-8 bg-panel text-xs" value={l.layer_filter} onChange={(e) => update(i, { layer_filter: e.target.value })} />
          <Button variant="ghost" size="icon" onClick={() => onChange(loras.filter((_, k) => k !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
    </div>
  )
}

function LoraAdd({ onAdd }: { onAdd(path: string): void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
      <Plus className="size-3.5" /> Add LoRA
      <input
        type="file"
        accept=".safetensors"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onAdd(window.api.files.pathFor(f))
          e.target.value = ''
        }}
      />
    </label>
  )
}
