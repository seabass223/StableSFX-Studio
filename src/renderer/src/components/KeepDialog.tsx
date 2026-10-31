import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { SfxItem } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { engineApi } from '@/lib/api'
import { flattenFolders, useLibraryTree } from '@/lib/hooks'
import { useStudio } from '@/store/studio'

const NEW = '__new__'
let lastFolder = 'Inbox'

/** Keep a History take in the library (or move a library item) with a name and tags. */
export function KeepDialog({ item, open, onOpenChange }: { item: SfxItem; open: boolean; onOpenChange(v: boolean): void }) {
  const tree = useLibraryTree()
  const folders = tree ? flattenFolders(tree) : []
  const [folder, setFolder] = useState(lastFolder)
  const [newFolder, setNewFolder] = useState('')
  const [name, setName] = useState('')
  const [tags, setTags] = useState('')

  useEffect(() => {
    if (open) {
      setName(item.name.replace(/_\d{3}$/, ''))
      setTags(item.tags.join(', '))
      setFolder(item.kind === 'library' ? item.folder || lastFolder : lastFolder)
    }
  }, [open, item])

  const submit = async (): Promise<void> => {
    const target = folder === NEW ? newFolder.trim() : folder
    if (!target) return
    lastFolder = target
    try {
      const kept = await engineApi.keep({
        id: item.id,
        folder: target,
        name: name.trim() || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean)
      })
      useStudio.setState((s) => ({
        clip: s.clip?.id === item.id ? kept : s.clip,
        takes: s.takes.map((t) => (t.id === item.id ? kept : t))
      }))
      toast.success(`Kept as ${kept.name}`, {
        description: kept.folder,
        action: { label: 'Reveal', onClick: () => window.api.files.reveal(kept.path) }
      })
      onOpenChange(false)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Keep in library</DialogTitle>
          <DialogDescription>Copies the take (with its prompt and parameters) into your SFX library.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Folder</Label>
            <Select value={folder} onValueChange={setFolder}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {folders.map((f) => (
                  <SelectItem key={f.path} value={f.path}>
                    <span style={{ paddingLeft: f.depth * 12 }}>{f.path.split('/').pop()}</span>
                  </SelectItem>
                ))}
                {!folders.some((f) => f.path === folder) && folder !== NEW && <SelectItem value={folder}>{folder}</SelectItem>}
                <SelectItem value={NEW}>+ New folder…</SelectItem>
              </SelectContent>
            </Select>
            {folder === NEW && <Input autoFocus placeholder="e.g. Weapons/Lasers" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />}
          </div>
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
          <div className="grid gap-2">
            <Label>Tags</Label>
            <Input placeholder="comma separated" value={tags} onChange={(e) => setTags(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Keep</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
