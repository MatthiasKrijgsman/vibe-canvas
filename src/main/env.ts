import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// API credentials would switch Claude Code from your subscription to API billing.
const STRIPPED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ELECTRON_RUN_AS_NODE']

// When the app itself is started from a Claude Code session, these would leak into
// every terminal and make Claude Code behave as a child process (e.g. no transcripts).
const isSessionVar = (key: string) =>
  key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_SDK') || key === 'CLAUDE_PID'

function clean(env: NodeJS.ProcessEnv, dropSessionVars: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || STRIPPED.includes(k) || (dropSessionVars && isSessionVar(k))) continue
    out[k] = v
  }
  return out
}

/** Just enough to start a login shell, like a freshly opened Terminal window. */
function baseEnv(): Record<string, string> {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!
  return env
}

/**
 * Read the user's login shell environment once (PATH, nvm, etc.) and use it for every
 * terminal. Starting from a minimal env means only what your shell profile sets is
 * inherited, regardless of how the app was launched.
 */
function loadShellEnv(): Record<string, string> {
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__VIBECANVAS_ENV__'
  try {
    const out = execFileSync(shell, ['-ilc', `printf '${marker}'; env -0`], {
      encoding: 'utf8',
      timeout: 10_000,
      env: baseEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const body = out.slice(out.indexOf(marker) + marker.length)
    const env: Record<string, string> = {}
    for (const entry of body.split('\0')) {
      const i = entry.indexOf('=')
      if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1)
    }
    if (env.PATH) return clean(env, false)
  } catch {
    // fall through to the process environment
  }
  return clean(process.env, true)
}

let cached: { env: Record<string, string>; claude: string } | null = null

export function terminalEnv(): { env: Record<string, string>; claude: string } {
  if (cached) return cached
  const env = loadShellEnv()
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.LANG ||= 'en_US.UTF-8'

  const candidates = [
    ...(env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'claude')),
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
  const claude = candidates.find((p) => existsSync(p)) ?? 'claude'
  cached = { env, claude }
  return cached
}
