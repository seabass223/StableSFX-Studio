import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region as WsRegion } from 'wavesurfer.js/dist/plugins/regions.esm.js'
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.esm.js'
import { Pause, Play, Repeat, Scissors, Sparkles, Square, Upload, Volume2, VolumeX, X } from 'lucide-react'
import { toast } from 'sonner'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { LevelMeter, type MeterSource } from './LevelMeter'
import { TimeRuler } from './TimeRuler'
import { audioUrl, engineApi, fmtTime } from '@/lib/api'
import { COLUMN_WIDTH, columnsFromAudio, paintWave } from '@/lib/wave'
import { useStudio, type Region } from '@/store/studio'
import { cn } from '@/lib/utils'

const REGION_COLOR = 'rgba(255, 170, 130, 0.11)'
const LATENT_HOP = 4096 / 44100

export function Waveform() {
  const clip = useStudio((s) => s.clip)
  const mode = useStudio((s) => s.mode)
  const regions = useStudio((s) => s.regions)
  const containerRef = useRef<HTMLDivElement>(null)
  const dullRef = useRef<HTMLCanvasElement>(null)
  const brightRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const mediaRef = useRef<HTMLAudioElement | null>(null)
  const [meter, setMeter] = useState<MeterSource | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loop, setLoop] = useState(false)
  const [volume, setVolume] = useState(0.85)
  const [muted, setMuted] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const loopRef = useRef(loop)
  loopRef.current = loop
  const modeRef = useRef(mode)
  modeRef.current = mode

  // Create wavesurfer once.
  useEffect(() => {
    const media = new Audio()
    media.crossOrigin = 'anonymous'
    media.preload = 'auto'
    mediaRef.current = media
    const regionsPlugin = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: containerRef.current!,
      media,
      height: 'auto',
      // The wave is painted on our two canvases; wavesurfer keeps timing, cursor, regions and input.
      renderFunction: () => undefined,
      cursorColor: '#fffde2',
      cursorWidth: 3,
      // No dragToSeek: its pointer handler preventDefaults every move, which starves the
      // Regions plugin's drag-to-select. Click still seeks.
      interact: true,
      plugins: [
        regionsPlugin,
        HoverPlugin.create({ lineColor: '#ffb066', lineWidth: 1, labelBackground: '#1c1510', labelColor: '#ffd2a8', labelSize: '11px' })
      ]
    })
    wsRef.current = ws
    regionsRef.current = regionsPlugin

    const sync = (): void => {
      const list = regionsPlugin.getRegions()
      useStudio.getState().set({ regions: list.map((r) => [round(r.start), round(r.end)] as Region) })
    }

    // The bright copy of the wave shows through the selection, or up to the playhead without one.
    let dragging: WsRegion | null = null
    const highlight = (): void => {
      const canvas = brightRef.current
      const d = ws.getDuration()
      if (!canvas || !d) return
      const live = regionsPlugin.getRegions().map((r) => [r.start / d, r.end / d])
      if (dragging) live.push([dragging.start / d, dragging.end / d])
      canvas.style.clipPath = spansClip(live.length ? live : [[0, ws.getCurrentTime() / d]])
    }
    const paint = (): void => {
      const dull = dullRef.current
      const bright = brightRef.current
      const audio = ws.getDecodedData()
      if (!dull || !bright || !audio) return
      const channels = [audio.getChannelData(0)]
      if (audio.numberOfChannels > 1) channels.push(audio.getChannelData(1))
      // ws.empty() leaves a silent stub behind: nothing to draw.
      const columns = audio.duration > 0.01 ? Math.max(1, Math.round(dull.clientWidth / COLUMN_WIDTH)) : 0
      const cols = columnsFromAudio(channels, columns)
      paintWave(dull, cols, 'dull')
      paintWave(bright, cols, 'bright')
      highlight()
    }
    ws.on('redrawcomplete', paint)

    regionsPlugin.enableDragSelection({ color: REGION_COLOR }, 3)
    regionsPlugin.on('region-initialized', (r: WsRegion) => {
      dragging = r
      r.on('update', highlight)
      highlight()
    })
    regionsPlugin.on('region-created', (r: WsRegion) => {
      dragging = null
      // Only inpaint takes several regions; everywhere else a new selection replaces the old.
      if (modeRef.current !== 'inpaint') for (const other of regionsPlugin.getRegions()) if (other !== r) other.remove()
      sync()
      highlight()
    })
    regionsPlugin.on('region-updated', () => {
      sync()
      highlight()
    })
    regionsPlugin.on('region-removed', () => {
      sync()
      highlight()
    })
    regionsPlugin.on('region-double-clicked', (r: WsRegion) => r.remove())

    ws.on('play', () => setPlaying(true))
    ws.on('pause', () => setPlaying(false))
    ws.on('timeupdate', (t) => {
      setTime(t)
      highlight()
    })
    ws.on('ready', (d) => setDuration(d))
    ws.on('finish', () => {
      if (loopRef.current) void ws.play(0)
    })
    regionsPlugin.on('region-out', (r: WsRegion) => {
      if (loopRef.current && ws.isPlaying()) r.play()
    })
    setMeter({ media })

    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      }
      if (e.key === 'Delete' || e.key === 'Backspace') regionsPlugin.clearRegions()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      ws.destroy()
    }
  }, [])

  // Load the current clip.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    regionsRef.current?.clearRegions()
    setTime(0)
    if (!clip) {
      ws.empty()
      setDuration(0)
      return
    }
    ws.load(audioUrl(clip)).catch((err: Error) => {
      if (err.name !== 'AbortError') toast.error(`Could not load audio: ${err.message}`)
    })
  }, [clip])

  // Reflect store-driven region changes (e.g. cleared by undo) into wavesurfer.
  useEffect(() => {
    const plugin = regionsRef.current
    if (plugin && regions.length === 0 && plugin.getRegions().length) plugin.clearRegions()
  }, [regions])

  useEffect(() => {
    if (mediaRef.current) mediaRef.current.volume = muted ? 0 : volume
  }, [volume, muted])

  function togglePlay(): void {
    const ws = wsRef.current
    if (!ws || !ws.getDuration()) return
    const sel = regionsRef.current?.getRegions()[0]
    if (ws.isPlaying()) ws.pause()
    else if (sel && (ws.getCurrentTime() < sel.start || ws.getCurrentTime() >= sel.end)) sel.play()
    else void ws.play()
  }

  function stop(): void {
    wsRef.current?.stop()
  }

  async function onDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const path = window.api.files.pathFor(file)
    if (!/\.(wav|flac|mp3|ogg|aiff?)$/i.test(path)) {
      toast.error('Drop a WAV, FLAC, MP3 or OGG file')
      return
    }
    try {
      const item = await engineApi.resolve(path)
      const studio = useStudio.getState()
      studio.loadClip(item, { record: true, asSource: true })
      if (studio.mode === 'text') studio.setMode('audio2audio')
      toast.success(`Loaded ${item.name} as the source`, { description: 'It stays where it is until you keep or export it.' })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const snapHint = mode === 'inpaint' || mode === 'extend' || mode === 'loop'
  const selection = regions.length ? regions : null
  const jobRunning = useStudio((s) => Boolean(s.jobId))

  function regenerateSelection(): void {
    const s = useStudio.getState()
    if (!s.clip || !s.regions.length) return
    // Inpaint the selected region(s) of the clip in the editor, keeping everything else.
    useStudio.setState({ mode: 'inpaint', source: s.clip })
    void useStudio.getState().generate(1)
  }

  function trimToSelection(): void {
    const sel = useStudio.getState().regions[0]
    if (sel) void useStudio.getState().process([{ op: 'trim', start: sel[0], end: sel[1] }])
  }

  return (
    <div className="panel panel-dark flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex min-h-0 flex-1 gap-3">
        <div
          className={cn(
            'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md px-2 pt-1',
            dragOver && 'ring-2 ring-primary'
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <div className="wave-view relative mt-[26px] min-h-0 flex-1" data-empty={clip ? undefined : ''}>
            <canvas ref={dullRef} className="pointer-events-none absolute inset-0 size-full" />
            <canvas ref={brightRef} className="pointer-events-none absolute inset-0 size-full" />
            <div ref={containerRef} data-testid="waveform" className="absolute inset-0" />
            <TimeRuler duration={duration} />
          </div>
          {!clip && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Upload className="size-6 opacity-60" />
              <p className="text-sm">Generate a sound, or drop an audio file here to modify or clone it</p>
            </div>
          )}
          {clip && selection && (
            <div className="absolute left-3 top-[38px] z-10 flex items-center gap-1 rounded-md border border-primary/40 bg-[#140f0b]/90 px-2 py-1 text-xs shadow-lg backdrop-blur">
              <span className="px-1 font-mono tabular-nums text-foreground/90">
                {selection.length > 1 ? `${selection.length} regions` : `${selection[0][0].toFixed(2)}–${selection[0][1].toFixed(2)} s`}
              </span>
              <Button size="sm" className="h-7 gap-1 px-2" onClick={regenerateSelection} disabled={jobRunning} title="Regenerate the selection with the current prompt (inpaint), keeping the rest of the clip">
                <Sparkles className="size-3.5" /> Regenerate
              </Button>
              {selection.length === 1 && (
                <Button size="sm" variant="secondary" className="h-7 gap-1 px-2" onClick={trimToSelection} title="Keep only the selection">
                  <Scissors className="size-3.5" /> Trim
                </Button>
              )}
              <button className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => regionsRef.current?.clearRegions()} title="Clear selection (Delete)">
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {clip && snapHint && (
            <p className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-muted-foreground/70">
              {mode === 'inpaint' ? `Drag to select regions to regenerate (snapped to ${Math.round(LATENT_HOP * 1000)} ms) · drag edges to adjust · double-click a region to remove` : ''}
            </p>
          )}
        </div>
        <LevelMeter source={meter} />
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="icon" className="key-warm h-11 w-[85px]" onClick={togglePlay} disabled={!clip} title="Play / pause (Space)">
          {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current" />}
        </Button>
        <Button variant="secondary" size="icon" className="key-warm h-11 w-[68px]" onClick={stop} disabled={!clip} title="Stop">
          <Square className="size-5 fill-current" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className={cn('key-warm h-11 w-[68px]', loop && 'key-on')}
          onClick={() => setLoop(!loop)}
          title="Loop playback (loops the selection if there is one)"
        >
          <Repeat className="size-5" />
        </Button>
        <span className="ml-3 w-[176px] whitespace-nowrap font-mono text-sm tabular-nums text-foreground/90">
          {fmtTime(time, true)} <span className="text-muted-foreground">/ {fmtTime(duration, true)}</span>
        </span>
        <Slider
          className="mx-2 flex-1"
          min={0}
          max={Math.max(duration, 0.001)}
          step={0.001}
          value={[time]}
          onValueChange={([v]) => wsRef.current?.setTime(v)}
          disabled={!clip}
        />
        <button className="ml-2 text-muted-foreground hover:text-foreground" onClick={() => setMuted(!muted)} title="Mute">
          {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
        </button>
        <Slider className="w-32" min={0} max={1} step={0.01} value={[volume]} onValueChange={([v]) => setVolume(v)} />
      </div>
    </div>
  )
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Clip path showing only the given spans (0..1 of the width), joined along the top edge. */
function spansClip(spans: number[][]): string {
  const points = spans.flatMap(([a, b]) => {
    const l = `${a * 100}%`
    const r = `${b * 100}%`
    return [`${l} 0`, `${r} 0`, `${r} 100%`, `${l} 100%`, `${l} 0`]
  })
  return `polygon(${points.join(', ')})`
}
