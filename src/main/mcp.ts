import type { ServerResponse } from 'node:http'
import { PRESETS, ToolError, type PreviewManager } from './preview'

// A minimal MCP server (Streamable HTTP, JSON responses only) that gives each Claude Code
// session tools for the preview cards on the canvas. Sessions reach it at /mcp/<terminal id>.

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
interface ToolResult {
  content: Content[]
  isError?: boolean
}

type Args = Record<string, unknown>

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (previews: PreviewManager, terminalId: string, args: Args) => Promise<ToolResult | string> | ToolResult | string
}

const SERVER_NAME = 'vibecanvas'

const INSTRUCTIONS = `VibeCanvas shows web pages to the user as preview cards on their canvas, connected to this session by a line.
To check a web UI you are building, start the project's dev server with preview_start (prefer this over running the dev server through Bash: the user sees the page, and its output stays available through preview_logs), or show a URL or local HTML file with preview_open.
Then verify changes the way the user will see them: preview_screenshot to look at the page, preview_snapshot to read its structure and get element refs, preview_click / preview_fill / preview_press_key to interact, preview_console_logs and preview_network to find errors.
The tools act on this session's most recently used preview unless you pass previewId.`

const previewId = { type: 'string', description: "Which preview to act on (see preview_list). Defaults to this session's most recently used one." }
const target = {
  ref: { type: 'string', description: 'Element ref from the latest preview_snapshot, like "e12". Most reliable.' },
  selector: { type: 'string', description: 'CSS selector.' },
  text: { type: 'string', description: 'Visible text of the element (case-insensitive substring).' }
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown) => v === true
const targetOf = (a: Args) => ({ ref: str(a.ref), selector: str(a.selector), text: str(a.text), previewId: str(a.previewId) })

const TOOLS: Tool[] = [
  {
    name: 'preview_start',
    description:
      "Start the project's dev server and show it in a preview card on the canvas. Waits until the server answers, then loads it. " +
      'Pass `command` (run in the project directory, e.g. "npm run dev"), or `name` of a configuration in .claude/launch.json. ' +
      'The URL is read from the server output; pass `port` if it doesn\'t print one. Calling it again with the same command reuses the card and the running server.',
    inputSchema: schema({
      command: { type: 'string', description: 'Shell command that starts the dev server.' },
      name: { type: 'string', description: 'Configuration name in .claude/launch.json, used when command is omitted.' },
      port: { type: 'number', description: 'Port the server listens on, if its output has no URL.' },
      cwd: { type: 'string', description: 'Directory to run in, relative to the project. Defaults to the project root.' }
    }),
    run: (m, t, a) => m.start(t, { command: str(a.command), name: str(a.name), port: num(a.port), cwd: str(a.cwd) })
  },
  {
    name: 'preview_open',
    description:
      "Show a URL (or an absolute path to a local HTML file) in this session's preview card, creating the card if there is none. " +
      'Pass newCard to open a separate card next to the existing one.',
    inputSchema: schema(
      {
        url: { type: 'string', description: 'http(s) URL, "localhost:3000", or an absolute file path.' },
        previewId,
        newCard: { type: 'boolean', description: 'Open in a new card instead of reusing the current one.' }
      },
      ['url']
    ),
    run: (m, t, a) => m.open(t, { url: String(a.url ?? ''), previewId: str(a.previewId), newCard: bool(a.newCard) })
  },
  {
    name: 'preview_list',
    description: 'List the preview cards on the canvas with their ids, pages and dev servers.',
    inputSchema: schema({}),
    run: (m, t) => m.list(t)
  },
  {
    name: 'preview_screenshot',
    description: 'Take a screenshot of what the preview shows (its visible viewport). Image pixels match CSS pixels for preview_click x/y.',
    inputSchema: schema({ previewId }),
    run: async (m, t, a) => {
      const shot = await m.screenshot(t, { previewId: str(a.previewId) })
      return { content: [{ type: 'image', data: shot.png, mimeType: 'image/png' }, { type: 'text', text: shot.text }] }
    }
  },
  {
    name: 'preview_snapshot',
    description:
      'Read the page as an outline of its visible content: headings, text, links, buttons and form fields, with refs (like e12) to pass to preview_click and preview_fill. ' +
      'Cheaper and more precise than a screenshot for checking content.',
    inputSchema: schema({ previewId }),
    run: (m, t, a) => m.snapshot(t, { previewId: str(a.previewId) })
  },
  {
    name: 'preview_click',
    description: 'Click an element (by ref, selector or text) or a point (x, y in CSS pixels, as in the screenshot). Scrolls the element into view first.',
    inputSchema: schema({
      ...target,
      x: { type: 'number' },
      y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right'] },
      doubleClick: { type: 'boolean' },
      previewId
    }),
    run: (m, t, a) =>
      m.click(t, {
        ...targetOf(a),
        x: num(a.x),
        y: num(a.y),
        button: a.button === 'right' ? 'right' : 'left',
        doubleClick: bool(a.doubleClick)
      })
  },
  {
    name: 'preview_fill',
    description:
      'Replace the value of a text field, textarea or contenteditable element by typing into it, or choose an option of a <select> (by value or label). ' +
      'Set submit to press Enter afterwards.',
    inputSchema: schema({ ...target, value: { type: 'string' }, submit: { type: 'boolean' }, previewId }, ['value']),
    run: (m, t, a) => m.fill(t, { ...targetOf(a), value: String(a.value ?? ''), submit: bool(a.submit) })
  },
  {
    name: 'preview_press_key',
    description:
      'Press a key in the page, optionally focusing an element first. Keys: a character, Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, ' +
      'with modifiers like "Shift+Tab" or "Meta+a".',
    inputSchema: schema({ key: { type: 'string' }, ...target, previewId }, ['key']),
    run: (m, t, a) => m.press(t, { ...targetOf(a), key: String(a.key ?? '') })
  },
  {
    name: 'preview_eval',
    description:
      'Run JavaScript in the page and return the result as JSON. Takes an expression ("document.title") or statements with a return; await works.',
    inputSchema: schema({ expression: { type: 'string' }, previewId }, ['expression']),
    run: async (m, t, a) => {
      const result = await m.evaluate(t, { expression: String(a.expression ?? ''), previewId: str(a.previewId) })
      return { content: [{ type: 'text', text: result.text }], isError: !result.ok }
    }
  },
  {
    name: 'preview_console_logs',
    description: "Read the page's console output, including uncaught errors, newest last.",
    inputSchema: schema({
      level: { type: 'string', enum: ['all', 'warning', 'error'], description: 'warning includes errors. Default all.' },
      limit: { type: 'number', description: 'Most recent messages to return (default 50).' },
      clear: { type: 'boolean', description: 'Clear the messages after reading them.' },
      previewId
    }),
    run: (m, t, a) =>
      m.consoleLogs(t, { level: str(a.level), limit: num(a.limit), clear: bool(a.clear), previewId: str(a.previewId) })
  },
  {
    name: 'preview_network',
    description: 'List the network requests the page made since it loaded: method, status (or error), type and URL.',
    inputSchema: schema({
      filter: { type: 'string', description: 'Only URLs containing this text.' },
      failedOnly: { type: 'boolean', description: 'Only failed requests and 4xx/5xx responses.' },
      limit: { type: 'number', description: 'Most recent requests to return (default 50).' },
      previewId
    }),
    run: (m, t, a) =>
      m.network(t, { filter: str(a.filter), failedOnly: bool(a.failedOnly), limit: num(a.limit), previewId: str(a.previewId) })
  },
  {
    name: 'preview_logs',
    description: 'Read the output of the dev server started with preview_start (build errors, server logs).',
    inputSchema: schema({ lines: { type: 'number', description: 'Last lines to return (default 80).' }, previewId }),
    run: (m, t, a) => m.logs(t, { lines: num(a.lines), previewId: str(a.previewId) })
  },
  {
    name: 'preview_reload',
    description: 'Reload the page.',
    inputSchema: schema({ ignoreCache: { type: 'boolean' }, previewId }),
    run: (m, t, a) => m.reload(t, { ignoreCache: bool(a.ignoreCache), previewId: str(a.previewId) })
  },
  {
    name: 'preview_resize',
    description: `Resize the preview card so the page's viewport has the given size, e.g. to check a mobile layout. Presets: ${Object.entries(PRESETS)
      .map(([k, v]) => `${k} (${v.width}×${v.height})`)
      .join(', ')}.`,
    inputSchema: schema({
      width: { type: 'number' },
      height: { type: 'number' },
      preset: { type: 'string', enum: Object.keys(PRESETS) },
      previewId
    }),
    run: (m, t, a) => m.resize(t, { width: num(a.width), height: num(a.height), preset: str(a.preset), previewId: str(a.previewId) })
  },
  {
    name: 'preview_stop',
    description: "Stop the preview's dev server. The card stays on the canvas.",
    inputSchema: schema({ previewId }),
    run: (m, t, a) => m.stop(t, { previewId: str(a.previewId) })
  }
]

