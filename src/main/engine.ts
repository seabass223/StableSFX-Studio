/**
 * Python engine lifecycle from the Electron side: environment setup (bundled uv),
 * discovery/spawn via `python -m stablesfx_engine ensure`, an authenticated HTTP
 * client, and the /events WebSocket forwarded to the renderer.
 *
 * Shared state lives in %USERPROFILE%\.stablesfx (see engine/stablesfx_engine/paths.py).
 */
import { app } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineInfo, SetupState } from '@shared/ipc'

export const HOME = process.env.STABLESFX_HOME || path.join(os.homedir(), '.stablesfx')
const ENV_ROOT = path.join(HOME, 'env')
const CURRENT_ENV = path.join(ENV_ROOT, 'current')
const ENGINE_COPY = path.join(HOME, 'engine')
const ENGINE_FILES = ['pyproject.toml', 'uv.lock', '.python-version']

function engineSourceDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(app.getAppPath(), 'engine')
}

function bundledUv(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'uv.exe')]
    : [path.join(app.getAppPath(), 'resources', 'uv.exe')]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

function sha(files: string[], base: string): string {
  const h = createHash('sha1')
  for (const f of files) {
    h.update(f)
    h.update(fs.readFileSync(path.join(base, f)))
  }
  return h.digest('hex').slice(0, 12)
}

function engineFiles(base: string): string[] {
  const pkg = path.join(base, 'stablesfx_engine')
  const py = fs
    .readdirSync(pkg)
    .filter((f) => f.endsWith('.py'))
    .sort()
    .map((f) => path.join('stablesfx_engine', f))
  return [...ENGINE_FILES, ...py]
}

/** Hash of the dependency lock: picks the versioned env folder. */
export function lockHash(): string {
  return sha(ENGINE_FILES, engineSourceDir()).slice(0, 8)
}

/** Hash of the engine python sources (matches EngineStatus.src_hash). */
function srcHash(base: string): string {
  const h = createHash('sha1')
  const pkg = path.join(base, 'stablesfx_engine')
  for (const f of fs.readdirSync(pkg).filter((f) => f.endsWith('.py')).sort()) {
    h.update(f)
    h.update(fs.readFileSync(path.join(pkg, f)))
  }
  return h.digest('hex').slice(0, 12)
}

/** Copy the engine sources to ~/.stablesfx/engine (stable path used by the engine and MCP). */
function syncEngineCopy(): void {
  const src = engineSourceDir()
  const files = engineFiles(src)
  const want = sha(files, src)
  const marker = path.join(ENGINE_COPY, '.source-hash')
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === want) return
  fs.mkdirSync(path.join(ENGINE_COPY, 'stablesfx_engine'), { recursive: true })
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(ENGINE_COPY, f))
  const keep = new Set(files.map((f) => path.basename(f)))
  for (const f of fs.readdirSync(path.join(ENGINE_COPY, 'stablesfx_engine'))) {
    if (f.endsWith('.py') && !keep.has(f)) fs.rmSync(path.join(ENGINE_COPY, 'stablesfx_engine', f))
  }
  fs.writeFileSync(marker, want)
}

function envDir(): string {
  return path.join(ENV_ROOT, lockHash())
}

export function pythonExe(dir = CURRENT_ENV): string {
  return path.join(dir, 'Scripts', 'python.exe')
}

export function setupState(): SetupState {
  const dir = envDir()
  const ready = fs.existsSync(path.join(dir, '.stablesfx-ok')) && fs.existsSync(pythonExe(dir))
  let current: string | null
  try {
    current = fs.realpathSync(CURRENT_ENV)
  } catch {
    current = null
  }
  return {
    envReady: ready && current !== null && path.resolve(current) === path.resolve(dir),
    envDir: dir,
    uv: bundledUv(),
    home: HOME,
    engineDir: ENGINE_COPY
  }
}

function pointCurrentAt(dir: string): void {
  try {
    fs.unlinkSync(CURRENT_ENV)
  } catch {
    try {
      fs.rmdirSync(CURRENT_ENV)
    } catch {
      /* not there */
    }
  }
  fs.symlinkSync(dir, CURRENT_ENV, 'junction')
}

function pruneOldEnvs(keep: string): void {
  for (const name of fs.readdirSync(ENV_ROOT)) {
    const full = path.join(ENV_ROOT, name)
    if (name === 'current' || path.resolve(full) === path.resolve(keep)) continue
    // Fails harmlessly while an old engine/MCP process still holds its DLLs; retried next launch.
    fs.rm(full, { recursive: true, force: true, maxRetries: 0 }, () => undefined)
  }
}

export function uvEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_CACHE_DIR: path.join(HOME, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: path.join(HOME, 'python'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_PROGRESS: '1'
  }
}

