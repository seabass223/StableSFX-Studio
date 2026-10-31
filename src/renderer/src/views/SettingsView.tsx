import { useEffect, useState } from 'react'
import { Check, Copy, Cpu, Download, ExternalLink, FolderOpen, HardDrive, Plug, Power, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { EngineConfig, McpStatus } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { engineApi, fmtBytes } from '@/lib/api'
import { useEngine } from '@/store/engine'
import { cn } from '@/lib/utils'

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel flex flex-col gap-4 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-[0.14em] text-primary uppercase">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-4">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

export function SettingsView() {
  const status = useEngine((s) => s.status)
  const config = useEngine((s) => s.config)
  const models = useEngine((s) => s.models)
  const progress = useEngine((s) => s.modelProgress)
  const logLines = useEngine((s) => s.logLines)
  const patch = useEngine((s) => s.patchConfig)
  const [mcp, setMcp] = useState<McpStatus | null>(null)
  const [setup, setSetup] = useState<{ home: string; envDir: string } | null>(null)

  useEffect(() => {
    window.api.mcp.status().then(setMcp).catch(() => undefined)
    window.api.setup.state().then(setSetup).catch(() => undefined)
    void useEngine.getState().refresh()
  }, [])

  if (!config) return null
  const p = (k: keyof EngineConfig) => (v: unknown) => void patch({ [k]: v } as Partial<EngineConfig>).catch((e: Error) => toast.error(e.message))
  const out = config.output
  const setOut = (o: Partial<EngineConfig['output']>): void => void patch({ output: { ...out, ...o } })
  const mcpJson = mcp ? JSON.stringify({ mcpServers: { stablesfx: { type: 'stdio', command: mcp.command, args: mcp.args, env: mcp.env } } }, null, 2) : ''

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="grid grid-cols-2 gap-3 pb-3 pr-2">
        <Section title="Library" icon={<FolderOpen className="size-4" />}>
          <Row label="Library folder" hint="Folders + .sfx.json sidecars; safe to browse in Explorer">
            <Input readOnly value={config.library_path} className="bg-panel" />
            <Button
              variant="secondary"
              onClick={async () => {
                const dir = await window.api.files.chooseFolder(config.library_path)
                if (dir) await p('library_path')(dir)
              }}
            >
              Change…
            </Button>
            <Button variant="ghost" size="icon" onClick={() => window.api.files.openPath(config.library_path)} title="Open">
              <ExternalLink className="size-4" />
            </Button>
          </Row>
          <Row label="History retention" hint="Unkept takes are pruned after this">
            <Input type="number" className="w-24 bg-panel" value={config.history_retention_days} onChange={(e) => p('history_retention_days')(Number(e.target.value))} />
            <span className="text-sm text-muted-foreground">days, max</span>
            <Input type="number" step={0.5} className="w-24 bg-panel" value={config.history_max_gb} onChange={(e) => p('history_max_gb')(Number(e.target.value))} />
            <span className="text-sm text-muted-foreground">GB</span>
            <Button variant="ghost" onClick={async () => toast.success(`Pruned ${(await engineApi.pruneHistory()).removed} takes`)}>
              Prune now
            </Button>
          </Row>
        </Section>

        <Section title="Default export format" icon={<HardDrive className="size-4" />}>
          <Row label="Format">
            <Select value={out.format} onValueChange={(v) => setOut({ format: v as EngineConfig['output']['format'] })}>
              <SelectTrigger className="w-40 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="wav">WAV</SelectItem>
                <SelectItem value="flac">FLAC</SelectItem>
                <SelectItem value="mp3">MP3</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Sample rate">
            <Select value={String(out.sample_rate)} onValueChange={(v) => setOut({ sample_rate: Number(v) })}>
              <SelectTrigger className="w-40 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[22050, 32000, 44100, 48000].map((r) => (
                  <SelectItem key={r} value={String(r)}>{r / 1000} kHz</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label="Bit depth / channels">
            <Select value={String(out.bit_depth)} onValueChange={(v) => setOut({ bit_depth: Number(v) as 16 | 24 | 32 })}>
              <SelectTrigger className="w-40 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="16">16-bit</SelectItem>
                <SelectItem value="24">24-bit</SelectItem>
                <SelectItem value="32">32-bit float (WAV)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={String(out.channels)} onValueChange={(v) => setOut({ channels: Number(v) as 1 | 2 })}>
              <SelectTrigger className="w-40 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="2">Stereo</SelectItem>
                <SelectItem value="1">Mono</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="MP3 bitrate">
            <Select value={String(out.mp3_bitrate)} onValueChange={(v) => setOut({ mp3_bitrate: Number(v) })}>
              <SelectTrigger className="w-40 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[128, 192, 256, 320].map((b) => (
                  <SelectItem key={b} value={String(b)}>{b} kbps</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </Section>

        <Section title="Engine" icon={<Cpu className="size-4" />}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <span className="text-muted-foreground">Device</span>
            <span>{status?.device_name ?? '…'} {status?.vram_total_gb ? `(${status.vram_used_gb ?? '?'} / ${status.vram_total_gb} GB used)` : ''}</span>
            <span className="text-muted-foreground">PyTorch / CUDA</span>
            <span>{status?.torch ?? '–'} / {status?.cuda ?? '–'}</span>
            <span className="text-muted-foreground">Flash attention</span>
            <span>{status?.flash_attn ? 'installed' : 'not installed (SDPA fallback)'}</span>
            <span className="text-muted-foreground">Loaded model</span>
            <span>{status?.loaded_model ?? 'none'}</span>
            <span className="text-muted-foreground">Engine PID / clients</span>
            <span>{status?.pid} / {status?.clients} {status?.fake && <Badge variant="destructive">FAKE BACKEND</Badge>}</span>
            <span className="text-muted-foreground">Runtime folder</span>
            <span className="truncate" title={setup?.envDir}>{setup?.home}</span>
          </div>
          <Row label="Device" hint="Changing reloads the model">
            <Select value={config.device} onValueChange={p('device')}>
              <SelectTrigger className="w-40 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (GPU if available)</SelectItem>
                <SelectItem value="cuda">CUDA GPU</SelectItem>
                <SelectItem value="cpu">CPU</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Precision" hint="Auto: fp32 for the small models, bf16 for Medium. fp16 can overflow to NaN.">
            <Select value={config.precision} onValueChange={p('precision')}>
              <SelectTrigger className="w-40 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="fp32">fp32</SelectItem>
                <SelectItem value="bf16">bf16</SelectItem>
                <SelectItem value="fp16">fp16</SelectItem>
              </SelectContent>
            </Select>
            {status?.loaded_precision && <span className="text-xs text-muted-foreground">loaded: {status.loaded_model} @ {status.loaded_precision}</span>}
          </Row>
          <Row label="Idle timers" hint="Free VRAM / stop the engine when unused">
            <Input type="number" className="w-20 bg-panel" value={config.model_idle_unload_minutes} onChange={(e) => p('model_idle_unload_minutes')(Number(e.target.value))} />
            <span className="text-sm text-muted-foreground">min to unload,</span>
            <Input type="number" className="w-20 bg-panel" value={config.engine_idle_exit_minutes} onChange={(e) => p('engine_idle_exit_minutes')(Number(e.target.value))} />
            <span className="text-sm text-muted-foreground">min to exit</span>
          </Row>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => engineApi.unloadModel()}>Unload model</Button>
            <Button
              variant="secondary"
              onClick={async () => {
                await window.api.engine.stop()
                await useEngine.getState().init()
              }}
            >
              <RotateCcw className="size-4" /> Restart engine
            </Button>
            <Button variant="secondary" onClick={() => setup && window.api.files.openPath(`${setup.home}\\logs`)}>Open logs</Button>
            <Button variant="ghost" onClick={() => void useEngine.getState().runSetup()}>Re-run environment setup</Button>
          </div>
          {logLines.length > 0 && (
            <ScrollArea className="panel-inset h-32 p-2">
              <pre className="font-mono text-[10px] leading-relaxed text-foreground/70">{logLines.slice(-80).join('\n')}</pre>
            </ScrollArea>
          )}
        </Section>

        <Section title="Models" icon={<Download className="size-4" />}>
          <div className="flex flex-col gap-2">
            {models.map((m) => {
              const pr = progress[m.id]
              const downloading = pr?.state === 'downloading'
              return (
                <div key={m.id} className="flex items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{m.label}</span>
                      <Badge variant="secondary" className="text-[10px]">{m.kind}</Badge>
                      {m.loaded && <Badge className="text-[10px]">loaded</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.defaults.steps} steps · cfg {m.defaults.cfg_scale} · {m.defaults.sampler} · ≤{Math.round(m.defaults.max_duration)}s
                      {m.downloaded ? ` · ${fmtBytes(m.size_bytes)}` : ''}
                    </div>
                    {downloading && pr.total ? (
                      <div className="mt-1 h-1.5 overflow-hidden rounded bg-border">
                        <div className="h-full bg-primary" style={{ width: `${Math.round(((pr.done ?? 0) / pr.total) * 100)}%` }} />
                      </div>
                    ) : null}
                    {(pr?.error || m.note) && <div className={cn('mt-1 text-xs', pr?.error ? 'text-destructive' : 'text-warning')}>{pr?.error ?? m.note}</div>}
                  </div>
                  {m.downloaded ? (
                    <>
                      <Check className="size-4 text-success" />
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete from the Hugging Face cache"
                        onClick={async () => {
                          if (!window.confirm(`Delete ${m.label} weights from the HF cache?`)) return
                          const r = await engineApi.deleteModelCache(m.id)
                          toast.success(`Freed ${fmtBytes(r.freed)}`)
                          void useEngine.getState().refreshModels()
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={downloading} onClick={() => engineApi.downloadModel(m.id)}>
                      {downloading ? `${pr.total ? Math.round(((pr.done ?? 0) / pr.total) * 100) : 0}%` : 'Download'}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" title="Model page / license" onClick={() => window.api.shell.openExternal(m.license_url)}>
                    <ExternalLink className="size-4" />
                  </Button>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">Weights live in the shared Hugging Face cache. Gated models need “Accept license” on their model page once.</p>
        </Section>

        <Section title="Claude (MCP server)" icon={<Plug className="size-4" />}>
          <p className="text-sm text-muted-foreground">
            Lets Claude Code generate, modify, organise and export sounds with this engine (tools like <code>generate_sfx</code>, <code>modify_sfx</code>, <code>export_sfx</code>). It shares the running engine with this app.
          </p>
          <Row label="Status">
            {mcp?.registered ? (
              mcp.matches ? <Badge className="bg-success/20 text-success">registered for all projects</Badge> : <Badge variant="destructive">registered, but points elsewhere</Badge>
            ) : (
              <Badge variant="secondary">not registered</Badge>
            )}
            <Button
              onClick={async () => {
                try {
                  setMcp(await window.api.mcp.register())
                  toast.success('Registered in ~/.claude.json', { description: 'Restart Claude Code sessions to pick it up.' })
                } catch (err) {
                  toast.error((err as Error).message)
                }
              }}
            >
              <Power className="size-4" /> {mcp?.registered ? 'Re-register' : 'Register with Claude Code'}
            </Button>
          </Row>
          <div className="relative">
            <pre className="panel-inset overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">{mcpJson}</pre>
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={() => {
                void navigator.clipboard.writeText(mcpJson)
                toast.success('Copied')
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </Section>
      </div>
    </ScrollArea>
  )
}
