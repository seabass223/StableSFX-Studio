/** Typed wrapper over the engine HTTP API (proxied through the main process). */
import type {
  EngineConfig, EngineStatus, ExportRequest, ExportResult, FolderNode, JobInfo, JobRequest, ModelInfo,
  Preset, ProcessOp, SfxItem
} from '@shared/ipc'

const req = <T,>(method: string, path: string, body?: unknown): Promise<T> =>
  window.api.engine.request<T>(method, path, body)

const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

const enc = (id: string): string => id.split('/').map(encodeURIComponent).join('/')

export const engineApi = {
  status: () => req<EngineStatus>('GET', '/status'),
  models: () => req<ModelInfo[]>('GET', '/models'),
  downloadModel: (id: string) => req('POST', `/models/${id}/download`),
  deleteModelCache: (id: string) => req<{ freed: number }>('DELETE', `/models/${id}/cache`),
  unloadModel: () => req('POST', '/models/unload'),
  config: () => req<EngineConfig>('GET', '/config'),
  patchConfig: (patch: Partial<EngineConfig>) => req<EngineConfig>('PATCH', '/config', patch),
  logs: () => req<string[]>('GET', '/logs'),

  submit: (body: JobRequest) => req<JobInfo>('POST', '/jobs', body),
  cancel: (id: string) => req<JobInfo>('POST', `/jobs/${id}/cancel`),
  jobs: () => req<JobInfo[]>('GET', '/jobs'),

  tree: () => req<FolderNode>('GET', '/library/tree'),
  items: (p: { folder?: string; q?: string; tags?: string; sort?: string; recursive?: boolean } = {}) =>
    req<SfxItem[]>('GET', `/library/items${qs(p)}`),
  history: (q?: string) => req<SfxItem[]>('GET', `/history/items${qs({ q })}`),
  pruneHistory: () => req<{ removed: number }>('POST', '/history/prune'),
  item: (id: string) => req<SfxItem>('GET', `/items/${enc(id)}`),
  resolve: (ref: string) => req<SfxItem>('GET', `/resolve${qs({ ref })}`),
  patchItem: (id: string, patch: { name?: string; folder?: string; tags?: string[]; starred?: boolean; prompt?: string }) =>
    req<SfxItem>('PATCH', `/items/${enc(id)}`, patch),
  deleteItem: (id: string) => req('DELETE', `/items/${enc(id)}`),
  keep: (body: { id: string; folder?: string; name?: string | null; tags?: string[]; move?: boolean }) =>
    req<SfxItem>('POST', '/library/keep', body),
  importFiles: (paths: string[], folder = 'Imported') => req<SfxItem[]>('POST', '/library/import', { paths, folder }),
  createFolder: (path: string) => req<{ path: string }>('POST', '/library/folders', { path }),
  renameFolder: (path: string, new_path: string) => req<{ path: string }>('PATCH', '/library/folders', { path, new_path }),
  deleteFolder: (path: string) => req('DELETE', `/library/folders${qs({ path })}`),

  process: (body: { source: string; ops: ProcessOp[]; target?: 'history' | 'replace' | 'library'; folder?: string; name?: string }) =>
    req<SfxItem>('POST', '/process', body),
  exportFiles: (body: ExportRequest) => req<ExportResult>('POST', '/export', body),

  presets: () => req<Preset[]>('GET', '/presets'),
  savePreset: (p: Preset) => req<Preset>('PUT', '/presets', p),
  deletePreset: (id: string) => req('DELETE', `/presets/${enc(id)}`)
}

/** URL the renderer can play/decode; proxied (with auth) by the main process. */
export function audioUrl(item: Pick<SfxItem, 'id' | 'modified'>): string {
  return `sfx://audio/${encodeURIComponent(item.id)}?v=${Math.round(item.modified * 1000)}`
}

export function fmtTime(seconds: number, ms = false): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const sec = ms ? rest.toFixed(2).padStart(5, '0') : String(Math.floor(rest)).padStart(2, '0')
  return `${String(m).padStart(2, '0')}:${sec}`
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n > 1e6) return `${(n / 1e6).toFixed(0)} MB`
  return `${(n / 1e3).toFixed(0)} kB`
}
