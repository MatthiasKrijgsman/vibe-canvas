import { nativeImage, session, webContents, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import type { PreviewData, PreviewServer, ServerStatus } from '../shared/types'
import { normalizeUrl } from '../shared/url'
import { terminalEnv } from './env'
import { pageInsertText, pageLocate, pageSelectOption, pageSerialize, pageSnapshot, type Located, type Target } from './pageScripts'

export const PREVIEW_PARTITION = 'persist:vibecanvas-preview'

/** Delivers a message to the canvas; false when there is no window to show it. */
type Send = (channel: string, ...args: unknown[]) => boolean

/** A failure Claude should read as the tool's answer, not as a crash. */
export class ToolError extends Error {}

interface LogEntry {
  time: number
  level: string
  text: string
}

interface NetEntry {
  time: number
  method: string
  url: string
  type: string
  status?: number
  error?: string
}

interface DevServer {
  config: PreviewServer
  proc: ChildProcess
  output: string
  status: ServerStatus
}

interface Preview {
  id: string
  terminalId?: string
  wc: WebContents | null
  console: LogEntry[]
  network: NetEntry[]
  errorCount: number
  loadError?: string
  server?: DevServer
  /** Kept from the card's data, so a server can be started again after a restart. */
  serverConfig?: PreviewServer
  lastUsed: number
}

const ANSI = /\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()][0-9A-B]?/g
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"`)<>]*)?/
const MAX_LOG = 1000
const MAX_NET = 500
const MAX_OUTPUT = 200_000
const SCREENSHOT_MAX = 1568
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const KEYS: Record<string, { code: string; keyCode: number; key?: string; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, key: ' ', text: ' ' }
}
const KEY_ALIASES: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', ' ': 'Space' }
const MODIFIERS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
// macOS editing shortcuts only work when the matching editor command is sent along.
const EDIT_COMMANDS: Record<string, string> = { 'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo' }

export const PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 }
}

function tail(text: string, lines: number): string {
  return text.split('\n').filter((l) => l.trim()).slice(-lines).join('\n')
}

function findLocalUrl(output: string): string | undefined {
  const lines = output.split('\n')
  // Prefer the line dev servers label as the local address.
  const line = lines.find((l) => /local/i.test(l) && LOCAL_URL.test(l)) ?? lines.find((l) => LOCAL_URL.test(l))
  const url = line?.match(LOCAL_URL)?.[0].replace(/[.,;:]+$/, '')
  return url?.replace(/\/\/(0\.0\.0\.0|\[::\])/, '//localhost')
}

