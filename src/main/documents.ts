import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DocumentContent, DocumentData } from '../shared/types'
import { ToolError } from './preview'

/** Delivers a message to the canvas; false when there is no window to show it. */
type Send = (channel: string, ...args: unknown[]) => boolean

interface Doc {
  id: string
  path: string
  terminalId?: string
  watcher: FSWatcher | null
  text?: string
  timer: NodeJS.Timeout | null
}

const MARKDOWN = /\.(md|markdown|mdx)$/i
const MAX_SIZE = 2 * 1024 * 1024
/** Claude Code's file tools; a plan-mode write through one of them is the session's plan. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path)
const inside = (dir: string, path: string) => {
  const rel = relative(dir, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function read(path: string): DocumentContent {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { error: `${path} is not a file.` }
    if (stat.size > MAX_SIZE) return { error: `${basename(path)} is too large to show (${Math.round(stat.size / 1024)} KB).` }
    return { text: readFileSync(path, 'utf8') }
  } catch {
    return { error: `${path} doesn't exist (anymore).` }
  }
}

/**
 * Markdown cards on the canvas: each shows a file rendered and follows its changes.
 * Claude opens them with markdown_open, and plans written in plan mode open by themselves.
 */
export class DocumentManager {
  private docs = new Map<string, Doc>()
  private watchWaiters = new Map<string, () => void>()
  private activityTimers = new Map<string, NodeJS.Timeout>()
  /** Plans whose card is on its way, so quick successive writes don't open it twice. */
  private openingPlans = new Set<string>()

  constructor(
    private send: Send,
    private cwdOf: (terminalId: string) => string | undefined
  ) {}

  /** A local markdown file named by a path or file:// URL (as preview_open may get one), else null. */
  static markdownPath(input: string): string | null {
    const value = input.trim()
    let path: string
    if (/^file:/i.test(value)) {
      try {
        path = fileURLToPath(value)
      } catch {
        return null
      }
    } else if (value.startsWith('/') || value.startsWith('~')) {
      path = expandHome(value)
    } else {
      return null
    }
    return MARKDOWN.test(path) ? path : null
  }

  // ---------- The canvas side ----------

  /** A card mounted (or now shows another file): follow its file and return what's in it. */
  watch(id: string, data: DocumentData): DocumentContent {
    this.unwatch(id)
    const doc: Doc = { id, path: data.path, terminalId: data.terminalId, watcher: null, timer: null }
    this.docs.set(id, doc)
    const content = read(doc.path)
    doc.text = content.text
    // Watch the folder rather than the file: editors (and Claude) often save by replacing it.
    try {
      doc.watcher = watch(dirname(doc.path), (_event, name) => {
        if (name && name.toString() !== basename(doc.path)) return
        if (doc.timer) clearTimeout(doc.timer)
        doc.timer = setTimeout(() => this.refresh(doc), 80)
      })
      doc.watcher.on('error', () => undefined)
    } catch {
      // The folder is gone; the card shows the error from read().
    }
    this.watchWaiters.get(id)?.()
    return content
  }

  unwatch(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    doc.watcher?.close()
    if (doc.timer) clearTimeout(doc.timer)
    this.docs.delete(id)
  }

  private refresh(doc: Doc): void {
    doc.timer = null
    if (this.docs.get(doc.id) !== doc) return
    const content = read(doc.path)
    if (content.text !== undefined && content.text === doc.text) return
    doc.text = content.text
    this.send('document:content', doc.id, content)
    if (doc.terminalId) this.pulse(doc.id)
  }

