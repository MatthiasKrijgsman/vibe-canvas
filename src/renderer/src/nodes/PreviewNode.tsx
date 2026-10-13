import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import type { DidFailLoadEvent, DidNavigateEvent, DidNavigateInPageEvent, PageTitleUpdatedEvent, WebviewTag } from 'electron'
import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import type { PreviewData } from '../../../shared/types'
import { normalizeUrl } from '../../../shared/url'
import { pendingFocus } from '../canvasContext'
import { snap } from '../grid'
import { BackIcon, CloseIcon, ForwardIcon, GlobeIcon, InspectIcon, ReloadIcon, ResumeIcon } from '../icons'
import { onPreviewFocus, onPreviewResize, usePreviewActive, useServerStatus } from '../previews'

export type PreviewNodeType = Node<PreviewData & Record<string, unknown>, 'preview'>

const BLANK = 'about:blank'
const display = (url: string | undefined) => (!url || url === BLANK ? '' : url)

interface LoadError {
  description: string
  url: string
}

function PreviewNode({ id, data }: NodeProps<PreviewNodeType>) {
  const { getNode, updateNode, updateNodeData, deleteElements } = useReactFlow()
  const viewRef = useRef<WebviewTag>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The webview navigates itself after mounting; src is only its starting page.
  const initialUrl = useRef(data.url || BLANK)
  const dataRef = useRef(data)
  dataRef.current = data
  const ready = useRef(false)
  const editing = useRef(false)
  const [url, setUrl] = useState(data.url || BLANK)
  const [address, setAddress] = useState(display(data.url))
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [loadError, setLoadError] = useState<LoadError | null>(null)
  const active = usePreviewActive(id)
  const server = useServerStatus(id)

  useEffect(() => {
    const view = viewRef.current!
    let webContentsId = 0
    const attach = () => {
      if (webContentsId) return
      try {
        webContentsId = view.getWebContentsId()
      } catch {
        return // not attached yet
      }
      ready.current = true
      const { url, terminalId, server } = dataRef.current
      window.canvas.preview.attach(id, webContentsId, { url, terminalId, server })
    }
    const updateNav = () => {
      try {
        setNav({ back: view.canGoBack(), forward: view.canGoForward() })
      } catch {
        // not attached yet
      }
    }
    const navigated = (next: string) => {
      setUrl(next)
      updateNav()
      if (!editing.current) setAddress(display(next))
      if (next !== BLANK && next !== dataRef.current.url) updateNodeData(id, { url: next })
    }

    const listeners: [string, (e: never) => void][] = [
      ['did-attach', attach],
      ['dom-ready', attach],
      [
        'did-start-loading',
        () => {
          setLoading(true)
          setLoadError(null)
        }
      ],
      [
        'did-stop-loading',
        () => {
          setLoading(false)
          updateNav()
        }
      ],
      [
        'did-fail-load',
        (e: DidFailLoadEvent) => {
          // -3 is an aborted load, e.g. a new navigation replacing it.
          if (e.isMainFrame && e.errorCode !== -3) setLoadError({ description: e.errorDescription, url: e.validatedURL })
        }
      ],
      ['did-navigate', (e: DidNavigateEvent) => navigated(e.url)],
      ['did-navigate-in-page', (e: DidNavigateInPageEvent) => e.isMainFrame && navigated(e.url)],
      ['page-title-updated', (e: PageTitleUpdatedEvent) => setTitle(e.title)]
    ]
    listeners.forEach(([event, fn]) => view.addEventListener(event, fn as EventListener))
    attach()
    return () => {
      listeners.forEach(([event, fn]) => view.removeEventListener(event, fn as EventListener))
      if (webContentsId) window.canvas.preview.detach(id, webContentsId)
    }
  }, [id, updateNodeData])

  // Claude asked for a viewport size: grow or shrink the card by the difference.
  useEffect(
    () =>
      onPreviewResize(id, (width, height) => {
        const view = viewRef.current
        const node = getNode(id)
        if (!view || !node) return
        const nodeWidth = node.width ?? node.measured?.width ?? 0
        const nodeHeight = node.height ?? node.measured?.height ?? 0
        updateNode(id, {
          width: nodeWidth + width - view.clientWidth,
          height: nodeHeight + height - view.clientHeight
        })
      }),
    [id, getNode, updateNode]
  )

  useEffect(() => onPreviewFocus(id, () => viewRef.current?.focus({ preventScroll: true })), [id])

  useEffect(() => {
    if (!pendingFocus.delete(id)) return
    // Hidden until React Flow has measured the node, so retry for a few frames.
    let frame = 0
    let tries = 0
    const tryFocus = () => {
      inputRef.current?.focus()
      if (document.activeElement !== inputRef.current && ++tries < 20) frame = requestAnimationFrame(tryFocus)
    }
    tryFocus()
    return () => cancelAnimationFrame(frame)
  }, [id])

  const load = (next: string) => {
    const view = viewRef.current
    if (!view || !next) return
    setLoadError(null)
    if (ready.current) view.loadURL(next).catch(() => undefined)
    else view.src = next
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const next = normalizeUrl(address)
    inputRef.current?.blur()
    if (next) load(next)
  }

  const startServer = () => window.canvas.preview.startServer(id)

  const blank = url === BLANK
  let overlay = null
  if (server?.state === 'starting') {
    overlay = (
      <div className="preview-overlay">
        <span className="preview-overlay-title">
          <span className="run-spinner" />
          Starting <code>{data.server?.command ?? 'dev server'}</code>
        </span>
        {server.tail && <pre className="preview-log">{server.tail}</pre>}
      </div>
    )
  } else if (loadError || (blank && server?.state === 'exited')) {
    const canStart = !!data.server && server?.state !== 'running'
    overlay = (
      <div className="preview-overlay">
        <span className="preview-overlay-title">{loadError ? "Can't reach this page" : 'The dev server stopped'}</span>
        {loadError && (
          <span className="preview-overlay-detail">
            {loadError.description} · {loadError.url}
          </span>
        )}
        {server?.state === 'exited' && server.tail && <pre className="preview-log">{server.tail}</pre>}
        <div className="preview-overlay-actions">
          {loadError && (
            <button className="button" onClick={() => load(loadError.url)}>
              <ReloadIcon size={14} />
              Try again
            </button>
          )}
          {canStart && (
            <button className="button brand" onClick={startServer} title={data.server?.command}>
              <ResumeIcon size={14} />
              Start dev server
            </button>
          )}
        </div>
      </div>
    )
  } else if (blank) {
    overlay = (
      <div className="preview-overlay quiet">
        <GlobeIcon size={22} />
        <span>Type a URL above, or ask Claude to preview your app.</span>
      </div>
    )
  }

  const serverLabel = server?.state === 'starting' ? 'Starting' : server?.state === 'running' ? 'Dev server' : 'Stopped'

  return (
    <div className={`card preview-card${active ? ' active' : ''}`}>
      <NodeResizer
        minWidth={360}
        minHeight={240}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_e, r) => updateNode(id, { position: { x: snap(r.x), y: snap(r.y) }, width: snap(r.width), height: snap(r.height) })}
      />
      {/* Anchors for the line to the session that opened this preview. */}
      <Handle id="left" type="source" position={Position.Left} isConnectable={false} className="run-handle" />
      <Handle id="right" type="source" position={Position.Right} isConnectable={false} className="run-handle" />
      <div className="card-header preview-drag">
        <div className="preview-nav nodrag">
          <button className="icon-button persistent" title="Back" disabled={!nav.back} onClick={() => viewRef.current?.goBack()}>
            <BackIcon size={14} />
          </button>
          <button className="icon-button persistent" title="Forward" disabled={!nav.forward} onClick={() => viewRef.current?.goForward()}>
            <ForwardIcon size={14} />
          </button>
          <button
            className="icon-button persistent"
            title={loading ? 'Stop' : 'Reload'}
            disabled={blank && !loadError}
            onClick={() => (loading ? viewRef.current?.stop() : loadError ? load(loadError.url) : viewRef.current?.reload())}
          >
            {loading ? <CloseIcon size={14} /> : <ReloadIcon size={14} />}
          </button>
        </div>
        <form className="preview-address nodrag" onSubmit={onSubmit} title={title || undefined}>
          {loading ? <span className="run-spinner" /> : <GlobeIcon size={13} className="preview-address-icon" />}
          <input
            ref={inputRef}
            value={address}
            placeholder="Enter a URL or localhost:port"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              editing.current = true
              e.target.select()
            }}
            onBlur={() => {
              editing.current = false
              setAddress(display(url))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.blur()
            }}
          />
        </form>
        {server && (
          <span className="terminal-chip preview-server" title={data.server?.command ?? server.url}>
            <span className={`status-dot ${server.state === 'running' ? 'idle' : server.state === 'starting' ? 'working' : 'exited'}`} />
            {serverLabel}
          </span>
        )}
        <button className="icon-button nodrag" title="Open DevTools" onClick={() => viewRef.current?.openDevTools()}>
          <InspectIcon size={14} />
        </button>
        <button className="icon-button danger nodrag" title="Close preview" onClick={() => deleteElements({ nodes: [{ id }] })}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="preview-body nodrag nowheel nopan">
        <webview
          ref={viewRef}
          src={initialUrl.current}
          partition="persist:vibecanvas-preview"
          webpreferences="backgroundThrottling=no"
          // Lets window.open / target=_blank reach main, which loads them in this card.
          {...({ allowpopups: 'true' } as object)}
        />
        {overlay}
      </div>
    </div>
  )
}

export default memo(PreviewNode)
