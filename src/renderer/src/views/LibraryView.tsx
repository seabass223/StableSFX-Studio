import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Copy, Download, ExternalLink, FolderInput, FolderOpen, FolderPlus, History, Import, Pause, Play, Search, Star, Trash2, Wand2
} from 'lucide-react'
import { toast } from 'sonner'
import type { FolderNode, SfxItem } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MiniWave } from '@/components/MiniWave'
import { KeepDialog } from '@/components/KeepDialog'
import { ExportDialog } from '@/components/ExportDialog'
import { engineApi, fmtTime } from '@/lib/api'
import { useLibraryTree } from '@/lib/hooks'
import { usePreview } from '@/lib/preview'
import { useEngine } from '@/store/engine'
import { useNav } from '@/store/nav'
import { useStudio } from '@/store/studio'
import { cn } from '@/lib/utils'

const HISTORY = '__history__'
const MIME = 'application/x-stablesfx-id'

export function LibraryView() {
  const tree = useLibraryTree()
  const libraryVersion = useEngine((s) => s.libraryVersion)
  const historyVersion = useEngine((s) => s.historyVersion)
  const [folder, setFolder] = useState<string>('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('modified')
  const [items, setItems] = useState<SfxItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [dropping, setDropping] = useState(false)
  const preview = usePreview()

  const load = useCallback(async () => {
    try {
      const list =
        folder === HISTORY ? await engineApi.history(query || undefined) : await engineApi.items({ folder: folder || undefined, q: query || undefined, sort })
      setItems(list)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [folder, query, sort])

  useEffect(() => {
    const t = setTimeout(load, query ? 200 : 0)
    return () => clearTimeout(t)
  }, [load, libraryVersion, historyVersion, query])

  // External changes (files added in Explorer, MCP edits): rescan on window focus.
  useEffect(() => {
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const current = useMemo(() => items.find((i) => i.id === selected[0]) ?? null, [items, selected])
  const selectedItems = items.filter((i) => selected.includes(i.id))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space' && current) {
        e.preventDefault()
        e.stopImmediatePropagation()
        preview.toggle(current)
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
        e.preventDefault()
        const i = items.findIndex((x) => x.id === selected[0])
        const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
        setSelected([next.id])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [current, items, selected, preview])

  const onDropFiles = async (e: React.DragEvent): Promise<void> => {
    setDropping(false)
    if (e.dataTransfer.types.includes(MIME)) return
    e.preventDefault()
    const paths = [...e.dataTransfer.files].map((f) => window.api.files.pathFor(f)).filter((p) => /\.(wav|flac|mp3|ogg|aiff?)$/i.test(p))
    if (!paths.length) return
    const target = folder && folder !== HISTORY ? folder : 'Imported'
    const added = await engineApi.importFiles(paths, target)
    toast.success(`Imported ${added.length} file${added.length === 1 ? '' : 's'} into ${target}`)
  }

  const importViaDialog = async (): Promise<void> => {
    const paths = await window.api.files.chooseAudio()
    if (!paths.length) return
    const target = folder && folder !== HISTORY ? folder : 'Imported'
    const added = await engineApi.importFiles(paths, target)
    toast.success(`Imported ${added.length} file${added.length === 1 ? '' : 's'} into ${target}`)
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <FolderPanel tree={tree} folder={folder} onSelect={(f) => { setFolder(f); setSelected([]) }} />
      <div
        className={cn('panel flex min-w-0 flex-1 flex-col', dropping && 'ring-2 ring-primary')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDropping(true)
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDropFiles}
      >
        <div className="flex items-center gap-3 border-b border-border/70 p-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-10 bg-panel pl-9" placeholder="Search names, prompts, tags, models…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="h-10 w-[150px] bg-panel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="modified">Newest</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="duration">Duration</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="secondary" className="h-10" onClick={importViaDialog}>
            <Import className="size-4" /> Import
          </Button>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
          <span>{folder === HISTORY ? 'History (auto-pruned takes)' : folder || 'All sounds'}</span>
          <span>·</span>
          <span>{items.length} item{items.length === 1 ? '' : 's'}</span>
          {selected.length > 1 && <span className="text-primary">· {selected.length} selected</span>}
          <span className="ml-auto">Drop audio files here to import · Space to audition · drag rows onto a folder to move</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 px-3 pb-3">
            {items.map((it) => (
              <ItemRow
                key={it.id}
                item={it}
                selected={selected.includes(it.id)}
                onSelect={(multi) =>
                  setSelected((s) => (multi ? (s.includes(it.id) ? s.filter((x) => x !== it.id) : [...s, it.id]) : [it.id]))
                }
                selectedItems={selectedItems.length > 1 && selected.includes(it.id) ? selectedItems : [it]}
              />
            ))}
            {items.length === 0 && (
              <div className="flex h-60 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <FolderOpen className="size-8 opacity-50" />
                {query ? 'Nothing matches.' : folder === HISTORY ? 'No takes in History.' : 'Empty. Keep takes from Generate, or drop audio files here.'}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      {current && <DetailPanel item={current} />}
    </div>
  )
}

function FolderPanel({ tree, folder, onSelect }: { tree: FolderNode | null; folder: string; onSelect(f: string): void }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [over, setOver] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  const moveInto = async (e: React.DragEvent, target: string): Promise<void> => {
    setOver(null)
    const ids = e.dataTransfer.getData(MIME)
    if (!ids) return
    e.preventDefault()
    for (const id of ids.split('\n')) {
      if (id.startsWith('hist:')) await engineApi.keep({ id, folder: target })
      else await engineApi.patchItem(id, { folder: target })
    }
    toast.success(`Moved to ${target || 'Library'}`)
  }

  const node = (n: FolderNode, depth: number): React.ReactNode => (
    <div key={n.path || '__root'}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm',
              folder === n.path ? 'bg-primary/15 text-primary' : 'hover:bg-accent',
              over === n.path && 'ring-1 ring-primary'
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onSelect(n.path)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(MIME)) {
                e.preventDefault()
                setOver(n.path)
              }
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => void moveInto(e, n.path)}
          >
            <FolderOpen className="size-4 shrink-0 opacity-70" />
            <span className="flex-1 truncate">{n.name}</span>
            <span className="text-xs text-muted-foreground">{n.count}</span>
          </button>
        </ContextMenuTrigger>
        {n.path && (
          <ContextMenuContent>
            <ContextMenuItem
              onClick={() => {
                setRenaming(n.path)
                setName(n.path)
              }}
            >
              Rename…
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive"
              onClick={async () => {
                if (window.confirm(`Move folder "${n.path}" and its ${n.count} sounds to the Recycle Bin?`)) {
                  await engineApi.deleteFolder(n.path).catch((err) => toast.error(err.message))
                  onSelect('')
                }
              }}
            >
              Delete folder
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
      {n.children.map((c) => node(c, depth + 1))}
    </div>
  )

  return (
    <div className="panel flex w-[250px] shrink-0 flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="label-caps">Folders</span>
        <button className="text-muted-foreground hover:text-foreground" title="New folder" onClick={() => setCreating(true)}>
          <FolderPlus className="size-4" />
        </button>
      </div>
      {creating && (
        <Input
          autoFocus
          className="mb-2 h-8"
          placeholder="Folder (e.g. Weapons/Lasers)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setCreating(false)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && name.trim()) {
              const r = await engineApi.createFolder(name.trim())
              setCreating(false)
              setName('')
              onSelect(r.path)
            }
            if (e.key === 'Escape') setCreating(false)
          }}
        />
      )}
      {renaming && (
        <Input
          autoFocus
          className="mb-2 h-8"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setRenaming(null)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && name.trim() && name.trim() !== renaming) {
              const r = await engineApi.renameFolder(renaming, name.trim()).catch((err: Error) => {
                toast.error(err.message)
                return null
              })
              setRenaming(null)
              if (r) onSelect(r.path)
            }
            if (e.key === 'Escape') setRenaming(null)
          }}
        />
      )}
      <ScrollArea className="min-h-0 flex-1">{tree ? node(tree, 0) : null}</ScrollArea>
      <div className="mt-2 border-t border-border pt-2">
        <button
          className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm', folder === HISTORY ? 'bg-primary/15 text-primary' : 'hover:bg-accent')}
          onClick={() => onSelect(HISTORY)}
        >
          <History className="size-4 opacity-70" /> History
        </button>
        <button
          className="mt-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={async () => window.api.files.openPath((await engineApi.status()).library_path)}
        >
          <ExternalLink className="size-4" /> Open in Explorer
        </button>
      </div>
    </div>
  )
}

