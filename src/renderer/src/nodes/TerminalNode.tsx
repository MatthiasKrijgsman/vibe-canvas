import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { TerminalData, TerminalStatus } from '../../../shared/types'
import { pendingFocus, useCanvas } from '../canvasContext'
import { snap } from '../grid'
import { CloseIcon, FolderIcon, ResumeIcon } from '../icons'
import { hasImageFiles, importImages } from '../images'
import { EFFORTS, modelName } from '../models'
import { onTerminalData, onTerminalHook, setTerminalStatus, useTerminalStatus } from '../terminals'
import { TERMINAL_FONT, terminalThemes, useColorScheme } from '../theme'

export type TerminalNodeType = Node<TerminalData & Record<string, unknown>, 'terminal'>

const STATUS_LABEL: Record<TerminalStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Waiting for you',
  attention: 'Needs your input',
  exited: 'Session ended'
}

/** Claude Code prefixes its window title with a spinner or spark glyph; drop it. */
function cleanTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, '').trim()
}

function TerminalNode({ id, data }: NodeProps<TerminalNodeType>) {
  const { updateNode, updateNodeData } = useReactFlow()
  const { dropTarget, projects, closeTerminal } = useCanvas()
  const systemScheme = useColorScheme()
  const claudeTheme = window.canvas.claudeTheme
  const scheme = claudeTheme === 'system' ? systemScheme : claudeTheme
  const mountRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const status = useTerminalStatus(id)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async () => {
    const term = termRef.current
    if (!term) return
    const d = dataRef.current
    setError(null)
    setTerminalStatus(id, 'starting')
    const result = await window.canvas.pty.start({
      id,
      cwd: d.cwd,
      sessionId: d.sessionId,
      mode: d.started ? 'resume' : 'new',
      prompt: d.initialPrompt,
      images: d.initialImages,
      model: d.model,
      effort: d.effort,
      cols: term.cols,
      rows: term.rows
    })
    if (result.error) {
      setError(result.error)
      setTerminalStatus(id, 'exited')
      return
    }
    if (result.backlog) term.write(result.backlog)
    if (!d.started) updateNodeData(id, { started: true })
  }, [id, updateNodeData])

  useEffect(() => {
    const mount = mountRef.current!
    let disposed = false
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10_000,
      allowProposedApi: true,
      theme: terminalThemes[scheme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
    termRef.current = term

    // Shift+Enter inserts a newline in Claude Code's input instead of submitting.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        if (e.type === 'keydown') window.canvas.pty.write(id, '\x1b\r')
        return false
      }
      return true
    })

    const offData = onTerminalData(id, (chunk) => term.write(chunk))
    const offHook = onTerminalHook(id, (e) => {
      if (e.sessionId && e.sessionId !== dataRef.current.sessionId) {
        updateNodeData(id, { sessionId: e.sessionId })
      }
    })
    term.onData((input) => window.canvas.pty.write(id, input))
    term.onResize(({ cols, rows }) => window.canvas.pty.resize(id, cols, rows))
    term.onTitleChange((title) => {
      const clean = cleanTitle(title)
      if (clean && clean !== dataRef.current.title) updateNodeData(id, { title: clean })
    })

    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (mount.clientWidth > 0 && mount.clientHeight > 0) fit.fit()
      })
    })

    // Measure character cells only after the mono font has loaded.
    document.fonts
      .load(`13px ${TERMINAL_FONT}`)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return
        term.open(mount)
        fit.fit()
        observer.observe(mount)
        if (pendingFocus.delete(id)) term.focus()
        start()
      })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      offData()
      offHook()
      term.dispose()
      termRef.current = null
    }
    // The terminal lives for the lifetime of the node; theme updates are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalThemes[scheme]
  }, [scheme])

  const project = projects.find((p) => p.id === data.projectId)
  const projectName = project?.name ?? data.cwd.split('/').pop()
  const isDropTarget = dropTarget?.kind === 'terminal' && dropTarget.id === id

  return (
    <div className={`card terminal-card${isDropTarget ? ' drop-target' : ''}`}>
      <NodeResizer
        minWidth={432}
        minHeight={240}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_e, r) => updateNode(id, { position: { x: snap(r.x), y: snap(r.y) }, width: snap(r.width), height: snap(r.height) })}
      />
      {/* Anchors for the connector drawn while a prompt runs in this terminal. */}
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} className="run-handle" />
      <Handle id="right" type="target" position={Position.Right} isConnectable={false} className="run-handle" />
      <div className="card-header terminal-drag">
        <span className={`status-dot ${status}`} title={STATUS_LABEL[status]} />
        <span className="card-title">{data.title || 'Claude Code'}</span>
        {data.model && (
          <span className="terminal-chip" title="Model and effort for this session">
            {modelName(data.model)}
            {data.effort && ` · ${EFFORTS.find((e) => e.id === data.effort)?.name ?? data.effort}`}
          </span>
        )}
        <span className="terminal-chip" title={data.cwd}>
          <FolderIcon size={12} />
          {projectName}
        </span>
        <button className="icon-button danger nodrag" title="Close session" onClick={() => closeTerminal(id)}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div
        className="terminal-body nodrag nowheel nopan"
        style={{ '--terminal-bg': terminalThemes[scheme].background } as CSSProperties}
        onMouseDown={() => termRef.current?.focus()}
        onDragOver={(e) => {
          if (!hasImageFiles(e.dataTransfer)) return
          e.preventDefault()
          e.stopPropagation()
        }}
        onDrop={async (e) => {
          if (!hasImageFiles(e.dataTransfer)) return
          e.preventDefault()
          e.stopPropagation()
          // Like dropping a file into a regular terminal: attach it, don't send yet.
          const paths = await importImages(e.dataTransfer.files)
          window.canvas.pty.send(id, '', paths, false)
          termRef.current?.focus()
        }}
      >
        <div className="terminal-mount" ref={mountRef} />
        {status === 'exited' && (
          <div className="terminal-overlay">
            <span>{error ?? 'This Claude Code session has ended.'}</span>
            <button
              className="button"
              onClick={() => {
                termRef.current?.reset()
                start()
              }}
            >
              <ResumeIcon size={14} />
              {data.started ? 'Resume session' : 'Start session'}
            </button>
          </div>
        )}
        {isDropTarget && <div className="terminal-drop-label">Drop to send prompt</div>}
      </div>
    </div>
  )
}

export default memo(TerminalNode)
