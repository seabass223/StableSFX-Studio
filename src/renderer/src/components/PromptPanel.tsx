import { useState } from 'react'
import { ChevronDown, Dices, Download, Info, Layers, Lock, Shuffle, X } from 'lucide-react'
import type { JobMode, ModelId } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AdvancedPanel } from './AdvancedPanel'
import { SparkIcon } from './Logo'
import { ParamKnob } from './ParamKnob'
import { modelDefaults, useEngine } from '@/store/engine'
import { useStudio } from '@/store/studio'
import { engineApi } from '@/lib/api'
import { cn } from '@/lib/utils'

const MODES: { id: JobMode; label: string; hint: string }[] = [
  { id: 'text', label: 'Text → SFX', hint: 'Generate from the prompt' },
  { id: 'audio2audio', label: 'Modify / Clone', hint: 'Audio-to-audio from the source clip' },
  { id: 'inpaint', label: 'Inpaint', hint: 'Regenerate selected regions, keep the rest' },
  { id: 'extend', label: 'Extend', hint: 'Continue the clip' },
  { id: 'loop', label: 'AI Loop', hint: 'Heal the loop seam with the model' }
]

export function PromptPanel() {
  const s = useStudio()
  const models = useEngine((e) => e.models)
  const job = useEngine((e) => (s.jobId ? e.jobs[s.jobId] : undefined))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const p = s.params
  const d = modelDefaults(models, p.model)
  const busy = Boolean(s.jobId)
  const words = p.prompt.trim() ? p.prompt.trim().split(/\s+/).length : 0
  const tokens = Math.round(words * 1.35)
  const selected = models.find((m) => m.id === p.model)

  const runLabel = busy
    ? job?.state === 'loading'
      ? 'LOADING MODEL'
      : `${Math.round((job?.progress ?? 0) * 100)}%`
    : 'GENERATE'

  return (
    <div className="@container/prompt-panel panel flex shrink-0 flex-col px-5 pb-3 pt-3">
      <div className="mb-2.5 flex items-center gap-4">
        <ToggleGroup
          type="single"
          value={s.mode}
          onValueChange={(v) => v && s.setMode(v as JobMode)}
          spacing={1}
          className="key key-well p-0.5"
        >
          {MODES.map((m) => (
            <ToggleGroupItem
              key={m.id}
              value={m.id}
              title={m.hint}
              className={cn('h-7 px-3 text-xs', s.mode === m.id && 'key key-on')}
            >
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {s.mode !== 'text' && (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="label-caps">Source</span>
            {s.source ? (
              <span className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-panel px-2 py-1 text-foreground">
                <span className="max-w-[260px] truncate">{s.source.name}</span>
                {s.clip && s.clip.id !== s.source.id && (
                  <button className="ml-1 text-primary hover:underline" onClick={() => s.setSource(s.clip)} title="Use the clip in the editor as the source">
                    use current
                  </button>
                )}
                <button onClick={() => s.setSource(null)} className="ml-1 hover:text-foreground" title="Clear source">
                  <X className="size-3" />
                </button>
              </span>
            ) : (
              <span className="text-warning">none: generate a take, pick one, or drop a file on the waveform</span>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-4">
        <span className="label-caps w-[64px] shrink-0 pt-3">Prompt</span>
        <div className="panel-inset relative flex-1 bg-[#1e1b19]">
          <textarea
            className="h-[74px] w-full resize-none bg-transparent px-4 py-2.5 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60"
            placeholder={
              s.mode === 'text'
                ? 'Describe the sound: source, action, decay, recording. e.g. "Heavy wooden door slam, short room reverb, close mic"'
                : 'Prompt for the regenerated audio (defaults to the source clip’s prompt)'
            }
            value={p.prompt}
            maxLength={1000}
            onChange={(e) => s.setParams({ prompt: e.target.value }, { coalesce: 'prompt' })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void s.generate(e.shiftKey ? s.variations : 1)
            }}
          />
          <div className="absolute bottom-1.5 right-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <PromptTips />
            <span className={cn(tokens > 256 && 'text-destructive')}>{p.prompt.length} chars · ~{tokens}/256 tokens</span>
          </div>
        </div>
        <div className="flex w-[450px] shrink-0 gap-3">
          <Button
            className="h-[74px] flex-1 text-[19px] font-medium tracking-[0.06em]"
            onClick={() => (busy ? s.cancel() : s.generate(1))}
            title={busy ? 'Cancel' : 'Generate one take (Ctrl+Enter)'}
          >
            <SparkIcon className="size-7" />
            {busy ? (
              <span className="flex flex-col items-center leading-tight">
                {runLabel}
                <span className="text-[10px] font-medium tracking-normal opacity-80">click to cancel</span>
              </span>
            ) : (
              runLabel
            )}
          </Button>
          <div className="key key-sheen flex h-[74px] w-[190px] overflow-hidden">
            <button
              className="flex flex-1 items-center justify-center gap-2 text-[15px] font-medium tracking-[0.05em] hover:bg-white/5 disabled:opacity-50"
              onClick={() => s.generate(s.variations)}
              disabled={busy}
              title="Generate several takes with consecutive seeds (Ctrl+Shift+Enter)"
            >
              <Layers className="size-5" />
              {s.variations} VARIATIONS
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger className="w-7 border-l border-[#4a403a] hover:bg-white/5">
                <ChevronDown className="mx-auto size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Takes per batch</DropdownMenuLabel>
                {[2, 3, 4, 6, 8, 12, 16].map((n) => (
                  <DropdownMenuItem key={n} onClick={() => s.set({ variations: n })}>
                    {n} variations
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[minmax(210px,0.85fr)_repeat(4,minmax(0,1fr))] items-center gap-5 border-t border-border/60 pt-3 param-tight:grid-cols-[minmax(160px,0.8fr)_repeat(4,minmax(0,1fr))] param-tight:gap-3">
        <div className="flex min-w-0 items-center gap-3 param-tight:flex-col param-tight:items-stretch param-tight:gap-0.5">
          <span className="label-caps shrink-0 param-tight:leading-tight">Model</span>
          <Select value={p.model} onValueChange={(v) => s.setModel(v as ModelId)}>
            <SelectTrigger className="h-10 w-full bg-panel param-tight:data-[size=default]:h-[30px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex items-center gap-2">
                    {m.label}
                    {!m.downloaded && <Download className="size-3.5 text-muted-foreground" />}
                    {m.note && <Info className="size-3.5 text-warning" />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ParamKnob
          label="Duration"
          value={p.duration}
          min={0.25}
          max={d.max_duration}
          step={0.05}
          log
          defaultValue={2}
          unit="s"
          decimals={2}
          disabled={s.mode !== 'text'}
          hint={s.mode === 'text' ? 'Length in seconds' : 'Set by the source clip in this mode'}
          onChange={(v) => s.setParams({ duration: v }, { coalesce: 'duration' })}
        />
        <ParamKnob
          label="Seed"
          value={p.seed < 0 ? 0 : p.seed}
          min={0}
          max={99999}
          step={1}
          decimals={0}
          display={p.seed < 0 ? 'Random' : String(p.seed)}
          hint="Fixed seeds reproduce a take exactly; variations use seed, seed+1, …"
          onChange={(v) => s.setParams({ seed: Math.round(v) }, { coalesce: 'seed' })}
          adornment={
            <span className="flex items-center gap-1">
              {s.clip?.seed != null && (
                <button title={`Reuse the current clip's seed (${s.clip.seed})`} onClick={() => s.setParams({ seed: s.clip!.seed! })} className="text-muted-foreground hover:text-primary">
                  <Dices className="size-4" />
                </button>
              )}
              <button
                title={p.seed < 0 ? 'Lock a seed' : 'Back to random'}
                onClick={() => s.setParams({ seed: p.seed < 0 ? Math.floor(Math.random() * 99999) : -1 })}
                className={cn('hover:text-primary', p.seed < 0 ? 'text-muted-foreground' : 'text-primary')}
              >
                {p.seed < 0 ? <Shuffle className="size-4" /> : <Lock className="size-4" />}
              </button>
            </span>
          }
        />
        <ParamKnob
          label="Guidance"
          value={p.cfg_scale ?? d.cfg_scale}
          min={0}
          max={25}
          step={0.1}
          defaultValue={d.cfg_scale}
          decimals={1}
          hint={`Classifier-free guidance. Model default ${d.cfg_scale}; distilled models are tuned for 1.0 (guidance off).`}
          onChange={(v) => s.setParams({ cfg_scale: v }, { coalesce: 'cfg' })}
        />
        <ParamKnob
          label="Steps"
          value={p.steps ?? d.steps}
          min={1}
          max={200}
          step={1}
          decimals={0}
          defaultValue={d.steps}
          hint={`Sampling steps. Model default ${d.steps}; more steps rarely help distilled models.`}
          onChange={(v) => s.setParams({ steps: Math.round(v) }, { coalesce: 'steps' })}
        />
      </div>

      {s.mode !== 'text' && <ModeControls />}

      {selected && !selected.downloaded && (
        <p className="mt-3 flex items-center gap-2 text-xs text-warning">
          <Download className="size-3.5" /> {selected.label} isn’t downloaded yet; it downloads on first use (or from Settings → Models).
          <button className="text-primary hover:underline" onClick={() => engineApi.downloadModel(selected.id)}>
            Download now
          </button>
        </p>
      )}
      {selected?.note && <p className="mt-2 text-xs text-warning">{selected.note}</p>}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="mt-2.5 flex items-center gap-1.5 text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase hover:text-foreground">
          <ChevronDown className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')} />
          Advanced: negative prompt, sampler, guidance shaping, schedule, LoRA
        </CollapsibleTrigger>
        <CollapsibleContent>
          <AdvancedPanel />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ModeControls() {
  const s = useStudio()
  return (
    <div className="mt-4 flex items-center gap-8 rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-3">
      {s.mode === 'audio2audio' && (
        <>
          <ParamKnob
            className="w-[340px]"
            label="Strength"
            value={s.strength}
            min={0.01}
            max={1}
            step={0.01}
            decimals={2}
            defaultValue={0.4}
            hint="How far to move from the source: ~0.2 close variations, ~0.5 related, 0.8+ loose."
            onChange={(v) => s.set({ strength: v })}
          />
          <div className="flex gap-2">
            {(
              [
                ['Close', 0.2],
                ['Medium', 0.4],
                ['Loose', 0.65]
              ] as const
            ).map(([label, v]) => (
              <Button key={label} size="sm" variant={Math.abs(s.strength - v) < 0.01 ? 'default' : 'secondary'} onClick={() => s.set({ strength: v })}>
                {label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Clone = same prompt, low strength, several variations. Change the prompt to restyle.</p>
        </>
      )}
      {s.mode === 'inpaint' && (
        <>
          <span className="text-sm">
            <span className="font-semibold text-primary">{s.regions.length}</span> region{s.regions.length === 1 ? '' : 's'} selected
          </span>
          <ParamKnob
            className="w-[340px]"
            label="Keep shape"
            value={s.inpaintStrength}
            min={0.05}
            max={1}
            step={0.01}
            decimals={2}
            defaultValue={1}
            hint="1.0 = regenerate the regions freely; lower keeps the original's structure inside them too."
            onChange={(v) => s.set({ inpaintStrength: v })}
          />
          <PreserveSwitch />
        </>
      )}
      {s.mode === 'extend' && (
        <>
          <ParamKnob
            className="w-[340px]"
            label="Extend by"
            value={s.extendSeconds}
            min={0.25}
            max={60}
            step={0.25}
            log
            decimals={2}
            unit="s"
            defaultValue={2}
            onChange={(v) => s.set({ extendSeconds: v })}
          />
          <PreserveSwitch />
        </>
      )}
      {s.mode === 'loop' && (
        <>
          <ParamKnob
            className="w-[340px]"
            label="Seam"
            value={s.loopSeam}
            min={0.1}
            max={5}
            step={0.05}
            decimals={2}
            unit="s"
            defaultValue={0.75}
            hint="Length of the regenerated window across the loop point."
            onChange={(v) => s.set({ loopSeam: v })}
          />
          <p className="max-w-[460px] text-xs text-muted-foreground">
            The clip is rotated so its end→start seam sits mid-file, then the model rewrites a window across it. Best for sustained sounds (ambience,
            hums, fire). Clip must be ≥ 1 s. Export loops as WAV/FLAC.
          </p>
        </>
      )}
    </div>
  )
}

function PreserveSwitch() {
  const s = useStudio()
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Paste the untouched original back outside the regenerated part (bit-exact).">
      <Switch checked={s.preserveOutside} onCheckedChange={(v) => s.set({ preserveOutside: v })} />
      Keep original outside regions
    </label>
  )
}

function PromptTips() {
  return (
    <Popover>
      <PopoverTrigger className="hover:text-foreground" title="Prompting tips">
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-[380px] text-sm leading-relaxed" side="top" align="end">
        <p className="mb-2 font-semibold text-primary">Prompting sound effects</p>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          <li>Describe the <b className="text-foreground">source</b>, the <b className="text-foreground">action</b> and its <b className="text-foreground">decay</b>, then the recording: mic distance, room, processing.</li>
          <li>Keep durations realistic: UI/impacts 0.3–2 s, actions 1–5 s, ambiences 6–15 s.</li>
          <li>"TrackType: SFX" is added automatically for SFX models (toggle in Advanced).</li>
          <li>English only; the models don’t do speech.</li>
          <li>Generate variations, keep the best, then Clone it for close alternates.</li>
        </ul>
      </PopoverContent>
    </Popover>
  )
}
