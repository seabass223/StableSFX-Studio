import { useRef, useState } from 'react'
import { AudioLines, ChevronDown, Download, FolderInput, Repeat, Rewind, Scissors, SlidersHorizontal, MoveHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import type { AudioFormat, ProcessOp, SfxItem } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ExportDialog, exportItems } from './ExportDialog'
import { KeepDialog } from './KeepDialog'
import { SliderField } from './Field'
import { engineApi } from '@/lib/api'
import { useEngine } from '@/store/engine'
import { useStudio } from '@/store/studio'
import { cn } from '@/lib/utils'

function FadeIcon({ out }: { out?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d={out ? 'M3 5 L21 19' : 'M3 19 L21 5'} />
      <path d={out ? 'M3 5 L3 19 L21 19' : 'M3 19 L21 19 L21 5'} fill="currentColor" opacity={0.25} stroke="none" />
    </svg>
  )
}

function ToolButton({ icon, label, onClick, disabled, title }: { icon: React.ReactNode; label: string; onClick(): void; disabled?: boolean; title?: string }) {
  return (
    <Button
      variant="secondary"
      className="h-11 min-w-[104px] gap-2 px-3.5 text-[14px] font-normal"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      {label}
    </Button>
  )
}

export function ProcessBar() {
  const clip = useStudio((s) => s.clip)
  const regions = useStudio((s) => s.regions)
  const busy = useStudio((s) => s.busyProcessing)
  const process = useStudio((s) => s.process)
  const config = useEngine((s) => s.config)
  const [exportOpen, setExportOpen] = useState(false)
  const [keepOpen, setKeepOpen] = useState(false)
  const disabled = !clip || busy
  const sel = regions[0]
  const fmt = (config?.output.format ?? 'wav') as AudioFormat

  const run = (ops: ProcessOp[]): void => void process(ops)

  return (
    <div className="panel flex shrink-0 items-center gap-3 px-4 py-2.5">
      <div className="flex flex-1 flex-col gap-2">
        <span className="label-caps">Edit &amp; Process</span>
        <div className="flex flex-wrap gap-2.5">
          <ToolButton
            icon={<Scissors className="size-5" />}
            label="Trim"
            disabled={disabled}
            title={sel ? `Keep only ${sel[0].toFixed(2)}–${sel[1].toFixed(2)} s` : 'Trim leading/trailing silence (select a region to trim to it)'}
            onClick={() => run(sel ? [{ op: 'trim', start: sel[0], end: sel[1] }] : [{ op: 'trim_silence', threshold_db: -50, pad_ms: 10, head: true, tail: true }])}
          />
          <ToolButton icon={<AudioLines className="size-5" />} label="Normalize" disabled={disabled} title="Peak normalize to -1 dBFS" onClick={() => run([{ op: 'normalize', mode: 'peak', target: -1 }])} />
          <ToolButton icon={<FadeIcon />} label="Fade In" disabled={disabled} title={sel ? 'Fade in over the selection length' : '30 ms fade in'} onClick={() => run([{ op: 'fade_in', ms: sel ? (sel[1] - sel[0]) * 1000 : 30, curve: 'exp' }])} />
          <ToolButton icon={<FadeIcon out />} label="Fade Out" disabled={disabled} title={sel ? 'Fade out over the selection length' : '150 ms fade out'} onClick={() => run([{ op: 'fade_out', ms: sel ? (sel[1] - sel[0]) * 1000 : 150, curve: 'exp' }])} />
          <ToolButton icon={<Rewind className="size-5" />} label="Reverse" disabled={disabled} onClick={() => run([{ op: 'reverse' }])} />
          <ToolButton icon={<Repeat className="size-5" />} label="Loop" disabled={disabled} title="Make seamless with a 250 ms tail→head crossfade (or use the AI Loop mode)" onClick={() => run([{ op: 'loop_crossfade', ms: 250 }])} />
          <MoreTools disabled={disabled} onRun={run} />
        </div>
      </div>
      <div className="mx-2 h-16 w-px bg-border" />
      <div className="flex items-center gap-3 self-end">
        <Button variant="secondary" className="h-12 gap-2 px-4" disabled={!clip} onClick={() => setKeepOpen(true)} title="Keep this clip in the library">
          <FolderInput className="size-5" /> Keep
        </Button>
        <div className={cn('key flex h-12 overflow-hidden', !clip && 'key-dim')}>
          <button
            className="flex items-center gap-3 px-5 text-[15px] font-normal tracking-[0.05em] hover:bg-white/5 disabled:opacity-50"
            disabled={!clip}
            onClick={() => clip && quickExport(clip, fmt)}
          >
            <Download className="size-5" /> EXPORT {fmt.toUpperCase()}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className="w-10 border-l border-[#4a403a] hover:bg-white/5 disabled:opacity-50" disabled={!clip}>
              <ChevronDown className="mx-auto size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(['wav', 'flac', 'mp3'] as const).map((f) => (
                <DropdownMenuItem key={f} onClick={() => clip && quickExport(clip, f)}>
                  Export {f.toUpperCase()}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setExportOpen(true)}>Export settings…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DragToDaw clip={clip} />
      </div>
      {clip && <ExportDialog items={[clip]} open={exportOpen} onOpenChange={setExportOpen} />}
      {clip && <KeepDialog item={clip} open={keepOpen} onOpenChange={setKeepOpen} />}
    </div>
  )
}

