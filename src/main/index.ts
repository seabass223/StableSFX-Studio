import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { EngineClient, runSetup, setupState } from './engine'
import { mcpStatus, registerMcp } from './mcp'

protocol.registerSchemesAsPrivileged([
  { scheme: 'sfx', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

const engine = new EngineClient()
let win: BrowserWindow | null = null

function assetPath(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), 'build', name)
}

function createWindow(): void {
  const icon = assetPath('icon.png')
  const area = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: Math.max(1200, Math.min(1720, Math.round(area.width * 0.9))),
    height: Math.max(780, Math.min(1060, Math.round(area.height * 0.92))),
    minWidth: 1200,
    minHeight: 780,
    show: false,
    backgroundColor: '#0f0b08',
    title: 'StableSFX Studio',
    icon: fs.existsSync(icon) ? icon : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#d8c3ad', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Drops from Explorer onto the window must not navigate away from the app.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function registerIpc(): void {
  engine.onEvent((e) => send('engine:event', e))
  engine.on('connection', (state: string) => send('engine:connection', state))

  ipcMain.handle('setup:state', () => setupState())
  ipcMain.handle('setup:run', () => runSetup((line) => send('setup:log', line)))

  ipcMain.handle('engine:connect', async () => {
    try {
      await engine.connect()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('engine:request', (_e, method: string, urlPath: string, body?: unknown) =>
    engine.request(method, urlPath, body)
  )
  ipcMain.handle('engine:stop', () => engine.stopEngine())

  ipcMain.handle('files:chooseFolder', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('files:chooseAudio', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'ogg', 'aif', 'aiff'] }]
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('files:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('files:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.on('files:startDrag', (e, p: string) => {
    if (!fs.existsSync(p)) return
    const icon = nativeImage.createFromPath(assetPath('drag.png'))
    e.sender.startDrag({ file: p, icon: icon.isEmpty() ? nativeImage.createFromPath(assetPath('icon.png')) : icon })
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https:\/\/(huggingface\.co|github\.com)\//.test(url)) return shell.openExternal(url)
    return undefined
  })

  ipcMain.handle('mcp:status', () => mcpStatus())
  ipcMain.handle('mcp:register', () => registerMcp())
  ipcMain.handle('app:version', () => app.getVersion())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.kylesebestyen.stablesfx')
    protocol.handle('sfx', async (req) => {
      const url = new URL(req.url)
      if (url.host === 'audio') {
        return engine.fetchAudio(decodeURIComponent(url.pathname.slice(1)), req.headers.get('range'))
      }
      if (url.host === 'file') {
        // Local files dropped onto the editor before import (read-only, audio types only).
        const file = decodeURIComponent(url.pathname.slice(1))
        if (!/\.(wav|flac|mp3|ogg|aiff?)$/i.test(file)) return new Response('forbidden', { status: 403 })
        return net.fetch('file:///' + file.replace(/\\/g, '/'))
      }
      return new Response('not found', { status: 404 })
    })
    registerIpc()
    createWindow()
  })

  app.on('window-all-closed', () => {
    engine.dispose()
    app.quit()
  })
}
