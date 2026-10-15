import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CanvasApi, DocumentContent, DocumentOpenRequest, HookEvent, PreviewOpenRequest, ServerStatus } from '../shared/types'

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function readClaudeTheme(): CanvasApi['claudeTheme'] {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  for (const file of [join(homedir(), '.claude.json'), join(configDir, 'settings.json')]) {
    try {
      const theme = JSON.parse(readFileSync(file, 'utf8')).theme
      if (typeof theme === 'string') {
        if (theme.includes('light')) return 'light'
        if (theme === 'auto' || theme === 'system') return 'system'
        return 'dark'
      }
    } catch {
      // missing or unreadable; try the next file
    }
  }
  return 'dark' // Claude Code's default
}

const api: CanvasApi = {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.send('state:save', state),
  saveStateSync: (state) => ipcRenderer.sendSync('state:saveSync', state),
  pickDirectory: () => ipcRenderer.invoke('dialog:directory'),
  homeDir: homedir(),
  saveImage: (data, ext) => ipcRenderer.invoke('image:save', data, ext),
  claudeTheme: readClaudeTheme(),
  pty: {
    start: (opts) => ipcRenderer.invoke('pty:start', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    send: (id, text, images, submit) => ipcRenderer.send('pty:send', id, text, images, submit),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (cb) => subscribe<[string, string]>('pty:data', cb),
    onExit: (cb) => subscribe<[string, number]>('pty:exit', cb),
    onHook: (cb) => subscribe<[HookEvent]>('pty:hook', cb)
  },
  preview: {
    attach: (id, webContentsId, data) => ipcRenderer.send('preview:attach', id, webContentsId, data),
    detach: (id, webContentsId) => ipcRenderer.send('preview:detach', id, webContentsId),
    close: (id) => ipcRenderer.send('preview:close', id),
    startServer: (id) => ipcRenderer.invoke('preview:startServer', id),
    stopServer: (id) => ipcRenderer.send('preview:stopServer', id),
    onOpen: (cb) => subscribe<[PreviewOpenRequest]>('preview:open', cb),
    onResize: (cb) => subscribe<[string, number, number]>('preview:resize', cb),
    onActivity: (cb) => subscribe<[string, boolean]>('preview:activity', cb),
    onServer: (cb) => subscribe<[string, ServerStatus | null]>('preview:server', cb),
    onFocus: (cb) => subscribe<[string]>('preview:focus', cb),
    onRestoreFocus: (cb) => subscribe<[]>('preview:restoreFocus', cb)
  },
  document: {
    watch: (id, data) => ipcRenderer.invoke('document:watch', id, data),
    unwatch: (id) => ipcRenderer.send('document:unwatch', id),
    openLink: (from, href) => ipcRenderer.invoke('document:openLink', from, href),
    openInApp: (path) => ipcRenderer.send('document:openInApp', path),
    onOpen: (cb) => subscribe<[DocumentOpenRequest]>('document:open', cb),
    onContent: (cb) => subscribe<[string, DocumentContent]>('document:content', cb)
  }
}

contextBridge.exposeInMainWorld('canvas', api)
