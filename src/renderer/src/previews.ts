import { useSyncExternalStore } from 'react'
import type { ServerStatus } from '../../shared/types'

// Live state of preview cards that main reports: whether one of Claude's tools is acting
// on a card, and its dev server.
const active = new Set<string>()
const servers = new Map<string, ServerStatus>()
const subscribers = new Set<() => void>()
const resizeListeners = new Map<string, (width: number, height: number) => void>()
const focusListeners = new Map<string, () => void>()

const notify = () => subscribers.forEach((cb) => cb())
const subscribe = (cb: () => void) => {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

window.canvas.preview.onActivity((id, on) => {
  if (on === active.has(id)) return
  if (on) active.add(id)
  else active.delete(id)
  notify()
})
window.canvas.preview.onServer((id, status) => {
  if (status) servers.set(id, status)
  else servers.delete(id)
  notify()
})
window.canvas.preview.onResize((id, width, height) => resizeListeners.get(id)?.(width, height))

// Where keyboard focus was before Claude pressed a key in a card (which needs focus for a
// moment), so it can go back there.
let lendingFrom: HTMLElement | null = null
window.canvas.preview.onFocus((id) => {
  const current = document.activeElement as HTMLElement | null
  if (current?.tagName !== 'WEBVIEW') lendingFrom = current
  focusListeners.get(id)?.()
})
window.canvas.preview.onRestoreFocus(() => {
  const from = lendingFrom
  lendingFrom = null
  if (document.activeElement?.tagName !== 'WEBVIEW') return
  // preventScroll: focusing scrolls the canvas container to the element otherwise.
  if (from?.isConnected && from !== document.body) from.focus({ preventScroll: true })
  else (document.activeElement as HTMLElement).blur()
})

export const usePreviewActive = (id: string) => useSyncExternalStore(subscribe, () => active.has(id))
export const useServerStatus = (id: string) => useSyncExternalStore(subscribe, () => servers.get(id))

function register<T>(map: Map<string, T>, id: string, cb: T): () => void {
  map.set(id, cb)
  return () => {
    if (map.get(id) === cb) map.delete(id)
  }
}

/** Claude asked for a viewport size; the card resizes itself to fit it. */
export const onPreviewResize = (id: string, cb: (width: number, height: number) => void) => register(resizeListeners, id, cb)

/** Claude is about to press a key in the card's page. */
export const onPreviewFocus = (id: string, cb: () => void) => register(focusListeners, id, cb)
