import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CanvasState, PreviewData, PtyStartOptions } from '../shared/types'
import { normalizeUrl } from '../shared/url'
import { handleMcp } from './mcp'
import { PREVIEW_PARTITION, PreviewManager } from './preview'
import { PtyManager } from './pty'
import { LocalServer } from './server'

app.setName('VibeCanvas')

// Optional separate profile (e.g. for testing without touching your real canvas).
if (process.env.VIBECANVAS_PROFILE) app.setPath('userData', process.env.VIBECANVAS_PROFILE)
if (process.env.VIBECANVAS_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.VIBECANVAS_DEBUG_PORT)
}

const statePath = () => join(app.getPath('userData'), 'canvas-state.json')
const windowPath = () => join(app.getPath('userData'), 'window.json')
const imagesDir = () => join(app.getPath('userData'), 'images')

/** The app used to be called "Claude Canvas"; carry its canvas and images over once. */
function migrateLegacyData(): void {
  const dir = app.getPath('userData')
  const legacy = join(dirname(dir), 'Claude Canvas')
  if (existsSync(join(dir, 'canvas-state.json')) || !existsSync(join(legacy, 'canvas-state.json'))) return
  mkdirSync(dir, { recursive: true })
  if (existsSync(join(legacy, 'images'))) cpSync(join(legacy, 'images'), join(dir, 'images'), { recursive: true })
  if (existsSync(join(legacy, 'window.json'))) cpSync(join(legacy, 'window.json'), join(dir, 'window.json'))
  // Prompts store absolute image paths, so point them at the copied folder.
  const state = readFileSync(join(legacy, 'canvas-state.json'), 'utf8')
  writeFileSync(join(dir, 'canvas-state.json'), state.split(join(legacy, 'images')).join(join(dir, 'images')))
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

// The Claude desktop app ships its typefaces; borrow them from the local install
// rather than copying them into this project. Missing fonts fall back to system ones.
const CLAUDE_RESOURCES = '/Applications/Claude.app/Contents/Resources'
const FONT_SOURCES: Record<string, { dir: string; prefix: string }> = {
  sans: { dir: 'fonts', prefix: 'AnthropicSans-Romans-Variable' },
  'sans-italic': { dir: 'fonts', prefix: 'AnthropicSans-Italics-Variable' },
  serif: { dir: 'fonts', prefix: 'AnthropicSerif-Romans-Variable' },
  'serif-italic': { dir: 'fonts', prefix: 'AnthropicSerif-Italics-Variable' },
  mono: { dir: 'ion-dist/_frame-rt/_runtime', prefix: 'AnthropicMono-Roman-Web' }
}

function findFont(name: string): string | null {
  const source = FONT_SOURCES[name]
  if (!source) return null
  const dir = join(CLAUDE_RESOURCES, source.dir)
  try {
    const file = readdirSync(dir).find((f) => f.startsWith(source.prefix))
    return file ? join(dir, file) : null
  } catch {
    return null
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'claude-font', privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } },
  { scheme: 'canvas-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// $BROWSER for sessions; outside the asar archive, so it can be executed.
const browserShim = app.isPackaged
  ? join(process.resourcesPath, 'browser-shim.js')
  : join(app.getAppPath(), 'resources/browser-shim.js')

let win: BrowserWindow | null = null
const send = (channel: string, ...args: unknown[]): boolean => {
  if (!win || win.isDestroyed()) return false
  win.webContents.send(channel, ...args)
  return true
}
const server = new LocalServer()
const ptys = new PtyManager(send, server, browserShim)
const previews = new PreviewManager(send, (terminalId) => ptys.cwd(terminalId))

server.route('POST', /^\/mcp\/([\w-]+)$/, ({ match, body }, res) => handleMcp(previews, match[1], body, res))
// No server-initiated messages, so no event stream to open.
server.route('GET', /^\/mcp\/([\w-]+)$/, (_req, res) => {
  res.writeHead(405, { Allow: 'POST' }).end()
})
server.route('DELETE', /^\/mcp\/([\w-]+)$/, (_req, res) => {
  res.writeHead(204).end()
})
server.route('POST', /^\/open\/([\w-]+)$/, ({ match, body }, res) => {
  const url = body.trim()
  const ok = /^https?:\/\//.test(url) && previews.openFromBrowser(match[1], normalizeUrl(url))
  res.writeHead(ok ? 204 : 503).end()
})

function createWindow(): void {
  const bounds = readJson<Electron.Rectangle>(windowPath())
  win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      webviewTag: true
    }
  })

  win.once('ready-to-show', () => win?.show())
  win.on('close', () => {
    if (win) writeJsonAtomic(windowPath(), win.getNormalBounds())
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault()
  })

  // Preview cards: sandboxed pages without node or preloads, in their own persistent
  // session, kept rendering while off-screen so Claude can still screenshot them.
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.backgroundThrottling = false
    params.partition = PREVIEW_PARTITION
    if (!/^(https?|file|about|data):/.test(params.src ?? '')) params.src = 'about:blank'
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    // Links that open a new window load in the same card.
    guest.setWindowOpenHandler(({ url }) => {
      if (/^(https?|file):/.test(url)) guest.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('state:load', () => readJson<CanvasState>(statePath()))
ipcMain.on('state:save', (_e, state: CanvasState) => writeJsonAtomic(statePath(), state))
ipcMain.on('state:saveSync', (e, state: CanvasState) => {
  writeJsonAtomic(statePath(), state)
  e.returnValue = true
})
ipcMain.handle('dialog:directory', async () => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: homedir()
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('image:save', (_e, data: ArrayBuffer, ext: string) => {
  mkdirSync(imagesDir(), { recursive: true })
  const file = join(imagesDir(), `${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`)
  writeFileSync(file, Buffer.from(data))
  return file
})

ipcMain.handle('pty:start', (_e, opts: PtyStartOptions) => ptys.start(opts))
ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
ipcMain.on('pty:send', (_e, id: string, text: string, images: string[], submit: boolean) =>
  ptys.sendInput(id, text, images, submit)
)
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
ipcMain.on('pty:kill', (_e, id: string) => ptys.kill(id))

ipcMain.on('preview:attach', (e, id: string, webContentsId: number, data: PreviewData) =>
  previews.attach(id, webContentsId, data, e.sender)
)
ipcMain.on('preview:detach', (_e, id: string, webContentsId: number) => previews.detach(id, webContentsId))
ipcMain.on('preview:close', (_e, id: string) => previews.close(id))
ipcMain.handle('preview:startServer', (_e, id: string) => previews.startServerFor(id))
ipcMain.on('preview:stopServer', (_e, id: string) => previews.stopServer(id))

app.whenReady().then(async () => {
  migrateLegacyData()
  // A packaged app gets its icon from build/icon.icns; in development the Dock would
  // otherwise show Electron's default icon.
  const icon = join(app.getAppPath(), 'resources/icon.png')
  if (process.platform === 'darwin' && existsSync(icon)) app.dock?.setIcon(icon)

  protocol.handle('claude-font', (req) => {
    const file = findFont(new URL(req.url).hostname)
    if (!file || !existsSync(file)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  // Thumbnails: canvas-image://local/<file> serves files from the images folder only.
  protocol.handle('canvas-image', (req) => {
    const file = join(imagesDir(), basename(decodeURIComponent(new URL(req.url).pathname)))
    if (!existsSync(file)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  previews.init()
  await server.listen()
  createWindow()
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  ptys.killAll()
  previews.stopAll()
  server.close()
})
