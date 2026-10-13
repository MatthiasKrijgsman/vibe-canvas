import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesState,
  useReactFlow,
  type Edge,
  type OnBeforeDelete,
  type OnNodeDrag,
  type XYPosition
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { CanvasState, Effort, Project, SavedNode, TerminalData } from '../../shared/types'
import { CanvasContext, pendingFocus, type DropTarget, type PromptRun } from './canvasContext'
import { FitIcon, MinusIcon, NoteIcon, PlusIcon, SparkIcon } from './icons'
import { GRID, snap, snapPoint } from './grid'
import { hasImageFiles, importImages } from './images'
import PromptNode, { type PromptNodeType } from './nodes/PromptNode'
import TerminalNode, { type TerminalNodeType } from './nodes/TerminalNode'
import RunEdge from './RunEdge'
import Sidebar from './Sidebar'
import StartDialog from './StartDialog'
import { getTerminalStatus, onAnyTerminalHook, onTerminalStatusChange, sendPrompt } from './terminals'

export type AppNode = PromptNodeType | TerminalNodeType

const nodeTypes = { prompt: PromptNode, terminal: TerminalNode }
const edgeTypes = { run: RunEdge }

const DOT_SIZE = 1.4
/** Screen pixels per second when moving the camera with WASD. */
const PAN_SPEED = 900
const MIN_ZOOM = 0.4
const MAX_ZOOM = 1

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

const PROMPT_WIDTH = 14 * GRID
const TERMINAL_SIZE = { width: 32 * GRID, height: 20 * GRID }

function restoreNode(saved: SavedNode): AppNode {
  if (saved.type === 'terminal') {
    return {
      id: saved.id,
      type: 'terminal',
      position: snapPoint(saved.position),
      width: snap(saved.width ?? TERMINAL_SIZE.width),
      height: snap(saved.height ?? TERMINAL_SIZE.height),
      dragHandle: '.terminal-drag',
      data: saved.data as TerminalNodeType['data']
    }
  }
  return {
    id: saved.id,
    type: 'prompt',
    position: snapPoint(saved.position),
    width: snap(saved.width ?? PROMPT_WIDTH),
    height: saved.height ? snap(saved.height) : undefined,
    data: saved.data as PromptNodeType['data']
  }
}

function saveNode(node: AppNode): SavedNode {
  const width = node.width ?? node.measured?.width
  if (node.type === 'terminal') {
    return {
      id: node.id,
      type: 'terminal',
      position: node.position,
      width,
      height: node.height ?? node.measured?.height,
      data: node.data
    }
  }
  // Prompts grow with their text until resized by hand, so only keep an explicit height.
  return { id: node.id, type: 'prompt', position: node.position, width, height: node.height, data: node.data }
}

function nodeRect(node: AppNode) {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? node.measured?.width ?? PROMPT_WIDTH,
    height: node.height ?? node.measured?.height ?? 168
  }
}

/** Walk downward from `start` until the box no longer overlaps an existing node. */
function findFreeSpot(nodes: AppNode[], start: XYPosition, size: { width: number; height: number }): XYPosition {
  const gap = 2 * GRID
  const pos = snapPoint(start)
  for (let i = 0; i < 100; i++) {
    const hit = nodes.map(nodeRect).find(
      (r) =>
        pos.x < r.x + r.width + gap &&
        pos.x + size.width + gap > r.x &&
        pos.y < r.y + r.height + gap &&
        pos.y + size.height + gap > r.y
    )
    if (!hit) break
    pos.y = snap(hit.y + hit.height + gap)
  }
  return pos
}

function hitTest(x: number, y: number, draggedId: string): DropTarget {
  for (const el of document.elementsFromPoint(x, y)) {
    const project = el.closest<HTMLElement>('[data-project-id]')
    if (project) return { kind: 'project', id: project.dataset.projectId! }
    const terminal = el.closest<HTMLElement>('.react-flow__node-terminal')
    if (terminal && terminal.dataset.id && terminal.dataset.id !== draggedId) {
      return { kind: 'terminal', id: terminal.dataset.id }
    }
  }
  return null
}