/** Create/refresh the Python environment. Streams uv output through `log`. */
export function runSetup(log: (line: string) => void): Promise<void> {
  syncEngineCopy()
  const uv = bundledUv()
  if (!uv) return Promise.reject(new Error('uv.exe is missing from the app resources (run ./build.sh)'))
  const dir = envDir()
  fs.mkdirSync(ENV_ROOT, { recursive: true })
  log(`Creating Python environment in ${dir}`)
  log('First run downloads Python 3.12 and CUDA PyTorch (~3 GB); later updates are incremental.')
  return new Promise((resolve, reject) => {
    const child = spawn(
      uv,
      ['sync', '--frozen', '--no-dev', '--no-install-project', '--project', ENGINE_COPY],
      { env: { ...uvEnv(), UV_PROJECT_ENVIRONMENT: dir }, windowsHide: true }
    )
    const pump = (buf: Buffer): void => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) log(line)
    }
    child.stdout.on('data', pump)
    child.stderr.on('data', pump)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`uv sync failed (exit ${code})`))
      fs.writeFileSync(path.join(dir, '.stablesfx-ok'), new Date().toISOString())
      pointCurrentAt(dir)
      pruneOldEnvs(dir)
      log('Environment ready.')
      resolve()
    })
  })
}

function runPython(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      pythonExe(),
      ['-m', 'stablesfx_engine', ...args],
      {
        env: { ...process.env, PYTHONPATH: ENGINE_COPY, PYTHONWARNINGS: 'ignore' },
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1 << 20
      },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))
    )
  })
}

type Listener = (msg: { type: string; data: unknown }) => void

/** Connection to the shared engine, with automatic reconnect. */
export class EngineClient extends EventEmitter {
  info: EngineInfo | null = null
  private ws: WebSocket | null = null
  private connecting: Promise<EngineInfo> | null = null
  private closed = false

  async connect(): Promise<EngineInfo> {
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      syncEngineCopy()
      const out = await runPython(['ensure', '--timeout', '90'], 120_000)
      const info = JSON.parse(out.trim().split(/\r?\n/).pop() as string) as EngineInfo
      this.info = info
      // Restart an engine that runs older code than this app ships (only when idle).
      try {
        const status = (await this.request('GET', '/status')) as { src_hash: string; busy: boolean; queue: number }
        if (status.src_hash !== srcHash(ENGINE_COPY) && !status.busy && status.queue === 0) {
          // `stop` waits for the old engine to exit (killing it if needed) before we start the new one.
          await runPython(['stop'], 30_000).catch(() => undefined)
          const again = await runPython(['ensure', '--timeout', '90'], 120_000)
          this.info = JSON.parse(again.trim().split(/\r?\n/).pop() as string) as EngineInfo
        }
      } catch {
        /* status check is best effort */
      }
      this.openEvents()
      return this.info as EngineInfo
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private openEvents(): void {
    if (!this.info) return
    this.ws?.close()
    const ws = new WebSocket(`ws://127.0.0.1:${this.info.port}/events?token=${encodeURIComponent(this.info.token)}`)
    this.ws = ws
    ws.onmessage = (e) => {
      try {
        this.emit('event', JSON.parse(String(e.data)))
      } catch {
        /* ignore malformed */
      }
    }
    ws.onopen = () => this.emit('connection', 'connected')
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return
      this.emit('connection', 'reconnecting')
      setTimeout(() => this.connect().catch((err) => this.emit('connection', `error: ${err.message}`)), 1500)
    }
  }

  onEvent(fn: Listener): void {
    this.on('event', fn)
  }

  async request(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    const info = this.info ?? (await this.connect())
    const doFetch = (i: EngineInfo): Promise<Response> =>
      fetch(`http://127.0.0.1:${i.port}${urlPath}`, {
        method,
        headers: { Authorization: `Bearer ${i.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    let res: Response
    try {
      res = await doFetch(info)
    } catch {
      res = await doFetch(await this.connect())
    }
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok) {
      const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : text
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return data
  }

  /** Proxy for the sfx:// protocol (keeps the token out of the renderer). */
  async fetchAudio(id: string, range: string | null): Promise<Response> {
    const info = this.info ?? (await this.connect())
    const headers: Record<string, string> = { Authorization: `Bearer ${info.token}` }
    if (range) headers.Range = range
    const res = await fetch(`http://127.0.0.1:${info.port}/audio/${encodeURI(id)}`, { headers })
    const out = new Headers(res.headers)
    out.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers: out })
  }

  async stopEngine(): Promise<void> {
    await runPython(['stop'], 30_000)
  }

  dispose(): void {
    this.closed = true
    this.ws?.close()
  }
}
