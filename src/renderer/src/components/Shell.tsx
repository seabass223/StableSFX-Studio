import { AlertTriangle, FolderOpen, ListMusic, RotateCcw, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { LogoMark, SparkIcon } from './Logo'
import { useEngine } from '@/store/engine'
import { useNav, type View } from '@/store/nav'
import { useStudio } from '@/store/studio'
import { cn } from '@/lib/utils'

const NAV: { id: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'generate', label: 'Generate', icon: SparkIcon },
  { id: 'library', label: 'Library', icon: FolderOpen },
  { id: 'presets', label: 'Presets', icon: ListMusic }
]

export function Sidebar() {
  const view = useNav((s) => s.view)
  const go = useNav((s) => s.go)
  const item = (n: (typeof NAV)[number]): React.ReactNode => (
    <button
      key={n.id}
      onClick={() => go(n.id)}
      className={cn(
        'flex h-12 w-full items-center gap-3 rounded-md px-4 text-[15px] transition-colors',
        view === n.id ? 'nav-on font-medium' : 'text-foreground/85 hover:bg-white/5 [&_svg]:text-[#ffc9a3]'
      )}
    >
      <n.icon className="size-5" />
      {n.label}
    </button>
  )
  return (
    <nav className="panel flex w-[176px] shrink-0 flex-col gap-2 p-3">
      {NAV.map(item)}
      <div className="my-3 h-px bg-border" />
      {item({ id: 'settings', label: 'Settings', icon: Settings })}
    </nav>
  )
}

export function StatusBar() {
  const config = useEngine((s) => s.config)
  const status = useEngine((s) => s.status)
  const jobId = useStudio((s) => s.jobId)
  const job = useEngine((s) => (jobId ? s.jobs[jobId] : undefined))
  const lastGen = useStudio((s) => s.lastGenTime)
  const go = useNav((s) => s.go)
  const out = config?.output
  const busy = Boolean(job) || status?.busy
  const stateText = job
    ? `${job.state === 'loading' ? 'Loading model' : job.state[0].toUpperCase() + job.state.slice(1)}${job.variations > 1 ? ` take ${job.variation + 1}/${job.variations}` : ''}${job.steps ? ` · step ${job.step}/${job.steps}` : ''}`
    : status?.busy
      ? 'Busy (another client)'
      : 'Ready'
  return (
    <footer className="flex h-9 shrink-0 items-center gap-6 border-t border-black/70 bg-gradient-to-b from-[#2a2320] to-[#382c26] px-6 text-[13px]">
      <button className="flex items-center gap-4 text-muted-foreground hover:text-foreground" onClick={() => go('settings')} title="Default export format">
        <span>Output:</span>
        <span className="text-foreground">{out ? `${out.sample_rate / 1000} kHz` : '…'}</span>
        <span className="text-primary">{out?.channels === 1 ? 'Mono' : 'Stereo'}</span>
        <span className="text-primary">{out ? (out.format === 'mp3' ? `MP3 ${out.mp3_bitrate}k` : `${out.format.toUpperCase()} ${out.bit_depth === 32 ? '32f' : out.bit_depth}-bit`) : ''}</span>
      </button>
      <div className="flex-1" />
      {job && (
        <div className="h-1.5 w-40 overflow-hidden rounded bg-border">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      )}
      <span className="flex items-center gap-2">
        <span className={cn('size-2 rounded-full', busy ? 'animate-pulse bg-warning' : 'bg-success')} />
        {stateText}
      </span>
      <span className="h-4 w-px bg-border" />
      <span className="text-muted-foreground">
        Last generation: <span className="text-foreground">{lastGen != null ? `${lastGen.toFixed(2)}s` : '–'}</span>
      </span>
    </footer>
  )
}

/** First-run Python environment setup and engine start. */
export function SetupScreen() {
  const phase = useEngine((s) => s.phase)
  const log = useEngine((s) => s.setupLog)
  const error = useEngine((s) => s.error)
  const init = useEngine((s) => s.init)
  const title =
    phase === 'setup' ? 'Setting up the audio engine' : phase === 'connecting' ? 'Starting the engine' : phase === 'error' ? 'Engine problem' : 'Checking…'
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="panel flex w-[860px] max-w-full flex-col gap-5 p-8">
        <div className="flex items-center gap-4">
          <LogoMark className="h-12 w-16" />
          <div>
            <h1 className="wordmark text-xl">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {phase === 'setup'
                ? 'One-time install of Python 3.12, CUDA PyTorch and Stable Audio 3 into ~/.stablesfx (about 3 GB).'
                : phase === 'connecting'
                  ? 'Launching the shared engine (also used by the Claude MCP server).'
                  : phase === 'error'
                    ? 'See the details below.'
                    : ''}
            </p>
          </div>
        </div>
        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
          </div>
        )}
        {log.length > 0 && (
          <ScrollArea className="panel-inset h-[320px] p-3">
            <pre className="font-mono text-[11px] leading-relaxed text-foreground/80">{log.slice(-300).join('\n')}</pre>
          </ScrollArea>
        )}
        {phase === 'error' && (
          <div className="flex gap-2">
            <Button onClick={() => void init()}>
              <RotateCcw className="size-4" /> Retry
            </Button>
            <Button variant="secondary" onClick={() => void useEngine.getState().runSetup()}>
              Re-run environment setup
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