function pointer(e: MouseEvent | TouchEvent): { x: number; y: number } {
  const p = 'touches' in e ? (e.touches[0] ?? e.changedTouches[0]) : e
  return { x: p.clientX, y: p.clientY }
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split('\n')[0]
  return line ? (line.length > 60 ? `${line.slice(0, 57)}…` : line) : undefined
}

interface PendingStart {
  project: Project
  prompt?: { id: string; text: string; images: string[]; position: XYPosition; width: number }
}

function Workspace({ initial }: { initial: CanvasState | null }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initial?.nodes.map(restoreNode) ?? [])
  const [projects, setProjects] = useState<Project[]>(initial?.projects ?? [])
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [zoom, setZoom] = useState(clampZoom(initial?.viewport.zoom ?? 1))
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null)
  const [runs, setRuns] = useState<Record<string, PromptRun>>({})
  const runsRef = useRef(runs)
  runsRef.current = runs
  const viewportRef = useRef(
    initial ? { ...initial.viewport, zoom: clampZoom(initial.viewport.zoom) } : { x: 0, y: 0, zoom: 1 }
  )
  const dropTargetRef = useRef<DropTarget>(null)
  const dragStart = useRef<{ id: string; position: XYPosition } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rf = useReactFlow<AppNode>()

  // ---------- Persistence ----------

  const snapshot = useCallback(
    (): CanvasState => ({ version: 1, projects, nodes: nodes.map(saveNode), viewport: viewportRef.current }),
    [nodes, projects]
  )
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const saveTimer = useRef<number>(0)
  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => window.canvas.saveState(snapshotRef.current()), 400)
  }, [])

  useEffect(scheduleSave, [nodes, projects, scheduleSave])
  useEffect(() => {
    const flush = () => {
      window.clearTimeout(saveTimer.current)
      window.canvas.saveStateSync(snapshotRef.current())
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush() // also on unmount, e.g. a hot reload during development
    }
  }, [])

  // ---------- Camera: pan with the middle mouse button ----------

  useEffect(() => {
    const el = containerRef.current!
    const onDown = (e: MouseEvent) => {
      if (e.button !== 1) return
      // Capture phase, so this also works over cards and terminals.
      e.preventDefault()
      e.stopPropagation()
      const origin = { x: e.clientX, y: e.clientY }
      const start = rf.getViewport()
      document.body.classList.add('panning')
      const move = (ev: MouseEvent) =>
        rf.setViewport({ x: start.x + ev.clientX - origin.x, y: start.y + ev.clientY - origin.y, zoom: start.zoom })
      const up = (ev: MouseEvent) => {
        if (ev.button !== 1) return
        window.removeEventListener('mousemove', move, true)
        window.removeEventListener('mouseup', up, true)
        document.body.classList.remove('panning')
        viewportRef.current = rf.getViewport()
        scheduleSave()
      }
      window.addEventListener('mousemove', move, true)
      window.addEventListener('mouseup', up, true)
    }
    const onAux = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    el.addEventListener('mousedown', onDown, true)
    el.addEventListener('auxclick', onAux, true)
    return () => {
      el.removeEventListener('mousedown', onDown, true)
      el.removeEventListener('auxclick', onAux, true)
    }
  }, [rf, scheduleSave])

  // ---------- Camera: move with WASD while nothing is selected ----------

  useEffect(() => {
    const directions: Record<string, XYPosition> = {
      KeyW: { x: 0, y: 1 },
      KeyA: { x: 1, y: 0 },
      KeyS: { x: 0, y: -1 },
      KeyD: { x: -1, y: 0 }
    }
    const held = new Set<string>()
    let frame = 0
    let last = 0

    const step = (time: number) => {
      let dx = 0
      let dy = 0
      held.forEach((code) => {
        dx += directions[code].x
        dy += directions[code].y
      })
      const length = Math.hypot(dx, dy)
      if (length > 0) {
        const distance = (PAN_SPEED * (time - last)) / 1000 / length
        const vp = rf.getViewport()
        rf.setViewport({ x: vp.x + dx * distance, y: vp.y + dy * distance, zoom: vp.zoom })
      }
      last = time
      frame = held.size ? requestAnimationFrame(step) : 0
    }
    const save = () => {
      viewportRef.current = rf.getViewport()
      scheduleSave()
    }

    const onDown = (e: KeyboardEvent) => {
      if (!(e.code in directions) || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement
      if (target.isContentEditable || target.closest('input, textarea, select')) return
      if (document.querySelector('[role="dialog"]') || rf.getNodes().some((n) => n.selected)) return
      e.preventDefault()
      held.add(e.code)
      if (!frame) {
        last = performance.now()
        frame = requestAnimationFrame(step)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (held.delete(e.code) && !held.size) save()
    }
    const onBlur = () => {
      if (!held.size) return
      held.clear()
      save()
    }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      cancelAnimationFrame(frame)
    }
  }, [rf, scheduleSave])

  // ---------- Node creation ----------

  const viewportCenter = useCallback((): XYPosition => {
    const rect = containerRef.current!.getBoundingClientRect()
    return rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }, [rf])

  const reveal = useCallback(
    (id: string) => {
      requestAnimationFrame(() => {
        const node = rf.getNode(id)
        const rect = containerRef.current?.getBoundingClientRect()
        if (!node || !rect) return
        const r = nodeRect(node)
        const tl = rf.flowToScreenPosition({ x: r.x, y: r.y })
        const br = rf.flowToScreenPosition({ x: r.x + r.width, y: r.y + r.height })
        const visible = tl.x >= rect.left && tl.y >= rect.top && br.x <= rect.right && br.y <= rect.bottom
        if (!visible) rf.fitView({ nodes: [{ id }], duration: 350, padding: 0.15, maxZoom: Math.max(rf.getZoom(), 0.6) })
      })
    },
    [rf]
  )

  const createPrompt = useCallback(
    (position: XYPosition, images?: string[]) => {
      const id = `prompt-${crypto.randomUUID()}`
      pendingFocus.add(id)
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { id, type: 'prompt', position: snapPoint(position), width: PROMPT_WIDTH, selected: true, data: { text: '', images } }
      ])
    },
    [setNodes]
  )

  const createTerminal = useCallback(
    (
      project: Project,
      options: { model: string; effort: Effort },
      prompt?: { text: string; images?: string[] },
      anchor?: { position: XYPosition; width: number }
    ): string => {
      const id = `term-${crypto.randomUUID()}`
      const start = anchor
        ? { x: anchor.position.x + anchor.width + 2 * GRID, y: anchor.position.y }
        : (() => {
            const c = viewportCenter()
            return { x: c.x - TERMINAL_SIZE.width / 2, y: c.y - TERMINAL_SIZE.height / 2 }
          })()
      const data: TerminalData = {
        projectId: project.id,
        cwd: project.path,
        sessionId: crypto.randomUUID(),
        title: prompt ? firstLine(prompt.text) : undefined,
        initialPrompt: prompt?.text.trim() || undefined,
        initialImages: prompt?.images?.length ? prompt.images : undefined,
        model: options.model,
        effort: options.effort,
        started: false
      }
      pendingFocus.add(id)
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        {
          id,
          type: 'terminal',
          position: findFreeSpot(ns, start, TERMINAL_SIZE),
          ...TERMINAL_SIZE,
          dragHandle: '.terminal-drag',
          selected: true,
          data
        }
      ])
      reveal(id)
      return id
    },
    [setNodes, viewportCenter, reveal]
  )

  const closeTerminal = useCallback(
    (id: string) => {
      if (!window.confirm('Close this Claude Code session? The conversation stays on disk and can be resumed with claude --resume.')) return
      window.canvas.pty.kill(id)
      setNodes((ns) => ns.filter((n) => n.id !== id))
    },
    [setNodes]
  )

  const focusNode = useCallback(
    (id: string) => {
      const node = rf.getNode(id)
      if (!node) return
      const r = nodeRect(node)
      rf.setCenter(r.x + r.width / 2, r.y + r.height / 2, { zoom: Math.max(rf.getZoom(), 0.8), duration: 350 })
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })))
    },
    [rf, setNodes]
  )

  // ---------- Prompt runs (prompt → terminal, until Claude finishes) ----------

  const startRun = useCallback((promptId: string, terminalId: string, terminalBusy: boolean) => {
    setRuns((rs) => ({ ...rs, [promptId]: { terminalId, stopsLeft: terminalBusy ? 2 : 1 } }))
  }, [])

  const cancelRun = useCallback((promptId: string) => {
    setRuns((rs) => {
      const { [promptId]: _, ...rest } = rs
      return rest
    })
  }, [])

  // A run ends at the Stop hook of the turn it started. If the terminal was busy when the
  // prompt was sent, the current turn's Stop comes first, unless our submit is seen.
  useEffect(
    () =>
      onAnyTerminalHook((e) => {
        if (e.event !== 'Stop' && e.event !== 'UserPromptSubmit') return
        setRuns((rs) => {
          let changed = false
          const next: Record<string, PromptRun> = {}
          for (const [promptId, run] of Object.entries(rs)) {
            if (run.terminalId !== e.id) {
              next[promptId] = run
            } else if (e.event === 'UserPromptSubmit') {
              next[promptId] = { ...run, stopsLeft: 1 }
              changed ||= run.stopsLeft !== 1
            } else {
              changed = true
              if (run.stopsLeft > 1) next[promptId] = { ...run, stopsLeft: run.stopsLeft - 1 }
            }
          }
          return changed ? next : rs
        })
      }),
    []
  )

  // Runs end when their terminal exits, or when the prompt or terminal is removed.
  useEffect(
    () =>
      onTerminalStatusChange(() => {
        const rs = runsRef.current
        if (Object.values(rs).some((r) => getTerminalStatus(r.terminalId) === 'exited')) {
          setRuns((cur) => Object.fromEntries(Object.entries(cur).filter(([, r]) => getTerminalStatus(r.terminalId) !== 'exited')))
        }
      }),
    []
  )
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id))
    if (Object.entries(runs).some(([pid, r]) => !ids.has(pid) || !ids.has(r.terminalId))) {
      setRuns((cur) => Object.fromEntries(Object.entries(cur).filter(([pid, r]) => ids.has(pid) && ids.has(r.terminalId))))
    }
  }, [nodes, runs])

  const edges = useMemo<Edge[]>(
    () =>
      Object.entries(runs).flatMap(([promptId, run]) => {
        const prompt = nodes.find((n) => n.id === promptId)
        const terminal = nodes.find((n) => n.id === run.terminalId)
        if (!prompt || !terminal) return []
        const p = nodeRect(prompt)
        const t = nodeRect(terminal)
        const rightward = p.x + p.width / 2 <= t.x + t.width / 2
        return [
          {
            id: `run-${promptId}`,
            source: promptId,
            target: run.terminalId,
            sourceHandle: rightward ? 'right' : 'left',
            targetHandle: rightward ? 'left' : 'right',
            type: 'run',
            selectable: false,
            focusable: false,
            deletable: false
          }
        ]
      }),
    [runs, nodes]
  )

  const terminalTitle = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id)
      return node?.type === 'terminal' ? node.data.title || 'Claude Code' : 'terminal'
    },
    [nodes]
  )

  // ---------- Projects ----------

  const addProject = useCallback(async () => {
    const path = await window.canvas.pickDirectory()
    if (!path) return
    setProjects((ps) =>
      ps.some((p) => p.path === path)
        ? ps
        : [...ps, { id: crypto.randomUUID(), name: path.split('/').filter(Boolean).pop() ?? path, path }]
    )
  }, [])

  const removeProject = useCallback(
    (project: Project) => {
      const sessions = nodes.filter((n) => n.type === 'terminal' && n.data.projectId === project.id)
      const message = sessions.length
        ? `Remove “${project.name}” and close its ${sessions.length} session${sessions.length > 1 ? 's' : ''}?`
        : `Remove “${project.name}” from the sidebar?`
      if (!window.confirm(message)) return
      sessions.forEach((s) => window.canvas.pty.kill(s.id))
      setNodes((ns) => ns.filter((n) => !sessions.some((s) => s.id === n.id)))
      setProjects((ps) => ps.filter((p) => p.id !== project.id))
    },
    [nodes, setNodes]
  )

  const confirmStart = useCallback(
    (model: string, effort: Effort) => {
      if (!pendingStart) return
      const { project, prompt } = pendingStart
      setPendingStart(null)
      const terminalId = createTerminal(
        project,
        { model, effort },
        prompt && { text: prompt.text, images: prompt.images },
        prompt && { position: prompt.position, width: prompt.width }
      )
      if (prompt && (prompt.text.trim() || prompt.images.length)) startRun(prompt.id, terminalId, false)
    },
    [pendingStart, createTerminal, startRun]
  )

  // ---------- Drag & drop ----------

  const onNodeDragStart: OnNodeDrag<AppNode> = useCallback((_e, node) => {
    dragStart.current = { id: node.id, position: { ...node.position } }
  }, [])

  const snapBack = useCallback(
    (id: string, position: XYPosition) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, position, className: 'snap-back' } : n)))
      setTimeout(() => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, className: undefined } : n))), 260)
    },
    [setNodes]
  )

  const onNodeDrag: OnNodeDrag<AppNode> = useCallback(
    (e, node) => {
      // A running prompt can be moved around, but not sent anywhere else.
      if (node.type !== 'prompt' || runsRef.current[node.id]) return
      const { x, y } = pointer(e)
      const target = hitTest(x, y, node.id)
      if (target?.kind !== dropTargetRef.current?.kind || target?.id !== dropTargetRef.current?.id) {
        dropTargetRef.current = target
        setDropTarget(target)
      }
      const project = target?.kind === 'project' ? projects.find((p) => p.id === target.id) : null
      setGhost(project ? { x, y, label: `Start Claude Code in ${project.name}` } : null)
    },
    [projects]
  )

  const onNodeDragStop: OnNodeDrag<AppNode> = useCallback(
    (e, node) => {
      const target = dropTargetRef.current
      const start = dragStart.current
      dropTargetRef.current = null
      dragStart.current = null
      setDropTarget(null)
      setGhost(null)
      if (!start) return
      // Released over the sidebar without a target: don't leave the card hidden under it.
      const overSidebar = pointer(e).x < (containerRef.current?.getBoundingClientRect().left ?? 0)
      if (!target || node.type !== 'prompt') {
        if (overSidebar) snapBack(node.id, start.position)
        return
      }

      // The prompt stays on the canvas: animate it back to where the drag began.
      snapBack(node.id, start.position)

      const { text, images = [] } = node.data
      if (target.kind === 'project') {
        const project = projects.find((p) => p.id === target.id)
        if (project) {
          const width = node.width ?? node.measured?.width ?? PROMPT_WIDTH
          setPendingStart({ project, prompt: { id: node.id, text, images, position: start.position, width } })
        }
      } else if (text.trim() || images.length) {
        const busy = getTerminalStatus(target.id) === 'working' || getTerminalStatus(target.id) === 'attention'
        sendPrompt(target.id, text, images)
        startRun(node.id, target.id, busy)
      }
    },
    [projects, snapBack, startRun]
  )

  // Terminals close through their own button (with confirmation), not the delete key.
  const onBeforeDelete: OnBeforeDelete<AppNode> = useCallback(
    async ({ nodes: toDelete }) => ({ nodes: toDelete.filter((n) => n.type === 'prompt'), edges: [] }),
    []
  )

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      createPrompt({ x: p.x - GRID, y: p.y - GRID })
    },
    [rf, createPrompt]
  )

  // Dropping images on empty canvas starts a new prompt with them attached.
  const onCanvasDragOver = useCallback((e: ReactDragEvent) => {
    if (!hasImageFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onCanvasDrop = useCallback(
    async (e: ReactDragEvent) => {
      if (!hasImageFiles(e.dataTransfer)) return
      e.preventDefault()
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const images = await importImages(e.dataTransfer.files)
      if (images.length) createPrompt({ x: p.x - GRID, y: p.y - GRID }, images)
    },
    [rf, createPrompt]
  )

  // Without this, Electron navigates to any file dropped outside a drop zone.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const newPromptAtCenter = useCallback(() => {
    const c = viewportCenter()
    createPrompt(findFreeSpot(rf.getNodes(), { x: c.x - PROMPT_WIDTH / 2, y: c.y - 80 }, { width: PROMPT_WIDTH, height: 168 }))
  }, [viewportCenter, createPrompt, rf])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newPromptAtCenter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newPromptAtCenter])

  const terminals = useMemo(() => nodes.filter((n): n is TerminalNodeType => n.type === 'terminal'), [nodes])
  const context = useMemo(
    () => ({ dropTarget, projects, closeTerminal, runs, cancelRun, terminalTitle }),
    [dropTarget, projects, closeTerminal, runs, cancelRun, terminalTitle]
  )

  return (
    <CanvasContext.Provider value={context}>
      <div className="app">
        <Sidebar
          terminals={terminals}
          onAddProject={addProject}
          onRemoveProject={removeProject}
          onOpenTerminal={(project) => setPendingStart({ project })}
          onFocusNode={focusNode}
        />
        <div className="canvas" ref={containerRef}>
          <ReactFlow<AppNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onBeforeDelete={onBeforeDelete}
            onDoubleClick={onDoubleClick}
            onDragOver={onCanvasDragOver}
            onDrop={onCanvasDrop}
            onMove={(_e, vp) => setZoom(vp.zoom)}
            onMoveEnd={(_e, vp) => {
              viewportRef.current = vp
              scheduleSave()
            }}
            defaultViewport={viewportRef.current}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            snapToGrid
            snapGrid={[GRID, GRID]}
            panOnDrag={false}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            autoPanOnNodeDrag={false}
            autoPanOnSelection={false}
            nodesConnectable={false}
            zoomOnDoubleClick={false}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            {/* Offset puts the dots exactly on multiples of GRID, where nodes snap to. */}
            <Background variant={BackgroundVariant.Dots} gap={GRID} size={DOT_SIZE} offset={DOT_SIZE / 2 - GRID / 2} />
            <Panel position="bottom-center">
              <div className="toolbar">
                <button className="toolbar-button" onClick={newPromptAtCenter} title="New prompt (⌘N)">
                  <NoteIcon size={15} />
                  New prompt
                </button>
                <span className="toolbar-divider" />
                <button className="toolbar-button" onClick={() => rf.zoomOut({ duration: 150 })} title="Zoom out">
                  <MinusIcon size={14} />
                </button>
                <span className="zoom-label">{Math.round(zoom * 100)}%</span>
                <button className="toolbar-button" onClick={() => rf.zoomIn({ duration: 150 })} title="Zoom in">
                  <PlusIcon size={14} />
                </button>
                <button className="toolbar-button" onClick={() => rf.fitView({ duration: 300, padding: 0.1, maxZoom: 1 })} title="Fit to screen">
                  <FitIcon size={14} />
                </button>
              </div>
            </Panel>
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="empty-canvas">
              <SparkIcon size={28} className="spark" />
              <h1>What should Claude work on?</h1>
              <p>Double-click anywhere to write a prompt, then drag it onto a project.</p>
            </div>
          )}
        </div>
        {ghost && (
          <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
            {ghost.label}
          </div>
        )}
        {pendingStart && (
          <StartDialog
            project={pendingStart.project}
            prompt={pendingStart.prompt}
            onStart={confirmStart}
            onCancel={() => setPendingStart(null)}
          />
        )}
      </div>
    </CanvasContext.Provider>
  )
}

export default function App() {
  // Read from disk on mount (not once at startup) so a remount never restores stale state.
  const [initial, setInitial] = useState<CanvasState | null | undefined>(undefined)
  useEffect(() => {
    window.canvas.loadState().then((state) => setInitial(state ?? null))
  }, [])
  if (initial === undefined) return null
  return (
    <ReactFlowProvider>
      <Workspace initial={initial} />
    </ReactFlowProvider>
  )
}
