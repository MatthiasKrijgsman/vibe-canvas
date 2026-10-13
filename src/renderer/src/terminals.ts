import { useSyncExternalStore } from 'react'
import type { HookEvent, TerminalStatus } from '../../shared/types'

// One IPC subscription per channel, fanned out to the terminal node that owns each id.
const dataListeners = new Map<string, (data: string) => void>()
const hookListeners = new Map<string, (event: HookEvent) => void>()
const globalHookListeners = new Set<(event: HookEvent) => void>()

// Status of every terminal, shared by the terminal nodes and the canvas (prompt runs).
const statuses = new Map<string, TerminalStatus>()
const statusSubscribers = new Set<() => void>()

export function setTerminalStatus(id: string, status: TerminalStatus): void {
  if (statuses.get(id) === status) return
  statuses.set(id, status)
  statusSubscribers.forEach((notify) => notify())
}

export const getTerminalStatus = (id: string): TerminalStatus => statuses.get(id) ?? 'starting'

export function useTerminalStatus(id: string): TerminalStatus {
  return useSyncExternalStore(
    (notify) => {
      statusSubscribers.add(notify)
      return () => statusSubscribers.delete(notify)
    },
    () => getTerminalStatus(id)
  )
}

const HOOK_STATUS: Record<string, TerminalStatus> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  Notification: 'attention',
  Stop: 'idle'
}

window.canvas.pty.onData((id, data) => {
  dataListeners.get(id)?.(data)
  // Without hooks (e.g. curl missing) output is the only sign the session is up.
  if (getTerminalStatus(id) === 'starting') setTerminalStatus(id, 'idle')
})
window.canvas.pty.onExit((id) => setTerminalStatus(id, 'exited'))
window.canvas.pty.onHook((event) => {
  const status = HOOK_STATUS[event.event]
  if (status) setTerminalStatus(event.id, status)
  hookListeners.get(event.id)?.(event)
  globalHookListeners.forEach((listener) => listener(event))
})

function register<T>(map: Map<string, T>, id: string, listener: T): () => void {
  map.set(id, listener)
  return () => {
    if (map.get(id) === listener) map.delete(id)
  }
}

export const onTerminalData = (id: string, cb: (data: string) => void) => register(dataListeners, id, cb)
export const onTerminalHook = (id: string, cb: (e: HookEvent) => void) => register(hookListeners, id, cb)

export function onAnyTerminalHook(cb: (e: HookEvent) => void): () => void {
  globalHookListeners.add(cb)
  return () => globalHookListeners.delete(cb)
}

/** Subscribe to status changes of all terminals. */
export function onTerminalStatusChange(cb: () => void): () => void {
  statusSubscribers.add(cb)
  return () => statusSubscribers.delete(cb)
}

/**
 * Send a prompt to a running Claude Code session: images are pasted first (each becomes
 * an [Image #N] attachment), then the text, then Enter. Sequencing happens in main.
 */
export function sendPrompt(id: string, text: string, images: string[] = []): void {
  window.canvas.pty.send(id, text, images, true)
}
