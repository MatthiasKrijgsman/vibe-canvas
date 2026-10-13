import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import type { HookEvent, PtyStartOptions, PtyStartResult } from '../shared/types'
import { terminalEnv } from './env'

type Send = (channel: string, ...args: unknown[]) => void

interface Session {
  proc: pty.IPty
  backlog: string
  pending: string
  flush: NodeJS.Timeout | null
  /** Called with every output chunk; used to wait for Claude Code to react to input. */
  watchers: Set<(chunk: string) => void>
  /** Input sends run one at a time so pastes from different drops never interleave. */
  inputQueue: Promise<void>
  /** First message for a new session, delivered once Claude Code is ready. */
  initialInput?: { text: string; images: string[] }
}

const ANSI = /\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]/g
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`

const BACKLOG_LIMIT = 1_000_000

/** Claude Code events we listen to, to track session ids and show status on the canvas. */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop']

function sessionExists(env: Record<string, string>, sessionId: string): boolean {
  const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  try {
    return readdirSync(root).some((dir) => existsSync(join(root, dir, `${sessionId}.jsonl`)))
  } catch {
    return false
  }
}

export class PtyManager {
  private sessions = new Map<string, Session>()
  private server: Server | null = null
  private port = 0
  private token = randomBytes(16).toString('hex')

  constructor(private send: Send) {}

  /**
   * Local endpoint that Claude Code hooks post to. Each terminal gets its id in the
   * environment, so events can be routed back to the right canvas node.
   */
  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const match = url.pathname.match(/^\/hook\/([\w-]+)$/)
      if (req.method !== 'POST' || !match || url.searchParams.get('t') !== this.token) {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(204).end()
        try {
          const payload = JSON.parse(body)
          const event: HookEvent = {
            id: match[1],
            event: payload.hook_event_name,
            sessionId: payload.session_id,
            notificationType: payload.notification_type
          }
          this.send('pty:hook', event)
          if (event.event === 'SessionStart') this.deliverInitialInput(event.id)
        } catch {
          // ignore malformed payloads
        }
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
  }

  private hookSettings(): string {
    const command =
      `curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- ` +
      `"http://127.0.0.1:$VIBECANVAS_PORT/hook/$VIBECANVAS_TERMINAL?t=$VIBECANVAS_TOKEN" || true`
    const hooks = Object.fromEntries(
      HOOK_EVENTS.map((name) => [name, [{ hooks: [{ type: 'command', command }] }]])
    )
    return JSON.stringify({ hooks })
  }

  start(opts: PtyStartOptions): PtyStartResult {
    const existing = this.sessions.get(opts.id)
    if (existing) {
      existing.proc.resize(opts.cols, opts.rows)
      return { backlog: existing.backlog, running: true }
    }

    const { env, claude } = terminalEnv()
    if (!existsSync(opts.cwd)) {
      return { backlog: '', running: false, error: `Directory not found: ${opts.cwd}` }
    }

    const args = ['--settings', this.hookSettings()]
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    const images = opts.images ?? []
    let initialInput: Session['initialInput']
    // Resume when Claude Code has a transcript for this session; otherwise (e.g. the app
    // quit before the first message was saved) start it fresh under the same id.
    if (opts.mode === 'resume' && sessionExists(env, opts.sessionId)) {
      args.push('--resume', opts.sessionId)
    } else {
      args.push('--session-id', opts.sessionId)
      if (images.length) {
        // Images only become attachments when pasted into the input, so start empty and
        // send the first message once the session reports it is ready.
        initialInput = { text: opts.prompt ?? '', images }
      } else if (opts.prompt?.trim()) {
        args.push('--', opts.prompt)
      }
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(claude, args, {
        name: 'xterm-256color',
        cols: Math.max(opts.cols, 20),
        rows: Math.max(opts.rows, 5),
        cwd: opts.cwd,
        env: {
          ...env,
          VIBECANVAS_PORT: String(this.port),
          VIBECANVAS_TERMINAL: opts.id,
          VIBECANVAS_TOKEN: this.token
        }
      })
    } catch (err) {
      return { backlog: '', running: false, error: `Failed to start claude: ${String(err)}` }
    }

    const session: Session = {
      proc,
      backlog: '',
      pending: '',
      flush: null,
      watchers: new Set(),
      inputQueue: Promise.resolve(),
      initialInput
    }
    this.sessions.set(opts.id, session)

    // Batch output so a burst of tiny chunks becomes one IPC message per frame.
    proc.onData((data) => {
      session.watchers.forEach((watch) => watch(data))
      session.backlog += data
      if (session.backlog.length > BACKLOG_LIMIT) {
        session.backlog = session.backlog.slice(-BACKLOG_LIMIT / 2)
      }
      session.pending += data
      session.flush ??= setTimeout(() => {
        this.send('pty:data', opts.id, session.pending)
        session.pending = ''
        session.flush = null
      }, 8)
    })
    proc.onExit(({ exitCode }) => {
      if (session.flush) clearTimeout(session.flush)
      if (session.pending) this.send('pty:data', opts.id, session.pending)
      if (this.sessions.get(opts.id) === session) this.sessions.delete(opts.id)
      this.send('pty:exit', opts.id, exitCode)
    })

    return { backlog: '', running: true }
  }

  private deliverInitialInput(id: string): void {
    const session = this.sessions.get(id)
    const input = session?.initialInput
    if (!session || !input) return
    session.initialInput = undefined
    // Give the input box a moment to mount after the hook fires.
    setTimeout(() => this.sendInput(id, input.text, input.images, true), 300)
  }

  /** Resolve once the screen output since the call matches `pattern`, or after `timeout`. */
  private waitForOutput(session: Session, pattern: RegExp, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      let seen = ''
      const done = (matched: boolean) => {
        clearTimeout(timer)
        session.watchers.delete(watch)
        resolve(matched)
      }
      const watch = (chunk: string) => {
        seen = (seen + chunk).slice(-4000)
        if (pattern.test(seen.replace(ANSI, ''))) done(true)
      }
      const timer = setTimeout(() => done(false), timeout)
      session.watchers.add(watch)
    })
  }

  /** Resolve once no output has arrived for `quiet` ms (or after `timeout`). */
  private waitForQuiet(session: Session, quiet: number, timeout: number): Promise<void> {
    return new Promise((resolve) => {
      let idle = setTimeout(done, quiet)
      const cap = setTimeout(done, timeout)
      const watch = () => {
        clearTimeout(idle)
        idle = setTimeout(done, quiet)
      }
      function done() {
        clearTimeout(idle)
        clearTimeout(cap)
        session.watchers.delete(watch)
        resolve()
      }
      session.watchers.add(watch)
    })
  }

  /**
   * Type a message into Claude Code: each image path is pasted on its own (Claude Code
   * turns a pasted image path into an [Image #N] attachment), then the text, then Enter.
   */
  sendInput(id: string, text: string, images: string[], submit: boolean): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.inputQueue = session.inputQueue.then(async () => {
      for (const image of images) {
        if (!existsSync(image)) continue
        const attached = this.waitForOutput(session, /Image\s*#\d+/, 5000)
        session.proc.write(paste(image))
        await attached
        // The label appears while Claude Code is still processing the image ("Pasting…").
        await this.waitForQuiet(session, 250, 3000)
      }
      const body = text.replace(/\r\n?/g, '\n')
      if (body.trim()) {
        session.proc.write(paste(images.length ? ` ${body}` : body))
        await sleep(80)
      }
      if (submit && (body.trim() || images.length)) session.proc.write('\r')
    }).catch(() => undefined)
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    try {
      this.sessions.get(id)?.proc.resize(cols, rows)
    } catch {
      // the process may have just exited
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.proc.kill()
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
    this.server?.close()
  }
}
