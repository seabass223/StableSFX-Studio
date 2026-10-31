/** Types shared by the main process, preload and renderer. */
import type { components } from './engine-api'

export type Schemas = components['schemas']
export type SfxItem = Schemas['SfxItem']
export type JobInfo = Schemas['JobInfo']
export type JobRequest = Schemas['JobRequest']
export type GenerateParams = Schemas['GenerateParams']
export type ShiftParams = Schemas['ShiftParams']
export type LoraSpec = Schemas['LoraSpec']
export type ModelInfo = Schemas['ModelInfo']
export type EngineStatus = Schemas['EngineStatus']
export type EngineConfig = Schemas['EngineConfig']
export type FolderNode = Schemas['FolderNode']
export type Preset = Schemas['Preset']
export type ExportRequest = Schemas['ExportRequest']
export type ExportResult = Schemas['ExportResult']
export type ModelId = GenerateParams['model']
export type JobMode = NonNullable<JobRequest['mode']>
export type AudioFormat = NonNullable<ExportRequest['format']>

export type ProcessOp =
  | Schemas['TrimOp']
  | Schemas['TrimSilenceOp']
  | Schemas['NormalizeOp']
  | Schemas['FadeOp']
  | Schemas['ReverseOp']
  | Schemas['GainOp']
  | Schemas['LoopCrossfadeOp']
  | Schemas['PitchOp']
  | Schemas['StretchOp']
  | Schemas['ChannelsOp']
  | Schemas['ResampleOp']
  | Schemas['FilterOp']
  | Schemas['PadOp']

export interface EngineInfo {
  port: number
  token: string
  pid: number
  nonce: string
  srcHash: string
  fake: boolean
}

export interface SetupState {
  envReady: boolean
  envDir: string
  uv: string | null
  home: string
  engineDir: string
}

export type EngineEvent =
  | { type: 'status'; data: EngineStatus }
  | { type: 'job'; data: JobInfo }
  | { type: 'library'; data: { change: string; ids?: string[]; folder?: string } }
  | { type: 'history'; data: { change: string; ids?: string[] } }
  | { type: 'model'; data: { model: string; state: string; done?: number; total?: number; error?: string; device?: string } }
  | { type: 'log'; data: { line: string } }
  | { type: 'config'; data: EngineConfig }
  | { type: 'presets'; data: { change: string; id?: string } }

export interface McpStatus {
  registered: boolean
  configPath: string
  command: string
  args: string[]
  env: Record<string, string>
  matches: boolean
}

/** The API exposed on `window.api` by the preload script. */
export interface StudioApi {
  setup: {
    state(): Promise<SetupState>
    run(): Promise<void>
    onLog(fn: (line: string) => void): () => void
  }
  engine: {
    connect(): Promise<{ ok: boolean; error?: string }>
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>
    stop(): Promise<void>
    onEvent(fn: (e: EngineEvent) => void): () => void
    onConnection(fn: (state: string) => void): () => void
  }
  files: {
    pathFor(file: File): string
    chooseFolder(defaultPath?: string): Promise<string | null>
    chooseAudio(): Promise<string[]>
    reveal(path: string): Promise<void>
    openPath(path: string): Promise<void>
    startDrag(path: string): void
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  mcp: {
    status(): Promise<McpStatus>
    register(): Promise<McpStatus>
  }
  app: {
    version(): Promise<string>
  }
}