  /** A link in a card: markdown files open in the card (returns the path), anything else in its app. */
  async openLink(from: string, href: string): Promise<string | null> {
    if (/^(https?|mailto):/i.test(href)) {
      await shell.openExternal(href)
      return null
    }
    let target = href.replace(/[?#].*$/, '')
    try {
      target = decodeURIComponent(target)
    } catch {
      // keep it as written
    }
    if (!target) return null
    const path = DocumentManager.markdownPath(target) ?? resolve(dirname(from), expandHome(target))
    if (MARKDOWN.test(path) && existsSync(path)) return path
    if (existsSync(path)) await shell.openPath(path)
    return null
  }

  openInApp(path: string): void {
    shell.openPath(path).catch(() => undefined)
  }

  // ---------- Claude's side ----------

  /** Light up the card and its line for a moment, as preview cards do while Claude uses them. */
  private pulse(id: string): void {
    clearTimeout(this.activityTimers.get(id))
    this.send('preview:activity', id, true)
    this.activityTimers.set(
      id,
      setTimeout(() => this.send('preview:activity', id, false), 900)
    )
  }

  private resolvePath(terminalId: string, input: string): string {
    const raw = input.trim()
    if (!raw) throw new ToolError('Pass the path of the markdown file to show.')
    const fromUrl = DocumentManager.markdownPath(raw)
    if (fromUrl) return fromUrl
    const path = expandHome(raw)
    if (isAbsolute(path)) return path
    const base = this.cwdOf(terminalId)
    if (!base) throw new ToolError('Pass an absolute path; this terminal is not running in VibeCanvas.')
    return resolve(base, path)
  }

  /** Ask the canvas for a card and wait until it is following the file. */
  private async openCard(terminalId: string | undefined, path: string): Promise<string> {
    const id = `doc-${randomUUID()}`
    const watching = new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 15_000)
      this.watchWaiters.set(id, () => {
        clearTimeout(timer)
        done(true)
      })
    })
    if (!this.send('document:open', { id, path, terminalId })) {
      this.watchWaiters.delete(id)
      throw new ToolError('VibeCanvas has no window open to show the document in.')
    }
    const ok = await watching
    this.watchWaiters.delete(id)
    if (!ok) throw new ToolError("The canvas didn't open the document card.")
    return id
  }

  async open(terminalId: string, args: { path: string; newCard?: boolean }): Promise<string> {
    const path = this.resolvePath(terminalId, args.path)
    const content = read(path)
    if (content.error) throw new ToolError(content.error)
    const existing = args.newCard ? undefined : [...this.docs.values()].find((d) => d.path === path)
    if (existing) {
      this.pulse(existing.id)
      return `${path} is already open in card ${existing.id}; it shows the file as it is now and follows its changes.`
    }
    const id = await this.openCard(terminalId, path)
    this.pulse(id)
    return `Showing ${path} rendered in card ${id} next to this session. It updates by itself whenever the file changes.`
  }

  /**
   * Every PostToolUse hook from a session. The plan Claude writes in plan mode opens in a
   * card, so the user can read it rendered while deciding whether to accept it.
   */
  onToolUse(terminalId: string, payload: Record<string, unknown>): void {
    const input = payload.tool_input as Record<string, unknown> | undefined
    let file: string
    if (payload.tool_name === 'ExitPlanMode') {
      // Claude Code passes the plan's file along when asking to leave plan mode.
      file = typeof input?.planFilePath === 'string' ? input.planFilePath : ''
    } else if (WRITE_TOOLS.has(String(payload.tool_name))) {
      file = typeof input?.file_path === 'string' ? input.file_path : ''
      const plansDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plans')
      // Plan mode only lets Claude write its plan file, wherever `plansDirectory` puts it.
      if (payload.permission_mode !== 'plan' && !inside(plansDir, file)) return
    } else {
      return
    }
    if (!MARKDOWN.test(file) || !isAbsolute(file) || !existsSync(file)) return
    if (this.openingPlans.has(file) || [...this.docs.values()].some((d) => d.path === file)) return
    this.openingPlans.add(file)
    this.openCard(terminalId, file)
      .then((id) => this.pulse(id), () => undefined)
      .finally(() => this.openingPlans.delete(file))
  }
}
