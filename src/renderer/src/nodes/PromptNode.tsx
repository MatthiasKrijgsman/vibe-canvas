import { NodeResizer, useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { PromptData } from '../../../shared/types'
import { pendingFocus, useCanvas } from '../canvasContext'
import { GRID, snap } from '../grid'
import { CheckIcon, CloseIcon, NoteIcon } from '../icons'
import { hasImageFiles, imageUrl, importImages } from '../images'
import SideHandles from '../SideHandles'

export type PromptNodeType = Node<PromptData & Record<string, unknown>, 'prompt'>

function PromptNode({ id, data }: NodeProps<PromptNodeType>) {
  const { updateNode, updateNodeData, deleteElements } = useReactFlow()
  const { runs, terminalTitle } = useCanvas()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [dropping, setDropping] = useState(false)
  const [autoHeight, setAutoHeight] = useState<number>()
  // React Flow applies node updates a beat after the keystroke, so a textarea bound straight
  // to data.text gets its value replaced after each edit, which moves the caret to the end
  // and wipes the native undo history. Keep the text locally and only take outside changes
  // while the prompt isn't being edited.
  const [text, setText] = useState(data.text)
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setText(data.text)
  }, [data.text])
  const images = data.images ?? []
  const run = runs[id]
  // Only an explicit height (set by resizing) fixes the card's size; the height prop
  // React Flow passes is the measured one.
  const height = useStore((s) => s.nodeLookup.get(id)?.height)

  useEffect(() => {
    if (!pendingFocus.delete(id)) return
    // React Flow keeps a new node hidden until it is measured, and hidden elements
    // can't take focus, so retry for a few frames.
    let frame = 0
    let tries = 0
    const tryFocus = () => {
      const input = inputRef.current
      input?.focus()
      if (input && document.activeElement !== input && ++tries < 20) frame = requestAnimationFrame(tryFocus)
    }
    tryFocus()
    return () => cancelAnimationFrame(frame)
  }, [id])

  // Until resized by hand the card grows with its content; round that height up to whole
  // grid steps so the bottom edge also lands on the dots.
  useLayoutEffect(() => {
    if (height) return
    const card = cardRef.current!
    const parts = () => card.querySelectorAll<HTMLElement>(':scope > .card-header, :scope > textarea, :scope > .prompt-images, :scope > .prompt-footer')
    const measure = () => {
      let total = 1 // top + bottom border
      parts().forEach((el) => (total += el.offsetHeight))
      const rounded = Math.ceil(total / GRID) * GRID
      setAutoHeight((h) => (h === rounded ? h : rounded))
    }
    measure()
    const observer = new ResizeObserver(measure)
    parts().forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [height, images.length])

  const addImages = useCallback(
    async (files: Iterable<File>) => {
      const paths = await importImages(files)
      if (paths.length) {
        updateNodeData(id, (node) => ({ images: [...((node.data as PromptData).images ?? []), ...paths], completed: false }))
      }
    },
    [id, updateNodeData]
  )

  const removeImage = (path: string) => updateNodeData(id, { images: images.filter((p) => p !== path), completed: false })

  // While the prompt is running its contents are locked, so it doesn't accept new images.
  const onDragOver = (e: DragEvent) => {
    if (run || !hasImageFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  const onDrop = (e: DragEvent) => {
    setDropping(false)
    if (run || !hasImageFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    addImages(e.dataTransfer.files)
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const summary = [
    images.length ? `${images.length} image${images.length > 1 ? 's' : ''}` : '',
    words ? `${words} word${words > 1 ? 's' : ''}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const classes = ['card', 'prompt-card', height ? 'sized' : '', dropping ? 'image-drop' : '', run ? 'running' : '']

  return (
    <div
      ref={cardRef}
      className={classes.filter(Boolean).join(' ')}
      style={height ? undefined : { minHeight: autoHeight }}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropping(false)
      }}
      onDrop={onDrop}
    >
      <NodeResizer
        minWidth={240}
        minHeight={144}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_e, r) => updateNode(id, { position: { x: snap(r.x), y: snap(r.y) }, width: snap(r.width), height: snap(r.height) })}
      />
      {/* Anchors for the connector drawn while this prompt runs in a terminal. */}
      <SideHandles type="source" />
      <div className="card-header">
        <span className="card-label">
          <NoteIcon size={14} />
          Prompt
        </span>
        {data.completed && !run && (
          <span className="prompt-done" title="Claude finished this prompt">
            <CheckIcon size={12} strokeWidth={2} />
            Done
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="icon-button danger nodrag"
          title="Delete prompt"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <textarea
        ref={inputRef}
        className="prompt-input nodrag nowheel"
        placeholder="Write a prompt…"
        value={text}
        disabled={!!run}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          updateNodeData(id, { text: e.target.value, completed: false })
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
          if (files.length) {
            e.preventDefault()
            addImages(files)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      {images.length > 0 && (
        <div className="prompt-images">
          {images.map((path) => (
            <div key={path} className="prompt-image">
              <img src={imageUrl(path)} alt="" draggable={false} />
              {!run && (
                <button className="prompt-image-remove nodrag" title="Remove image" onClick={() => removeImage(path)}>
                  <CloseIcon size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="prompt-footer">
        {run ? (
          <span className="run-status">
            <span className="run-spinner" />
            <span className="run-label">Running in {terminalTitle(run.terminalId)}</span>
          </span>
        ) : (
          <>
            <span>{dropping ? 'Drop to attach' : 'Drag onto a project or terminal'}</span>
            <span>{summary}</span>
          </>
        )}
      </div>
    </div>
  )
}

export default memo(PromptNode)
