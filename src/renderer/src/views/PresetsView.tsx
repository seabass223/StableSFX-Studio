import { useMemo, useState } from 'react'
import { Copy, Layers, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ModelId, Preset } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { usePresets } from '@/components/TitleBar'
import { engineApi } from '@/lib/api'
import { useEngine } from '@/store/engine'
import { useNav } from '@/store/nav'
import { useStudio } from '@/store/studio'
import { cn } from '@/lib/utils'

export function PresetsView() {
  const presets = usePresets()
  const [category, setCategory] = useState<string>('All')
  const [editing, setEditing] = useState<Preset | null>(null)
  const go = useNav((s) => s.go)
  const categories = useMemo(() => ['All', ...new Set(presets.map((p) => p.category))], [presets])
  const shown = presets.filter((p) => category === 'All' || p.category === category)

  const use = (p: Preset, generate: boolean): void => {
    const s = useStudio.getState()
    s.applyPreset(p)
    s.setMode('text')
    go('generate')
    if (generate) void s.generate(p.variations)
  }

  const saveCurrent = (): void => {
    const s = useStudio.getState()
    setEditing({
      id: '',
      name: s.params.prompt.split(/[,.]/)[0].slice(0, 40) || 'My preset',
      category: 'Custom',
      builtin: false,
      description: '',
      mode: 'text',
      params: { ...s.params, seed: -1 },
      variations: s.variations
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="panel flex items-center gap-2 p-3">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={cn('h-8 rounded-full border px-3 text-sm', category === c ? 'border-primary bg-primary/15 text-primary' : 'border-border hover:bg-accent')}
          >
            {c}
          </button>
        ))}
        <div className="flex-1" />
        <Button onClick={saveCurrent}>
          <Plus className="size-4" /> Save current settings as preset
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3 pb-3 pr-2">
          {shown.map((p) => (
            <div key={p.id} className="panel flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="label-caps">{p.category}</p>
                  <h3 className="mt-1 text-[17px] font-semibold">{p.name}</h3>
                </div>
                <div className="flex gap-1 text-muted-foreground">
                  <button title="Duplicate & edit" className="hover:text-foreground" onClick={() => setEditing({ ...p, id: '', builtin: false, name: `${p.name} copy`, category: p.builtin ? 'Custom' : p.category })}>
                    <Copy className="size-4" />
                  </button>
                  {!p.builtin && (
                    <>
                      <button title="Edit" className="hover:text-foreground" onClick={() => setEditing(p)}>
                        <Pencil className="size-4" />
                      </button>
                      <button
                        title="Delete"
                        className="hover:text-destructive"
                        onClick={async () => {
                          await engineApi.deletePreset(p.id)
                          toast.success('Preset deleted')
                        }}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <p className="line-clamp-3 min-h-[60px] text-sm text-muted-foreground">{p.params.prompt}</p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{p.params.duration}s</span>
                <span>·</span>
                <span>{p.params.model}</span>
                <span>·</span>
                <span>{p.variations} takes</span>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => use(p, false)}>
                  <Sparkles className="size-4" /> Load
                </Button>
                <Button className="flex-1" onClick={() => use(p, true)}>
                  <Layers className="size-4" /> Generate {p.variations}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      {editing && <PresetDialog preset={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function PresetDialog({ preset, onClose }: { preset: Preset; onClose(): void }) {
  const models = useEngine((s) => s.models)
  const [p, setP] = useState<Preset>(preset)
  const set = (patch: Partial<Preset['params']>): void => setP({ ...p, params: { ...p.params, ...patch } })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{preset.id ? 'Edit preset' : 'New preset'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label>Category</Label>
            <Input value={p.category} onChange={(e) => setP({ ...p, category: e.target.value })} />
          </div>
          <div className="col-span-2 grid gap-2">
            <Label>Prompt</Label>
            <Textarea rows={3} value={p.params.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label>Model</Label>
            <Select value={p.params.model} onValueChange={(v) => set({ model: v as ModelId })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-2">
              <Label>Duration (s)</Label>
              <Input type="number" step={0.1} min={0.1} value={p.params.duration} onChange={(e) => set({ duration: Number(e.target.value) })} />
            </div>
            <div className="grid gap-2">
              <Label>Takes</Label>
              <Input type="number" min={1} max={16} value={p.variations} onChange={(e) => setP({ ...p, variations: Number(e.target.value) })} />
            </div>
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">All other parameters (guidance, steps, sampler, schedule, LoRAs…) are stored as they were when the preset was created.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              await engineApi.savePreset(p)
              toast.success('Preset saved')
              onClose()
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
