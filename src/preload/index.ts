import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EngineEvent, StudioApi } from '@shared/ipc'

function subscribe<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StudioApi = {
  setup: {
    state: () => ipcRenderer.invoke('setup:state'),
    run: () => ipcRenderer.invoke('setup:run'),
    onLog: (fn) => subscribe<string>('setup:log', fn)
  },
  engine: {
    connect: () => ipcRenderer.invoke('engine:connect'),
    request: (method, path, body) => ipcRenderer.invoke('engine:request', method, path, body),
    stop: () => ipcRenderer.invoke('engine:stop'),
    onEvent: (fn) => subscribe<EngineEvent>('engine:event', fn),
    onConnection: (fn) => subscribe<string>('engine:connection', fn)
  },
  files: {
    pathFor: (file) => webUtils.getPathForFile(file),
    chooseFolder: (defaultPath) => ipcRenderer.invoke('files:chooseFolder', defaultPath),
    chooseAudio: () => ipcRenderer.invoke('files:chooseAudio'),
    reveal: (p) => ipcRenderer.invoke('files:reveal', p),
    openPath: (p) => ipcRenderer.invoke('files:openPath', p),
    startDrag: (p) => ipcRenderer.send('files:startDrag', p)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    register: () => ipcRenderer.invoke('mcp:register')
  },
  app: {
    version: () => ipcRenderer.invoke('app:version')
  }
}

contextBridge.exposeInMainWorld('api', api)