function ItemRow({ item, selected, onSelect, selectedItems }: { item: SfxItem; selected: boolean; onSelect(multi: boolean): void; selectedItems: SfxItem[] }) {
  const preview = usePreview()
  const playing = preview.playingId === item.id
  const [keepOpen, setKeepOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const actions = useItemActions(item)
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(MIME, selectedItems.map((i) => i.id).join('\n'))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={(e) => onSelect(e.ctrlKey || e.metaKey)}
            onDoubleClick={actions.open}
            className={cn(
              'grid cursor-default grid-cols-[40px_160px_minmax(0,1fr)_auto_70px_110px] items-center gap-4 rounded-lg border px-3 py-2',
              selected ? 'border-primary/60 bg-primary/[0.07]' : 'border-transparent hover:bg-accent/60'
            )}
          >
            <button
              className="take-play flex size-9 items-center justify-center rounded-full"
              onClick={(e) => {
                e.stopPropagation()
                preview.toggle(item)
              }}
            >
              {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
            </button>
            <MiniWave peaks={item.peaks} active={selected} progress={playing ? preview.progress : undefined} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {item.starred && <Star className="size-3.5 fill-amber text-amber" />}
                <span className="truncate font-medium">{item.name}</span>
                {item.folder && <span className="truncate text-xs text-muted-foreground">{item.folder}</span>}
              </div>
              <p className="truncate text-xs text-muted-foreground">{item.prompt ?? (item.origin === 'import' ? 'imported file' : '')}</p>
            </div>
            <div className="flex max-w-[220px] flex-wrap justify-end gap-1">
              {item.tags.slice(0, 3).map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmtTime(item.stats?.duration ?? 0, true)}</span>
            <span className="truncate text-right text-xs text-muted-foreground">{item.model ?? item.ext.toUpperCase()}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={actions.open}>
            <Wand2 className="size-4" /> Open in editor
          </ContextMenuItem>
          <ContextMenuItem onClick={actions.clone}>
            <Copy className="size-4" /> Clone (close variations)
          </ContextMenuItem>
          <ContextMenuItem onClick={actions.modify}>
            <Wand2 className="size-4" /> Modify…
          </ContextMenuItem>
          <ContextMenuSeparator />
          {item.kind === 'history' && (
            <ContextMenuItem onClick={() => setKeepOpen(true)}>
              <FolderInput className="size-4" /> Keep to library…
            </ContextMenuItem>
          )}
          {item.kind === 'library' && (
            <ContextMenuItem onClick={() => setKeepOpen(true)}>
              <FolderInput className="size-4" /> Rename / move…
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={actions.toggleStar}>
            <Star className="size-4" /> {item.starred ? 'Unstar' : 'Star'}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setExportOpen(true)}>
            <Download className="size-4" /> Export{selectedItems.length > 1 ? ` ${selectedItems.length} sounds` : ''}…
          </ContextMenuItem>
          <ContextMenuItem onClick={() => window.api.files.reveal(item.path)}>
            <ExternalLink className="size-4" /> Reveal in Explorer
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className="text-destructive" onClick={actions.remove}>
            <Trash2 className="size-4" /> {item.kind === 'library' ? 'Delete (Recycle Bin)' : 'Delete take'}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <KeepDialog item={item} open={keepOpen} onOpenChange={setKeepOpen} />
      <ExportDialog items={selectedItems} open={exportOpen} onOpenChange={setExportOpen} />
    </>
  )
}

function useItemActions(item: SfxItem) {
  const go = useNav((s) => s.go)
  return {
    open: () => {
      useStudio.getState().loadClip(item, { record: true })
      go('generate')
    },
    clone: () => {
      useStudio.getState().clone(item, 'close')
      go('generate')
    },
    modify: () => {
      const s = useStudio.getState()
      s.loadClip(item, { record: true, asSource: true })
      s.setMode('audio2audio')
      if (item.prompt) s.setParams({ prompt: item.prompt })
      go('generate')
    },
    toggleStar: () => void engineApi.patchItem(item.id, { starred: !item.starred }),
    remove: async () => {
      await engineApi.deleteItem(item.id)
      toast.success(item.kind === 'library' ? 'Moved to the Recycle Bin' : 'Take deleted')
    }
  }
}

function DetailPanel({ item }: { item: SfxItem }) {
  const actions = useItemActions(item)
  const [tags, setTags] = useState(item.tags.join(', '))
  const [exportOpen, setExportOpen] = useState(false)
  useEffect(() => setTags(item.tags.join(', ')), [item])
  const s = item.stats
  const p = item.params as Record<string, unknown> | null
  const row = (k: string, v: React.ReactNode): React.ReactNode => (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className="truncate text-right font-mono">{v}</span>
    </div>
  )
  return (
    <div className="panel flex w-[320px] shrink-0 flex-col gap-4 p-4">
      <div>
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 break-words text-lg font-semibold">{item.name}</h3>
          <button onClick={actions.toggleStar} title="Star">
            <Star className={cn('size-5', item.starred ? 'fill-amber text-amber' : 'text-muted-foreground')} />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{item.kind === 'history' ? 'History take' : item.folder || 'Library root'}</p>
      </div>
      <MiniWave peaks={item.peaks} active className="h-16" />
      {item.prompt && <p className="rounded-md border border-border bg-panel p-2 text-sm leading-relaxed">{item.prompt}</p>}
      <div className="flex flex-col gap-1.5">
        {s && row('Duration', `${s.duration.toFixed(3)} s`)}
        {s && row('Format', `${s.sample_rate / 1000} kHz · ${s.channels === 1 ? 'mono' : 'stereo'} · ${item.ext}`)}
        {s && row('Peak / RMS', `${s.peak_db} / ${s.rms_db} dB`)}
        {s?.lufs != null && row('Loudness', `${s.lufs} LUFS`)}
        {s && row('Silence head/tail', `${s.head_silence}s / ${s.tail_silence}s`)}
        {item.model && row('Model', item.model)}
        {item.mode && row('Mode', item.mode)}
        {item.seed != null && row('Seed', item.seed)}
        {p && row('Steps / CFG', `${p.steps ?? '–'} / ${p.cfg_scale ?? '–'}`)}
        {item.ops.length > 0 && row('Edits', item.ops.map((o) => String(o.op)).join(' → '))}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="label-caps">Tags</span>
        <Input
          className="h-8 bg-panel text-xs"
          value={tags}
          placeholder="comma separated"
          onChange={(e) => setTags(e.target.value)}
          onBlur={() => {
            const list = tags.split(',').map((t) => t.trim()).filter(Boolean)
            if (list.join(',') !== item.tags.join(',')) void engineApi.patchItem(item.id, { tags: list })
          }}
        />
      </div>
      <div className="mt-auto grid grid-cols-2 gap-2">
        <Button onClick={actions.open}>
          <Wand2 className="size-4" /> Edit
        </Button>
        <Button variant="secondary" onClick={actions.clone}>
          <Copy className="size-4" /> Clone
        </Button>
        <Button variant="secondary" onClick={() => setExportOpen(true)}>
          <Download className="size-4" /> Export
        </Button>
        <Button variant="secondary" onClick={() => window.api.files.reveal(item.path)}>
          <ExternalLink className="size-4" /> Reveal
        </Button>
        <div
          draggable
          onDragStart={(e) => {
            e.preventDefault()
            window.api.files.startDrag(item.path)
          }}
          className="col-span-2 flex h-10 cursor-grab items-center justify-center gap-2 rounded-md border border-dashed border-[#6b5f57] text-sm text-[#d2c0b0] hover:border-primary/60 hover:text-foreground"
          title="Drag into Unity, Explorer or your DAW"
        >
          Drag to DAW / Unity
        </div>
      </div>
      <ExportDialog items={[item]} open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  )
}
