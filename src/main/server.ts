import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface Request {
  match: RegExpMatchArray
  url: URL
  body: string
}

type Handler = (req: Request, res: ServerResponse) => void | Promise<void>

const MAX_BODY = 10 * 1024 * 1024

/**
 * The local endpoint Claude Code sessions talk back to: hooks, the preview MCP server and
 * the $BROWSER shim. Every request must carry the token, so web pages (including the ones
 * shown in previews) can't reach it.
 */
export class LocalServer {
  readonly token = randomBytes(16).toString('hex')
  port = 0
  private server: Server | null = null
  private routes: { method: string; pattern: RegExp; handler: Handler }[] = []

  route(method: string, pattern: RegExp, handler: Handler): void {
    this.routes.push({ method, pattern, handler })
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}?t=${this.token}`
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const matches = this.routes.filter((r) => r.pattern.test(url.pathname))
    if (url.searchParams.get('t') !== this.token || !matches.length) {
      res.writeHead(404).end()
      return
    }
    const route = matches.find((r) => r.method === req.method)
    if (!route) {
      res.writeHead(405, { Allow: matches.map((r) => r.method).join(', ') }).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > MAX_BODY) req.destroy()
    })
    req.on('end', async () => {
      try {
        await route.handler({ match: url.pathname.match(route.pattern)!, url, body }, res)
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(String(err))
      }
    })
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
  }

  close(): void {
    this.server?.close()
  }
}
