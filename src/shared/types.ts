export interface Project {
  id: string
  name: string
  path: string
}

export type PromptData = {
  text: string
  /** Absolute paths of images attached to the prompt (stored in the app's images folder). */
  images?: string[]
  /** Set when Claude finished the last run of this prompt; cleared on edit or a new run. */
  completed?: boolean
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type TerminalStatus = 'starting' | 'working' | 'idle' | 'attention' | 'exited'

export type TerminalData = {
  projectId: string
  cwd: string
  /** Claude Code session id; kept current through the SessionStart hook. */
  sessionId: string
  /** Last title Claude Code set via OSC escape. */
  title?: string
  /** Prompt to submit when the session is first created. */
  initialPrompt?: string
  /** Images to attach to the first message. */
  initialImages?: string[]
  /** --model / --effort the session runs with (also applied when resuming). */
  model?: string
  effort?: Effort
  /**
   * Run in a new git worktree (--worktree). Once Claude Code reports the worktree it made,
   * `cwd` points into it, so restores resume there.
   */
  worktree?: boolean
  /** --remote-control: the session can also be driven from claude.ai and the Claude app. */
  remoteControl?: boolean
  /** True once the session has been launched at least once, so restores use --resume. */
  started: boolean
}

/** How to (re)start the dev server behind a preview. */
export interface PreviewServer {
  command: string
  cwd: string
  /** Port to wait for when the command doesn't print its URL. */
  port?: number
}

export type PreviewData = {
  /** Last page the preview showed; reloaded when the canvas is restored. */
  url: string
  /** The terminal whose Claude Code session opened this preview, drawn as a connecting line. */
  terminalId?: string
  /** Dev server started for this preview, so it can be started again after a restart. */
  server?: PreviewServer
}

export type DocumentData = {
  /** Absolute path of the markdown file the card shows. */
  path: string
  /** The terminal whose Claude Code session opened this document, drawn as a connecting line. */
  terminalId?: string
}

/** A document card's file as it is now: its text, or why it can't be shown. */
export interface DocumentContent {
  text?: string
  error?: string
}

/** Main asks the canvas to show a new document card. */
export interface DocumentOpenRequest {
  id: string
  path: string
  terminalId?: string
}

export interface SavedNode {
  id: string
  type: 'prompt' | 'terminal' | 'preview' | 'document'
  position: { x: number; y: number }
  width?: number
  height?: number
  data: PromptData | TerminalData | PreviewData | DocumentData
}

export interface CanvasState {
  version: 1
  projects: Project[]
  nodes: SavedNode[]
  viewport: { x: number; y: number; zoom: number }
}

export interface PtyStartOptions {
  id: string
  cwd: string
  sessionId: string
  /** 'new' starts a session with --session-id, 'resume' reattaches with --resume. */
  mode: 'new' | 'resume'
  prompt?: string
  images?: string[]
  model?: string
  effort?: Effort
  /** Create a new git worktree; ignored when `cwd` already is one Claude Code created. */
  worktree?: boolean
  remoteControl?: boolean
  cols: number
  rows: number
}

export interface PtyStartResult {
  /** Output produced before this renderer attached (e.g. after a reload). */
  backlog: string
  running: boolean
  error?: string
}

export interface HookEvent {
  id: string
  event: string
  sessionId?: string
  /** Directory the session runs in, which differs from the project for worktree sessions. */
  cwd?: string
  notificationType?: string
}

/** Main asks the canvas to show a new preview card. */
export interface PreviewOpenRequest {
  id: string
  url: string
  terminalId?: string
  server?: PreviewServer
}

export interface ServerStatus {
  state: 'starting' | 'running' | 'exited'
  url?: string
  exitCode?: number | null
  /** Last lines of output, shown while starting or after the server exited. */
  tail?: string
}

export interface CanvasApi {
  loadState(): Promise<CanvasState | null>
  saveState(state: CanvasState): void
  saveStateSync(state: CanvasState): void
  pickDirectory(): Promise<string | null>
  homeDir: string
  /** Copy image bytes into the app's images folder; resolves to the saved file's path. */
  saveImage(data: ArrayBuffer, ext: string): Promise<string>
  /** Claude Code's own /config theme, which decides the colors its TUI draws with. */
  claudeTheme: 'dark' | 'light' | 'system'
  pty: {
    start(opts: PtyStartOptions): Promise<PtyStartResult>
    write(id: string, data: string): void
    /** Paste images and text into Claude Code's input, optionally pressing Enter. */
    send(id: string, text: string, images: string[], submit: boolean): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(cb: (id: string, data: string) => void): () => void
    onExit(cb: (id: string, code: number) => void): () => void
    onHook(cb: (e: HookEvent) => void): () => void
  }
  preview: {
    /** Register a card's webview with main, which drives it for Claude's preview tools. */
    attach(id: string, webContentsId: number, data: PreviewData): void
    detach(id: string, webContentsId: number): void
    /** The card was removed: stop its dev server. */
    close(id: string): void
    /** (Re)start the card's dev server and load it once it is up. */
    startServer(id: string): Promise<{ error?: string }>
    stopServer(id: string): void
    onOpen(cb: (req: PreviewOpenRequest) => void): () => void
    onResize(cb: (id: string, width: number, height: number) => void): () => void
    /** True while one of Claude's preview tools is acting on the card. */
    onActivity(cb: (id: string, active: boolean) => void): () => void
    onServer(cb: (id: string, status: ServerStatus | null) => void): () => void
    /** A tool needs keyboard focus in a card for a key press, then gives it back. */
    onFocus(cb: (id: string) => void): () => void
    onRestoreFocus(cb: () => void): () => void
  }
  document: {
    /** A card shows this file: read it, and get its changes through onContent. */
    watch(id: string, data: DocumentData): Promise<DocumentContent>
    unwatch(id: string): void
    /**
     * Follow a link in a card. Resolves to the path of a markdown file to show in the card;
     * web links and other files open in their own app (and resolve to null).
     */
    openLink(from: string, href: string): Promise<string | null>
    /** Open the file in the app the system uses for it. */
    openInApp(path: string): void
    onOpen(cb: (req: DocumentOpenRequest) => void): () => void
    onContent(cb: (id: string, content: DocumentContent) => void): () => void
  }
}
