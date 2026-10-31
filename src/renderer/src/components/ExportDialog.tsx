import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import type { AudioFormat, ExportRequest, SfxItem } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { engineApi } from '@/lib/api'
import { useEngine } from '@/store/engine'

const LAST_DIR_KEY = 'stablesfx.exportDir'

type ExportOpts = Pick<ExportRequest, 'format' | 'sample_rate' | 'bit_depth' | 'channels' | 'mp3_bitrate'> &
  Partial<Pick<ExportRequest, 'normalize' | 'name_template'>>

function lastDir(): string | undefined {
  try {
    return localStorage.getItem(LAST_DIR_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Ask for a destination folder (remembered) and export. */
export async function exportItems(items: SfxItem[], opts: ExportOpts, destDir?: string): Promise<void> {
  const dest = destDir ?? (await window.api.files.chooseFolder(lastDir()))
  if (!dest) return
  try {
    localStorage.setItem(LAST_DIR_KEY, dest)
  } catch {
    /* ignore */
  }
  try {
    const res = await engineApi.exportFiles({
      sources: items.map((i) => i.id),
      dest_dir: dest,
      name_template: '{name}',
      overwrite: false,
      normalize: null,
      ...opts
    })
    for (const w of res.warnings) toast.warning(w)
    toast.success(`Exported ${res.files.length} file${res.files.length === 1 ? '' : 's'}`, {
      description: dest,
      action: { label: 'Reveal', onClick: () => window.api.files.reveal(res.files[0]) }
    })
  } catch (err) {
    toast.error((err as Error).message)
  }
}

export function ExportDialog({ items, open, onOpenChange }: { items: SfxItem[]; open: boolean; onOpenChange(v: boolean): void }) {
  const cfg = useEngine((s) => s.config)
  const [format, setFormat] = useState<AudioFormat>('wav')
  const [rate, setRate] = useState('44100')
  const [bits, setBits] = useState('24')
  const [channels, setChannels] = useState('2')
  const [bitrate, setBitrate] = useState('320')
  const [normalize, setNormalize] = useState('none')
  const [template, setTemplate] = useState('{name}')
  const [dest, setDest] = useState(lastDir() ?? '')

  useEffect(() => {
    if (open && cfg) {
      setFormat(cfg.output.format)
      setRate(String(cfg.output.sample_rate))
      setBits(String(cfg.output.bit_depth))
      setChannels(String(cfg.output.channels))
      setBitrate(String(cfg.output.mp3_bitrate))
      setDest(lastDir() ?? '')
    }
  }, [open, cfg])

  const go = async (): Promise<void> => {
    const n = normalize === 'none' ? null : normalize.startsWith('lufs') ? { op: 'normalize' as const, mode: 'lufs' as const, target: Number(normalize.split(':')[1]) } : { op: 'normalize' as const, mode: 'peak' as const, target: Number(normalize.split(':')[1]) }
    await exportItems(
      items,
      {
        format,
        sample_rate: rate === 'keep' ? null : Number(rate),
        bit_depth: Number(bits) as 16 | 24 | 32,
        channels: channels === 'keep' ? null : (Number(channels) as 1 | 2),
        mp3_bitrate: Number(bitrate),
        normalize: n,
        name_template: template
      },
      dest || undefined
    )
    onOpenChange(false)
  }

  const sel = (label: string, value: string, set: (v: string) => void, options: [string, string][], disabled?: boolean): React.ReactNode => (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={set} disabled={disabled}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Export {items.length > 1 ? `${items.length} sounds` : items[0]?.name}</DialogTitle>
          <DialogDescription>Library masters stay untouched; conversion and normalization apply to the exported copies.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          {sel('Format', format, (v) => setFormat(v as AudioFormat), [['wav', 'WAV'], ['flac', 'FLAC'], ['mp3', 'MP3']])}
          {sel('Sample rate', rate, setRate, [['keep', 'Keep (44.1 kHz)'], ['22050', '22.05 kHz'], ['32000', '32 kHz'], ['44100', '44.1 kHz'], ['48000', '48 kHz']])}
          {format === 'mp3'
            ? sel('MP3 bitrate', bitrate, setBitrate, [['128', '128 kbps'], ['192', '192 kbps'], ['256', '256 kbps'], ['320', '320 kbps']])
            : sel('Bit depth', bits, setBits, format === 'flac' ? [['16', '16-bit'], ['24', '24-bit']] : [['16', '16-bit'], ['24', '24-bit'], ['32', '32-bit float']])}
          {sel('Channels', channels, setChannels, [['keep', 'Keep'], ['1', 'Mono (3D/positional)'], ['2', 'Stereo']])}
          {sel('Normalize', normalize, setNormalize, [['none', 'Off'], ['peak:-1', 'Peak −1 dBFS'], ['peak:-3', 'Peak −3 dBFS'], ['lufs:-14', '−14 LUFS'], ['lufs:-16', '−16 LUFS'], ['lufs:-20', '−20 LUFS'], ['lufs:-23', '−23 LUFS']])}
          <div className="grid gap-2">
            <Label title="Tokens: {name} {index} {seed} {folder}">File name</Label>
            <Input value={template} onChange={(e) => setTemplate(e.target.value)} />
          </div>
          <div className="col-span-2 grid gap-2">
            <Label>Destination</Label>
            <div className="flex gap-2">
              <Input value={dest} placeholder="Choose a folder (e.g. your game's Assets/Audio/SFX)" onChange={(e) => setDest(e.target.value)} />
              <Button variant="secondary" onClick={async () => setDest((await window.api.files.chooseFolder(dest || undefined)) ?? dest)}>
                <FolderOpen className="size-4" />
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={go}>Export</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
