import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Redo2, Settings, Undo2 } from 'lucide-react'
import type { Preset } from '@shared/ipc'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Wordmark } from './Logo'
import { engineApi } from '@/lib/api'
import { useEngine } from '@/store/engine'
import { useNav } from '@/store/nav'
import { useStudio } from '@/store/studio'
import { cn } from '@/lib/utils'

export function usePresets(): Preset[] {
  const version = useEngine((s) => s.presetsVersion)
  const ready = useEngine((s) => s.phase === 'ready')
  const [presets, setPresets] = useState<Preset[]>([])
  useEffect(() => {
    if (ready) engineApi.presets().then(setPresets).catch(() => undefined)
  }, [version, ready])
  return presets
}

export function TitleBar() {
  const go = useNav((s) => s.go)
  const slot = useStudio((s) => s.slot)
  const switchSlot = useStudio((s) => s.switchSlot)
  const copySlot = useStudio((s) => s.copySlot)
  const undo = useStudio((s) => s.undo)
  const redo = useStudio((s) => s.redo)
  const canUndo = useStudio((s) => s.undoStack.length > 0)
  const canRedo = useStudio((s) => s.redoStack.length > 0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return (
    <header className="drag-region flex h-[68px] shrink-0 items-center gap-5 border-b border-black/70 shadow-[inset_0_1px_0_rgb(106_92_83/0.55)] bg-gradient-to-b from-[#231f1c] to-[#26211d] pl-6 pr-[150px] title-tight:gap-3">
      <Wordmark />
      <div className="h-10 w-px shrink-0 bg-border" />
      <PresetPicker />
      <div className="no-drag flex shrink-0 -space-x-px">
        {(['A', 'B'] as const).map((s) => (
          <button
            key={s}
            onClick={() => switchSlot(s)}
            onDoubleClick={copySlot}
            title={`Parameter slot ${s} (double-click to copy the active slot into the other)`}
            className={cn('key h-11 w-12 text-[17px] font-medium', slot === s ? 'key-on relative z-10' : 'key-dim')}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="no-drag flex shrink-0 -space-x-px">
        <button className="key relative z-10 flex h-11 w-12 items-center justify-center" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 className="size-6" />
        </button>
        <button className="key flex h-11 w-12 items-center justify-center" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
          <Redo2 className="size-6" />
        </button>
      </div>
      <EnginePill />
      <button className="key no-drag flex size-11 shrink-0 items-center justify-center" onClick={() => go('settings')} title="Settings">
        <Settings className="size-6" />
      </button>
    </header>
  )
}

function PresetPicker() {
  const presets = usePresets()
  const presetId = useStudio((s) => s.presetId)
  const applyPreset = useStudio((s) => s.applyPreset)
  const [open, setOpen] = useState(false)
  const idx = presets.findIndex((p) => p.id === presetId)
  const current = presets[idx]
  const step = (d: number): void => {
    if (!presets.length) return
    applyPreset(presets[(idx + d + presets.length) % presets.length])
  }
  const categories = [...new Set(presets.map((p) => p.category))]
  return (
    <div className="no-drag flex min-w-0 items-center gap-3">
      <span className="label-caps shrink-0 title-tight:hidden">Preset</span>
      <div className="key key-well flex h-11 min-w-0 overflow-hidden">
        <button className="w-10 shrink-0 border-r border-[#4a403a] bg-white/[0.04] hover:bg-white/10" onClick={() => step(-1)} title="Previous preset">
          <ChevronLeft className="mx-auto size-4" />
        </button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="flex w-[260px] min-w-0 items-center justify-between gap-2 px-3 text-left text-[15px] hover:bg-white/5">
            <span className="truncate">{current ? `${current.category} / ${current.name}` : 'Choose a preset…'}</span>
            <ChevronDown className="size-4 shrink-0" />
          </PopoverTrigger>
          <PopoverContent className="w-[360px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search presets…" />
              <CommandList className="max-h-[420px]">
                <CommandEmpty>No presets.</CommandEmpty>
                {categories.map((c) => (
                  <CommandGroup key={c} heading={c}>
                    {presets
                      .filter((p) => p.category === c)
                      .map((p) => (
                        <CommandItem
                          key={p.id}
                          value={`${p.category} ${p.name} ${p.params.prompt}`}
                          onSelect={() => {
                            applyPreset(p)
                            setOpen(false)
                          }}
                        >
                          <span className="flex-1 truncate">{p.name}</span>
                          <span className="text-xs text-muted-foreground">{p.params.duration}s</span>
                          {p.id === presetId && <Check className="size-4 text-primary" />}
                        </CommandItem>
                      ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <button className="w-10 shrink-0 border-l border-[#4a403a] bg-white/[0.04] hover:bg-white/10" onClick={() => step(1)} title="Next preset">
          <ChevronRight className="mx-auto size-4" />
        </button>
      </div>
    </div>
  )
}

function EnginePill() {
  const status = useEngine((s) => s.status)
  const connection = useEngine((s) => s.connection)
  const phase = useEngine((s) => s.phase)
  const go = useNav((s) => s.go)
  const ok = phase === 'ready' && connection === 'connected' && status?.ready
  const busy = status?.busy
  const color = !ok ? 'bg-destructive' : status?.device === 'cuda' ? 'bg-success' : 'bg-warning'
  const gpu = status?.device_name?.replace(/^NVIDIA (GeForce )?/, '') ?? 'starting…'
  const label = !ok
    ? phase === 'setup'
      ? 'SETTING UP'
      : connection.startsWith('reconnect')
        ? 'RECONNECTING'
        : 'STARTING'
    : `${gpu}${status?.vram_total_gb ? ` ${Math.round(status.vram_total_gb)}GB` : ''}`
  return (
    <button
      onClick={() => go('settings')}
      className={cn(
        'key key-well engine-pill no-drag ml-auto flex h-11 shrink-0 items-center gap-2.5 whitespace-nowrap px-4 text-[14px] font-medium tracking-[0.04em]',
        ok && status?.device === 'cuda' ? 'text-[#72dd80]' : 'text-muted-foreground'
      )}
      title={status ? `${status.torch ?? ''} · CUDA ${status.cuda ?? 'n/a'} · model: ${status.loaded_model ?? 'none loaded'}${status.fake ? ' · FAKE BACKEND' : ''}` : 'Engine'}
    >
      <span className={cn('size-2.5 rounded-full shadow-[0_0_8px_currentColor]', color, busy && 'animate-pulse')} />
      <span>
        {ok && <span className="title-tight:hidden">LOCAL · </span>}
        {label}
      </span>
      {status?.fake && <span className="text-warning">· FAKE</span>}
    </button>
  )
}