async function quickExport(clip: SfxItem, format: AudioFormat): Promise<void> {
  const cfg = useEngine.getState().config
  await exportItems([clip], {
    format,
    sample_rate: cfg?.output.sample_rate ?? 44100,
    bit_depth: cfg?.output.bit_depth ?? 24,
    channels: cfg?.output.channels ?? 2,
    mp3_bitrate: cfg?.output.mp3_bitrate ?? 320
  })
}

function MoreTools({ disabled, onRun }: { disabled: boolean; onRun(ops: ProcessOp[]): void }) {
  const [gain, setGain] = useState(-3)
  const [pitch, setPitch] = useState(-2)
  const [stretch, setStretch] = useState(1.25)
  const [hp, setHp] = useState(120)
  const [lp, setLp] = useState(8000)
  const [lufs, setLufs] = useState(-16)
  const row = 'grid grid-cols-[1fr_auto] items-end gap-3'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" className="h-11 gap-2 px-3.5 font-normal" disabled={disabled}>
          <SlidersHorizontal className="size-5" /> More
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px]" align="start" side="top">
        <div className="flex flex-col gap-4">
          <div className={row}>
            <SliderField label="Gain" value={gain} min={-24} max={12} step={0.5} decimals={1} unit=" dB" onChange={setGain} />
            <Button size="sm" onClick={() => onRun([{ op: 'gain', db: gain }])}>Apply</Button>
          </div>
          <div className={row}>
            <SliderField label="Loudness" value={lufs} min={-30} max={-6} step={0.5} decimals={1} unit=" LUFS" onChange={setLufs} />
            <Button size="sm" onClick={() => onRun([{ op: 'normalize', mode: 'lufs', target: lufs }])}>Normalize</Button>
          </div>
          <div className={row}>
            <SliderField label="Pitch" value={pitch} min={-24} max={24} step={0.5} decimals={1} unit=" st" onChange={setPitch} />
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" title="Varispeed: length changes" onClick={() => onRun([{ op: 'pitch', semitones: pitch, preserve_length: false }])}>Vari</Button>
              <Button size="sm" title="Keep length" onClick={() => onRun([{ op: 'pitch', semitones: pitch, preserve_length: true }])}>Keep len</Button>
            </div>
          </div>
          <div className={row}>
            <SliderField label="Time stretch" value={stretch} min={0.5} max={3} step={0.05} decimals={2} unit="×" onChange={setStretch} />
            <Button size="sm" onClick={() => onRun([{ op: 'stretch', factor: stretch }])}>
              <MoveHorizontal className="size-4" /> Apply
            </Button>
          </div>
          <div className={row}>
            <SliderField label="High-pass" value={hp} min={20} max={2000} step={10} decimals={0} unit=" Hz" onChange={setHp} />
            <Button size="sm" onClick={() => onRun([{ op: 'highpass', freq_hz: hp, q: 0.707 }])}>Apply</Button>
          </div>
          <div className={row}>
            <SliderField label="Low-pass" value={lp} min={500} max={20000} step={100} decimals={0} unit=" Hz" onChange={setLp} />
            <Button size="sm" onClick={() => onRun([{ op: 'lowpass', freq_hz: lp, q: 0.707 }])}>Apply</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => onRun([{ op: 'mono' }])}>To mono</Button>
            <Button size="sm" variant="secondary" onClick={() => onRun([{ op: 'stereo' }])}>To stereo</Button>
            <Button size="sm" variant="secondary" onClick={() => onRun([{ op: 'trim_silence', threshold_db: -50, pad_ms: 10, head: true, tail: true }])}>Trim silence</Button>
            <Button size="sm" variant="secondary" onClick={() => onRun([{ op: 'resample', sample_rate: 48000 }])}>Resample 48k</Button>
            <Button size="sm" variant="secondary" onClick={() => onRun([{ op: 'pad', head_ms: 0, tail_ms: 100 }])}>+100 ms tail</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Every edit makes a new version in History; use undo (Ctrl+Z) to step back.</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Native drag-out (Unity, Explorer, DAWs). History takes are kept to Inbox first so the file never gets pruned. */
function DragToDaw({ clip }: { clip: SfxItem | null }) {
  const pathRef = useRef<string | null>(null)
  const prepare = async (): Promise<void> => {
    if (!clip) return
    pathRef.current = clip.path
    if (clip.kind === 'history') {
      try {
        const kept = await engineApi.keep({ id: clip.id, folder: 'Inbox' })
        pathRef.current = kept.path
        useStudio.setState((s) => ({ clip: s.clip?.id === clip.id ? kept : s.clip, takes: s.takes.map((t) => (t.id === clip.id ? kept : t)) }))
        toast.success('Kept to Library/Inbox for dragging', { description: kept.name })
      } catch {
        /* fall back to the history path */
      }
    }
  }
  return (
    <div
      draggable={Boolean(clip)}
      onMouseDown={() => void prepare()}
      onDragStart={(e) => {
        e.preventDefault()
        if (pathRef.current) window.api.files.startDrag(pathRef.current)
      }}
      className={cn(
        'flex h-12 items-center gap-3 rounded-md border border-dashed border-[#6b5f57] px-5 text-[15px] font-normal tracking-[0.05em] text-[#d2c0b0] [&_svg]:text-[#ffc9a3]',
        clip ? 'cursor-grab hover:border-primary/60 hover:text-foreground active:cursor-grabbing' : 'opacity-50'
      )}
      title="Drag into Unity, Explorer or your DAW"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" />
        <path d="M18 3v4h-4M6 21v-4h4" />
      </svg>
      DRAG TO DAW
    </div>
  )
}