/** Everything but preview_start, which runs a command and so asks for permission like Bash. */
export const PREVIEW_TOOLS_ALLOWED = TOOLS.filter((t) => t.name !== 'preview_start').map((t) => `mcp__${SERVER_NAME}__${t.name}`)

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

async function callTool(previews: PreviewManager, terminalId: string, params: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === params.name)
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${String(params.name)}` }], isError: true }
  try {
    const result = await tool.run(previews, terminalId, (params.arguments as Args) ?? {})
    return typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result
  } catch (err) {
    const text = err instanceof ToolError ? err.message : `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`
    return { content: [{ type: 'text', text }], isError: true }
  }
}

async function dispatch(previews: PreviewManager, terminalId: string, req: RpcRequest): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, title: 'VibeCanvas previews', version: '1.0.0' },
        instructions: INSTRUCTIONS
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
    case 'tools/call':
      return callTool(previews, terminalId, req.params ?? {})
    default:
      throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 })
  }
}

export async function handleMcp(previews: PreviewManager, terminalId: string, body: string, res: ServerResponse): Promise<void> {
  let message: RpcRequest | RpcRequest[]
  try {
    message = JSON.parse(body)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }
  const batch = Array.isArray(message)
  const requests: RpcRequest[] = Array.isArray(message) ? message : [message]
  const responses = (
    await Promise.all(
      requests.map(async (req) => {
        // Notifications (no id) get no response.
        if (req.id === undefined || req.id === null) return null
        try {
          return { jsonrpc: '2.0', id: req.id, result: await dispatch(previews, terminalId, req) }
        } catch (err) {
          const code = (err as { code?: number }).code ?? -32603
          return { jsonrpc: '2.0', id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } }
        }
      })
    )
  ).filter(Boolean)
  if (!responses.length) {
    res.writeHead(202).end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(batch ? responses : responses[0]))
}
