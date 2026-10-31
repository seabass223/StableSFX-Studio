import { useState } from 'react'
import { Copy, Dices, FolderInput, MoreVertical, Pause, Play, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import type { SfxItem } from '@shared/ipc'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MiniWave } from './MiniWave'
import { KeepDialog } from './KeepDialog'
import { engineApi, fmtTime } from '@/lib/api'
import { usePreview } from '@/lib/preview'
import { useStudio } from '@/store/studio'
import { cn } from '@/lib/utils'

export function TakesRow() {
  const takes = useStudio((s) => s.takes)
  const clip = useStudio((s) => s.clip)
  const jobId = useStudio((s) => s.jobId)
  return (
    <div className="panel flex shrink-0 flex-col gap-2 px-4 pb-3 pt-2.5">
      <div className="flex items-center gap-3">
        <span className="label-caps">Variations</span>
        {takes.length > 0 && <span className="text-xs text-muted-foreground">click a take to edit it · ⋮ to keep it in the library</span>}
      </div>
      {takes.length === 0 ? (
        <div className="flex h-[60px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {jobId ? 'Generating…' : 'Takes from the last generation appear here (they live in History until you keep them).'}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {takes.slice(0, 8).map((t, i) => (
            <TakeCard key={t.id} item={t} index={i} selected={clip?.id === t.id} />
          ))}
        </div>
      )}
    </div>
  )
}

function TakeCard({ item, index, selected }: { item: SfxItem; index: number; selected: boolean }) {
  const studio = useStudio()
  const preview = usePreview()
  const playing = preview.playingId === item.id
  const [keepOpen, setKeepOpen] = useState(false)

  return (
    <div
      className={cn(
        'take-card group relative flex cursor-pointer items-center gap-3 px-3 py-2.5',
        selected && 'take-card-on'
      )}
      onClick={() => studio.loadClip(item, { record: true })}
    >
      <button
        className="take-play flex size-12 shrink-0 items-center justify-center rounded-full"
        onClick={(e) => {
          e.stopPropagation()
          preview.toggle(item)
        }}
        title="Audition"
      >
        {playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
      </button>
      <div className="flex w-[64px] shrink-0 flex-col">
        <span className="text-sm font-medium">Take {index + 1}</span>
        <span className="font-mono text-xs text-muted-foreground">{fmtTime(item.stats?.duration ?? 0)}</span>
      </div>
      <MiniWave peaks={item.peaks} active={selected} progress={playing ? preview.progress : undefined} className="mr-3 h-12 min-w-0 flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={(e) => e.stopPropagation()}>
          <MoreVertical className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => setKeepOpen(true)}>
            <FolderInput className="size-4" /> Keep to library…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => studio.clone(item, 'close')}>
            <Copy className="size-4" /> Clone (close variations)
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              studio.loadClip(item, { record: true })
              studio.setSource(item)
              studio.setMode('audio2audio')
            }}
          >
            <Wand2 className="size-4" /> Use as source (modify)
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (item.params) studio.setParams({ ...(item.params as object), seed: -1 })
              void studio.generate(1)
            }}
          >
            <Dices className="size-4" /> Re-roll (same params, new seed)
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (item.params) {
                studio.setParams({ ...(item.params as object) })
                toast.success(`Loaded params (seed ${item.seed})`)
              }
            }}
          >
            <Sparkles className="size-4" /> Copy params to controls
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onClick={async () => {
              await engineApi.deleteItem(item.id).catch(() => undefined)
              useStudio.setState((s) => ({ takes: s.takes.filter((t) => t.id !== item.id), clip: s.clip?.id === item.id ? null : s.clip }))
            }}
          >
            <Trash2 className="size-4" /> Discard
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <KeepDialog item={item} open={keepOpen} onOpenChange={setKeepOpen} />
    </div>
  )
}
