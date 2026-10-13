export interface Project {
  id: string
  name: string
  path: string
}

export type PromptData = {
  text: string
  /** Absolute paths of images attached to the prompt (stored in the app's images folder). */
  images?: string[]
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
  /** True once the session has been launched at least once, so restores use --resume. */
  started: boolean
}

export interface SavedNode {
  id: string
  type: 'prompt' | 'terminal'
  position: { x: number; y: number }
  width?: number
  height?: number
  data: PromptData | TerminalData
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
  notificationType?: string
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
}