function portOpen(url: string): Promise<boolean> {
  const u = new URL(url)
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  return new Promise((done) => {
    const socket = connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port, timeout: 1000 })
    const finish = (open: boolean) => {
      socket.destroy()
      done(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** A configuration from the project's .claude/launch.json (the format Claude's desktop app uses). */
function readLaunchConfig(dir: string, name?: string): PreviewServer {
  const file = join(dir, '.claude', 'launch.json')
  if (!existsSync(file)) {
    throw new ToolError('Pass `command` (for example "npm run dev"). This project has no .claude/launch.json to read it from.')
  }
  let configs: Record<string, unknown>[]
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    configs = Array.isArray(json.configurations) ? json.configurations : []
  } catch (err) {
    throw new ToolError(`Couldn't read ${file}: ${String(err)}`)
  }
  const names = configs.map((c) => String(c.name ?? '')).filter(Boolean)
  const config = name ? configs.find((c) => c.name === name) : configs.length === 1 ? configs[0] : undefined
  if (!config) {
    throw new ToolError(
      name
        ? `No configuration named "${name}" in .claude/launch.json. Available: ${names.join(', ') || 'none'}`
        : `.claude/launch.json has ${configs.length} configurations; pass name (one of: ${names.join(', ')}) or command.`
    )
  }
  const parts = [config.runtimeExecutable, ...(Array.isArray(config.runtimeArgs) ? config.runtimeArgs : [])]
  const command = typeof config.command === 'string' ? config.command : parts.filter(Boolean).map((p) => shellQuote(String(p))).join(' ')
  if (!command) throw new ToolError(`The "${config.name}" configuration has no runtimeExecutable.`)
  return {
    command,
    cwd: typeof config.cwd === 'string' ? resolve(dir, config.cwd) : dir,
    port: typeof config.port === 'number' ? config.port : undefined
  }
}

export class PreviewManager {
  private previews = new Map<string, Preview>()
  private attachWaiters = new Map<string, () => void>()
  private activityTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private send: Send,
    private cwdOf: (terminalId: string) => string | undefined
  ) {}

  /** Network requests of every preview, recorded per card. Call once the app is ready. */
  init(): void {
    const { webRequest } = session.fromPartition(PREVIEW_PARTITION)
    webRequest.onCompleted((d) => {
      this.byWebContents(d.webContentsId)?.network.push({
        time: Date.now(),
        method: d.method,
        url: d.url,
        type: d.resourceType,
        status: d.statusCode
      })
      this.trimNetwork(d.webContentsId)
    })
    webRequest.onErrorOccurred((d) => {
      if (d.error === 'net::ERR_ABORTED') return
      this.byWebContents(d.webContentsId)?.network.push({
        time: Date.now(),
        method: d.method,
        url: d.url,
        type: d.resourceType,
        error: d.error
      })
      this.trimNetwork(d.webContentsId)
    })
  }

  private byWebContents(id?: number): Preview | undefined {
    if (id === undefined) return undefined
    for (const p of this.previews.values()) if (p.wc?.id === id) return p
    return undefined
  }

  private trimNetwork(id?: number): void {
    const p = this.byWebContents(id)
    if (p && p.network.length > MAX_NET) p.network.splice(0, p.network.length - MAX_NET)
  }

  private record(id: string, terminalId?: string): Preview {
    let p = this.previews.get(id)
    if (!p) {
      p = { id, terminalId, wc: null, console: [], network: [], errorCount: 0, lastUsed: Date.now() }
      this.previews.set(id, p)
    }
    return p
  }

  private log(p: Preview, level: string, text: string): void {
    p.console.push({ time: Date.now(), level, text })
    if (level === 'error') p.errorCount++
    if (p.console.length > MAX_LOG) p.console.splice(0, p.console.length - MAX_LOG)
  }

  // ---------- The canvas side ----------

  /** A card's webview is ready (or was re-created, e.g. after a reload of the canvas). */
  attach(id: string, webContentsId: number, data: PreviewData, host: WebContents): void {
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== host) return
    const p = this.record(id, data.terminalId)
    p.terminalId = data.terminalId
    p.serverConfig = data.server ?? p.server?.config
    if (p.wc !== wc) {
      p.wc = wc
      wc.on('console-message', (e) => {
        if (e.sourceId.startsWith('node:electron')) return // Electron's own development warnings
        const source = e.sourceId ? ` (${e.sourceId.replace(/^https?:\/\/[^/]+/, '')}:${e.lineNumber})` : ''
        this.log(p, e.level, `${e.message}${source}`)
      })
      wc.on('did-start-navigation', (e) => {
        if (!e.isMainFrame || e.isSameDocument) return
        p.loadError = undefined
        p.network = []
      })
      wc.on('did-navigate', (_e, url) => this.log(p, 'navigation', `navigated to ${url}`))
      wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
        if (isMainFrame && code !== -3) p.loadError = `${description} (${code}) loading ${url}`
      })
      wc.on('render-process-gone', (_e, details) => this.log(p, 'error', `page crashed: ${details.reason}`))
      wc.once('destroyed', () => {
        if (p.wc === wc) p.wc = null
      })
    }
    if (p.server) this.send('preview:server', id, p.server.status)
    this.attachWaiters.get(id)?.()
  }

  detach(id: string, webContentsId: number): void {
    const p = this.previews.get(id)
    if (p?.wc?.id === webContentsId) p.wc = null
  }

  /** The card was removed from the canvas. */
  close(id: string): void {
    const p = this.previews.get(id)
    if (!p) return
    this.killServer(p)
    this.previews.delete(id)
  }

  /** "Start dev server" on a card whose server isn't running. */
  async startServerFor(id: string): Promise<{ error?: string }> {
    const p = this.previews.get(id)
    const config = p?.serverConfig ?? p?.server?.config
    if (!p || !config) return { error: 'This preview has no dev server to start.' }
    try {
      await this.runServer(p, config)
      return {}
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  stopServer(id: string): void {
    const p = this.previews.get(id)
    if (p) this.killServer(p)
  }

  stopAll(): void {
    for (const p of this.previews.values()) this.killServer(p)
  }

  /** $BROWSER from a session: show local URLs on the canvas next to the terminal. */
  openFromBrowser(terminalId: string, url: string): boolean {
    const linked = this.linked(terminalId)[0]
    if (linked?.wc) {
      linked.lastUsed = Date.now()
      linked.wc.loadURL(url).catch(() => undefined)
      return true
    }
    const id = `preview-${randomUUID()}`
    this.record(id, terminalId)
    if (this.send('preview:open', { id, url, terminalId })) return true
    this.previews.delete(id)
    return false
  }

  // ---------- Helpers for the tools ----------

  /** Previews opened by this terminal, most recently used first. */
  private linked(terminalId: string): Preview[] {
    return [...this.previews.values()].filter((p) => p.terminalId === terminalId).sort((a, b) => b.lastUsed - a.lastUsed)
  }

  private pick(terminalId: string, previewId?: string): Preview & { wc: WebContents } {
    let p: Preview | undefined
    if (previewId) {
      p = this.previews.get(previewId)
      if (!p) throw new ToolError(`No preview with id ${previewId}. Use preview_list to see the open previews.`)
    } else {
      p = this.linked(terminalId)[0]
      if (!p) {
        const others = [...this.previews.values()]
        throw new ToolError(
          'This session has no preview open yet. Start one with preview_start (dev server) or preview_open (URL or file).' +
            (others.length ? ` Other previews on the canvas: ${others.map((o) => `${o.id} (${o.wc?.getURL() ?? 'not loaded'})`).join(', ')}` : '')
        )
      }
    }
    if (!p.wc || p.wc.isDestroyed()) throw new ToolError(`Preview ${p.id} isn't loaded on the canvas right now.`)
    p.lastUsed = Date.now()
    return p as Preview & { wc: WebContents }
  }

  /** Light up the card and its line while a tool works on it. */
  private async act<T>(p: Preview, fn: () => Promise<T>): Promise<T> {
    clearTimeout(this.activityTimers.get(p.id))
    this.send('preview:activity', p.id, true)
    try {
      return await fn()
    } finally {
      this.activityTimers.set(
        p.id,
        setTimeout(() => this.send('preview:activity', p.id, false), 900)
      )
    }
  }

  private async cdp<T = Record<string, unknown>>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3')
      } catch (err) {
        throw new ToolError(`Couldn't control the page (${String(err)}). Close its DevTools and try again.`)
      }
      // Typing only reaches a focused page; pretend it is, rather than taking focus from the user.
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
    }
    return (await wc.debugger.sendCommand(method, params)) as T
  }

  private waitForLoad(wc: WebContents, timeout: number): Promise<void> {
    if (!wc.isLoading()) return Promise.resolve()
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer)
        wc.off('did-stop-loading', finish)
        done()
      }
      const timer = setTimeout(finish, timeout)
      wc.on('did-stop-loading', finish)
    })
  }

  /** Give the page a moment to react to input, and to finish loading if it navigated. */
  private async settle(wc: WebContents): Promise<void> {
    await sleep(150)
    await this.waitForLoad(wc, 10_000)
    await sleep(100)
  }

  private async navigate(p: Preview & { wc: WebContents }, url: string): Promise<void> {
    p.loadError = undefined
    await Promise.race([p.wc.loadURL(url).catch(() => undefined), sleep(20_000)])
  }

  private describe(p: Preview & { wc: WebContents }, errorsBefore?: number): string {
    const lines = [`Preview ${p.id}: "${p.wc.getTitle()}" — ${p.wc.getURL()}`]
    if (p.loadError) lines.push(`Load failed: ${p.loadError}`)
    if (errorsBefore !== undefined && p.errorCount > errorsBefore) {
      const n = p.errorCount - errorsBefore
      lines.push(`${n} new console error${n > 1 ? 's' : ''}; see preview_console_logs.`)
    }
    return lines.join('\n')
  }

  /** Ask the canvas for a new card and wait until its webview is ready. */
  private async openCard(terminalId: string, url: string, server?: PreviewServer): Promise<Preview & { wc: WebContents }> {
    const id = `preview-${randomUUID()}`
    const p = this.record(id, terminalId)
    p.serverConfig = server
    const attached = new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 15_000)
      this.attachWaiters.set(id, () => {
        clearTimeout(timer)
        done(true)
      })
    })
    if (!this.send('preview:open', { id, url, terminalId, server })) {
      this.previews.delete(id)
      throw new ToolError('VibeCanvas has no window open to show the preview in.')
    }
    const ok = await attached
    this.attachWaiters.delete(id)
    if (!ok || !p.wc) throw new ToolError("The canvas didn't open the preview card.")
    return p as Preview & { wc: WebContents }
  }

  // ---------- Dev servers ----------

  private setServerStatus(p: Preview, server: DevServer, status: ServerStatus): void {
    server.status = status
    if (p.server === server) this.send('preview:server', p.id, status)
  }

  private killServer(p: Preview): void {
    const server = p.server
    if (!server) return
    p.server = undefined
    this.send('preview:server', p.id, null)
    const { proc } = server
    if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return
    // The command runs in its own process group (npm → node → esbuild…); stop all of it.
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      proc.kill('SIGTERM')
    }
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          process.kill(-proc.pid!, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }, 3000).unref()
  }

  private launch(p: Preview, config: PreviewServer): DevServer {
    this.killServer(p)
    const { env } = terminalEnv()
    const proc = spawn(env.SHELL || '/bin/zsh', ['-c', config.command], {
      cwd: config.cwd,
      // The card is the browser; keep dev servers from opening another one.
      env: { ...env, BROWSER: 'none', FORCE_COLOR: '0' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const server: DevServer = { config, proc, output: '', status: { state: 'starting' } }
    p.server = server
    p.serverConfig = config
    this.send('preview:server', p.id, server.status)

    let pushTimer: NodeJS.Timeout | null = null
    const onOutput = (chunk: Buffer) => {
      server.output += chunk.toString('utf8').replace(ANSI, '').replace(/\r(?!\n)/g, '\n')
      if (server.output.length > MAX_OUTPUT) server.output = server.output.slice(-MAX_OUTPUT / 2)
      // While it boots, the card shows the latest output.
      if (server.status.state === 'starting' && !pushTimer) {
        pushTimer = setTimeout(() => {
          pushTimer = null
          if (server.status.state === 'starting') this.setServerStatus(p, server, { state: 'starting', tail: tail(server.output, 8) })
        }, 400)
      }
    }
    proc.stdout!.on('data', onOutput)
    proc.stderr!.on('data', onOutput)
    proc.on('error', (err) => {
      server.output += `\n${String(err)}\n`
    })
    proc.on('exit', (code, signal) => {
      server.output += `\n[process exited with ${signal ?? `code ${code}`}]\n`
      this.setServerStatus(p, server, { state: 'exited', exitCode: code, tail: tail(server.output, 8) })
    })
    return server
  }

  private async waitForReady(server: DevServer, timeout: number): Promise<string> {
    const deadline = Date.now() + timeout
    let url = server.config.port ? `http://localhost:${server.config.port}/` : undefined
    while (Date.now() < deadline) {
      if (server.status.state === 'exited') {
        throw new ToolError(`The dev server exited before it was ready.\n\nOutput:\n${tail(server.output, 40)}`)
      }
      url ??= findLocalUrl(server.output)
      if (url && (await portOpen(url))) return url
      await sleep(300)
    }
    throw new ToolError(
      `The dev server wasn't ready after ${Math.round(timeout / 1000)}s. ` +
        (url ? `Nothing is listening at ${url}.` : "It didn't print a local URL; pass `port`.") +
        `\n\nOutput:\n${tail(server.output, 40)}`
    )
  }

  /** Start the card's server and load it once it's up. */
  private async runServer(p: Preview, config: PreviewServer): Promise<string> {
    const server = this.launch(p, config)
    const url = await this.waitForReady(server, 120_000)
    this.setServerStatus(p, server, { state: 'running', url })
    if (p.wc && !p.wc.isDestroyed()) await this.navigate(p as Preview & { wc: WebContents }, url)
    return url
  }

  // ---------- Tools ----------

  async start(terminalId: string, args: { command?: string; name?: string; port?: number; cwd?: string }): Promise<string> {
    const base = this.cwdOf(terminalId)
    if (!base) throw new ToolError('This terminal is not running in VibeCanvas.')
    const config: PreviewServer = args.command?.trim()
      ? { command: args.command.trim(), cwd: args.cwd ? resolve(base, args.cwd) : base, port: args.port }
      : readLaunchConfig(base, args.name)
    if (args.port) config.port = args.port

    // Same command as one of this session's previews: reuse its card.
    const existing = this.linked(terminalId).find(
      (p) => (p.server?.config ?? p.serverConfig)?.command === config.command && (p.server?.config ?? p.serverConfig)?.cwd === config.cwd
    )
    if (existing?.wc && existing.server && existing.server.status.state !== 'exited') {
      const p = existing as Preview & { wc: WebContents }
      return this.act(p, async () => {
        const url = existing.server!.status.url ?? (await this.waitForReady(existing.server!, 120_000))
        const errors = p.errorCount
        await this.navigate(p, url)
        return `The dev server was already running (${config.command}); reloaded it.\n${this.describe(p, errors)}`
      })
    }

    const p = existing?.wc ? (existing as Preview & { wc: WebContents }) : await this.openCard(terminalId, 'about:blank', config)
    return this.act(p, async () => {
      const errors = p.errorCount
      const url = await this.runServer(p, config)
      return `Started \`${config.command}\` in ${config.cwd}; it serves ${url}.\n${this.describe(p, errors)}`
    })
  }

  async open(terminalId: string, args: { url: string; previewId?: string; newCard?: boolean }): Promise<string> {
    const url = normalizeUrl(args.url)
    const target = args.previewId ? this.pick(terminalId, args.previewId) : args.newCard ? undefined : this.linked(terminalId).find((p) => p.wc)
    if (target?.wc) {
      const p = target as Preview & { wc: WebContents }
      return this.act(p, async () => {
        const errors = p.errorCount
        await this.navigate(p, url)
        return this.describe(p, errors)
      })
    }
    const p = await this.openCard(terminalId, url)
    return this.act(p, async () => {
      await this.waitForLoad(p.wc, 20_000)
      return this.describe(p, 0)
    })
  }

  list(terminalId: string): string {
    const all = [...this.previews.values()]
    if (!all.length) return 'No previews on the canvas.'
    return all
      .map((p) => {
        const mine = p.terminalId === terminalId ? 'this session' : p.terminalId ? 'another session' : 'opened by the user'
        const page = p.wc && !p.wc.isDestroyed() ? `"${p.wc.getTitle()}" — ${p.wc.getURL()}` : 'not loaded'
        const server = p.server ? `; dev server ${p.server.status.state}: ${p.server.config.command}` : ''
        return `- ${p.id} (${mine}): ${page}${server}`
      })
      .join('\n')
  }

  async reload(terminalId: string, args: { previewId?: string; ignoreCache?: boolean }): Promise<string> {
    const p = this.pick(terminalId, args.previewId)
    return this.act(p, async () => {
      const errors = p.errorCount
      p.loadError = undefined
      if (args.ignoreCache) p.wc.reloadIgnoringCache()
      else p.wc.reload()
      await sleep(100)
      await this.waitForLoad(p.wc, 20_000)
      return this.describe(p, errors)
    })
  }

  async screenshot(terminalId: string, args: { previewId?: string }): Promise<{ png: string; text: string }> {
    const p = this.pick(terminalId, args.previewId)
    return this.act(p, async () => {
      const vp = (await p.wc.executeJavaScript('({ width: innerWidth, height: innerHeight })')) as { width: number; height: number }
      let image = await p.wc.capturePage()
      if (image.isEmpty()) {
        const shot = await this.cdp<{ data: string }>(p.wc, 'Page.captureScreenshot', { format: 'png' })
        image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
      }
      if (image.isEmpty()) throw new ToolError('The page produced an empty screenshot.')
      // One image pixel per CSS pixel, so coordinates line up with preview_click's x/y.
      const scale = Math.min(1, SCREENSHOT_MAX / Math.max(vp.width, vp.height))
      const width = Math.round(vp.width * scale)
      const height = Math.round(vp.height * scale)
      const size = image.getSize()
      if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'best' })
      const note = scale < 1 ? ` Scaled to ${Math.round(scale * 100)}%: multiply by ${(1 / scale).toFixed(3)} for click coordinates.` : ''
      return {
        png: image.toPNG().toString('base64'),
        text: `${this.describe(p)}\nViewport ${vp.width}×${vp.height}.${note}`
      }
    })
  }

  async snapshot(terminalId: string, args: { previewId?: string }): Promise<string> {
    const p = this.pick(terminalId, args.previewId)
    return this.act(p, async () => {
      const outline = (await p.wc.executeJavaScript(`(${pageSnapshot.toString()})(40000)`)) as string
      return p.loadError ? `Load failed: ${p.loadError}\n${outline}` : outline
    })
  }

  private async locate(p: Preview & { wc: WebContents }, target: Target, mode: 'none' | 'focus' | 'replace') {
    const located = (await p.wc.executeJavaScript(`(${pageLocate.toString()})(${JSON.stringify(target)}, ${JSON.stringify(mode)})`)) as Located
    if ('error' in located) throw new ToolError(located.error)
    return located
  }

  private async mouseClick(wc: WebContents, x: number, y: number, button: 'left' | 'right', clickCount: number): Promise<void> {
    await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let i = 1; i <= clickCount; i++) {
      await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, buttons: button === 'left' ? 1 : 2 })
      await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i })
    }
  }

  async click(
    terminalId: string,
    args: Target & { previewId?: string; x?: number; y?: number; button?: 'left' | 'right'; doubleClick?: boolean }
  ): Promise<string> {
    const p = this.pick(terminalId, args.previewId)
    return this.act(p, async () => {
      let x: number
      let y: number
      let what: string
      let warning = ''
      if (!args.ref && !args.selector && !args.text) {
        if (args.x === undefined || args.y === undefined) throw new ToolError('Pass ref, selector, text, or x and y.')
        ;({ x, y } = args)
        what = `(${x}, ${y})`
      } else {
        const located = await this.locate(p, args, 'none')
        ;({ x, y } = located)
        what = located.description
        if (located.coveredBy) warning = `\nNote: ${located.coveredBy} covers that spot, so it may have received the click.`
      }
      const before = p.wc.getURL()
      const errors = p.errorCount
      await this.mouseClick(p.wc, x, y, args.button ?? 'left', args.doubleClick ? 2 : 1)
      await this.settle(p.wc)
      const after = p.wc.getURL()
      const nav = after !== before ? `\nThe page navigated to ${after}.` : ''
      const newErrors = p.errorCount - errors
      const errorNote = newErrors ? `\n${newErrors} new console error${newErrors > 1 ? 's' : ''}; see preview_console_logs.` : ''
      return `Clicked ${what}.${warning}${nav}${errorNote}`
    })
  }

  async fill(terminalId: string, args: Target & { previewId?: string; value: string; submit?: boolean }): Promise<string> {
    const p = this.pick(terminalId, args.previewId)
    return this.act(p, async () => {
      const located = await this.locate(p, args, 'replace')
      const errors = p.errorCount
      if (located.kind === 'select') {
        const result = (await p.wc.executeJavaScript(`(${pageSelectOption.toString()})(${JSON.stringify(args.value)})`)) as {
          error?: string
          selected?: string
        }
        if (result.error) throw new ToolError(result.error)
        await this.settle(p.wc)
        return `Selected "${result.selected}" in ${located.description}.`
      }
      if (located.kind === 'checkable') throw new ToolError(`${located.description} is a checkbox or radio button; use preview_click.`)
      if (located.kind !== 'text') throw new ToolError(`${located.description} is not a text field.`)
      const value = (await p.wc.executeJavaScript(`(${pageInsertText.toString()})(${JSON.stringify(args.value)})`, true)) as string
      const mismatch = value !== args.value ? `\nThe field now holds ${JSON.stringify(value)}.` : ''
      if (args.submit) await this.pressKey(p.id, p.wc, 'Enter')
      await this.settle(p.wc)
      const newErrors = p.errorCount - errors
      return (
        `Filled ${located.description} with ${JSON.stringify(args.value)}${args.submit ? ' and pressed Enter' : ''}.${mismatch}` +
        (newErrors ? `\n${newErrors} new console error${newErrors > 1 ? 's' : ''}; see preview_console_logs.` : '')
      )
    })
  }

  private async pressKey(id: string, wc: WebContents, combo: string): Promise<void> {
    const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/)
    let name = parts.pop()!
    name = KEY_ALIASES[name] ?? name
    let modifiers = 0
    for (const m of parts) {
      const bit = MODIFIERS[m.toLowerCase()]
      if (bit === undefined) throw new ToolError(`Unknown modifier "${m}". Use Alt, Control, Meta or Shift.`)
      modifiers |= bit
    }
    const named = KEYS[name] ?? KEYS[name[0].toUpperCase() + name.slice(1)]
    let key: string
    let code: string
    let keyCode: number
    let text: string | undefined
    if (named) {
      key = named.key ?? (KEYS[name] ? name : name[0].toUpperCase() + name.slice(1))
      ;({ code, keyCode, text } = named)
    } else if (name.length === 1) {
      key = modifiers & 8 ? name.toUpperCase() : name
      const upper = name.toUpperCase()
      code = /[A-Z]/.test(upper) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : ''
      keyCode = /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0
      text = key
    } else {
      throw new ToolError(`Unknown key "${name}". Use a single character or one of: ${Object.keys(KEYS).join(', ')}.`)
    }
    if (modifiers & (2 | 4)) text = undefined
    const normalized = [modifiers & 4 && 'Meta', modifiers & 8 && 'Shift', name.length === 1 ? name.toLowerCase() : name].filter(Boolean).join('+')
    const command = EDIT_COMMANDS[normalized]
    // Key events only reach a page with keyboard focus. The canvas lends it to the card
    // for the key press, then gives it back to whatever the user was typing in.
    this.send('preview:focus', id)
    for (let i = 0; i < 20 && !wc.isFocused(); i++) await sleep(15)
    await this.cdp(wc, 'Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
      text,
      unmodifiedText: text,
      commands: command ? [command] : undefined
    })
    await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
    this.send('preview:restoreFocus')
  }

  async press(terminalId: string, args: Target & { previewId?: string; key: string }): Promise<string> {
    const p = this.pick(terminalId, args.previewId)
    return this.act(p, async () => {
      const where = args.ref || args.selector || args.text ? ` in ${(await this.locate(p, args, 'focus')).description}` : ''
      const before = p.wc.getURL()
      const errors = p.errorCount
      await this.pressKey(p.id, p.wc, args.key)
      await this.settle(p.wc)
      const after = p.wc.getURL()
      return (
        `Pressed ${args.key}${where}.` +
        (after !== before ? `\nThe page navigated to ${after}.` : '') +
        (p.errorCount > errors ? `\nNew console errors; see preview_console_logs.` : '')
      )
    })
  }

  async evaluate(terminalId: string, args: { previewId?: string; expression: string }): Promise<{ ok: boolean; text: string }> {
    const p = this.pick(terminalId, args.previewId)
    return this.act(p, async () => {
      // Only parsed here (never run in main): an expression gets returned, statements run as a body.
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (body: string) => unknown
      let body = `return (${args.expression}\n)`
      try {
        new AsyncFunction(body)
      } catch {
        body = args.expression
      }
      const code = `(async () => {
        const serialize = (${pageSerialize.toString()});
        try {
          const value = await (async () => { ${body}\n })();
          return { ok: true, text: serialize(value, 20000) };
        } catch (e) {
          return { ok: false, text: e && e.stack ? String(e.stack) : String(e) };
        }
      })()`
      try {
        return (await p.wc.executeJavaScript(code, true)) as { ok: boolean; text: string }
      } catch (err) {
        return { ok: false, text: String(err) }
      }
    })
  }

  consoleLogs(terminalId: string, args: { previewId?: string; level?: string; limit?: number; clear?: boolean }): string {
    const p = this.pick(terminalId, args.previewId)
    const level = args.level ?? 'all'
    const entries = p.console.filter((e) =>
      level === 'all' ? true : level === 'error' ? e.level === 'error' : e.level === 'error' || e.level === 'warning' || e.level === 'navigation'
    )
    const shown = entries.slice(-(args.limit ?? 50))
    if (args.clear) {
      p.console = []
      p.errorCount = 0
    }
    if (!shown.length) return `No ${level === 'all' ? '' : `${level} `}console messages.`
    const time = (t: number) => new Date(t).toTimeString().slice(0, 8)
    const skipped = entries.length - shown.length
    return (
      (skipped ? `(${skipped} earlier messages not shown)\n` : '') +
      shown.map((e) => (e.level === 'navigation' ? `--- ${e.text} ---` : `[${time(e.time)}] ${e.level}: ${e.text}`)).join('\n')
    )
  }

  network(terminalId: string, args: { previewId?: string; filter?: string; failedOnly?: boolean; limit?: number }): string {
    const p = this.pick(terminalId, args.previewId)
    const entries = p.network.filter(
      (e) => (!args.filter || e.url.includes(args.filter)) && (!args.failedOnly || e.error || (e.status ?? 0) >= 400)
    )
    const shown = entries.slice(-(args.limit ?? 50))
    if (!shown.length) return 'No matching requests since the page loaded.'
    return shown
      .map((e) => `${e.method} ${e.error ?? e.status} ${e.type} ${e.url.length > 300 ? `${e.url.slice(0, 300)}…` : e.url}`)
      .join('\n')
  }

  logs(terminalId: string, args: { previewId?: string; lines?: number }): string {
    const p = this.pick(terminalId, args.previewId)
    if (!p.server) {
      return p.serverConfig
        ? `The dev server (${p.serverConfig.command}) isn't running. Start it with preview_start.`
        : 'This preview has no dev server started by preview_start.'
    }
    const { status, config, output } = p.server
    const header = `${config.command} — ${status.state}${status.url ? ` at ${status.url}` : ''}${status.state === 'exited' ? ` (code ${status.exitCode})` : ''}`
    return `${header}\n\n${tail(output, args.lines ?? 80) || '(no output yet)'}`
  }

  async resize(terminalId: string, args: { previewId?: string; width?: number; height?: number; preset?: string }): Promise<string> {
    const p = this.pick(terminalId, args.previewId)
    const preset = args.preset ? PRESETS[args.preset] : undefined
    if (args.preset && !preset) throw new ToolError(`Unknown preset "${args.preset}". Use ${Object.keys(PRESETS).join(', ')}.`)
    const width = Math.round(preset?.width ?? args.width ?? 0)
    const height = Math.round(preset?.height ?? args.height ?? 0)
    if (width < 200 || height < 200 || width > 3000 || height > 3000) throw new ToolError('Width and height must be between 200 and 3000.')
    return this.act(p, async () => {
      this.send('preview:resize', p.id, width, height)
      let vp = { width: 0, height: 0 }
      for (let i = 0; i < 30; i++) {
        await sleep(100)
        vp = (await p.wc.executeJavaScript('({ width: innerWidth, height: innerHeight })')) as typeof vp
        if (vp.width === width && vp.height === height) break
      }
      return `The preview's viewport is now ${vp.width}×${vp.height}.`
    })
  }

  stop(terminalId: string, args: { previewId?: string }): string {
    const p = this.pick(terminalId, args.previewId)
    if (!p.server) return 'This preview has no running dev server.'
    const command = p.server.config.command
    this.killServer(p)
    return `Stopped ${command}. The card stays on the canvas; preview_start starts it again.`
  }
}
