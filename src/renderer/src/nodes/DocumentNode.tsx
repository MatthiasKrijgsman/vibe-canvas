import { NodeResizer, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocumentContent, DocumentData } from '../../../shared/types'
import { snap } from '../grid'
import { CloseIcon, DocumentIcon, ExternalIcon } from '../icons'
import { usePreviewActive } from '../previews'
import SideHandles from '../SideHandles'

export type DocumentNodeType = Node<DocumentData & Record<string, unknown>, 'document'>

// Main reports a file's changes for one card; route them to it.
const contentListeners = new Map<string, (content: DocumentContent) => void>()
window.canvas.document.onContent((id, content) => contentListeners.get(id)?.(content))

const fileName = (path: string) => path.split('/').pop() || path
const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')

/** The first top-level heading names the document; otherwise its file does. */
function titleOf(text: string | undefined, path: string): string {
  const heading = text?.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]
  return heading?.replace(/[*_`]/g, '') || fileName(path)
}

function DocumentNode({ id, data }: NodeProps<DocumentNodeType>) {
  const { updateNode, updateNodeData, deleteElements } = useReactFlow()
  const [content, setContent] = useState<DocumentContent | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const active = usePreviewActive(id)
  const { path, terminalId } = data

  useEffect(() => {
    let current = true
    contentListeners.set(id, setContent)
    window.canvas.document.watch(id, { path, terminalId }).then((c) => current && setContent(c))
    return () => {
      current = false
      contentListeners.delete(id)
      window.canvas.document.unwatch(id)
    }
  }, [id, path, terminalId])

  const components = useMemo<Components>(() => {
    const follow = async (e: MouseEvent, href: string) => {
      e.preventDefault()
      if (href.startsWith('#')) {
        const target = decodeURIComponent(href.slice(1))
        const heading = [...(articleRef.current?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])].find(
          (h) => slug(h.textContent ?? '') === target
        )
        heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      // Another markdown file opens in this card; web links and other files open outside.
      const next = await window.canvas.document.openLink(path, href)
      if (next) updateNodeData(id, { path: next })
    }
    return {
      a: ({ href, children, title }) => (
        <a href={href} title={title ?? href} onClick={(e) => href && follow(e, href)}>
          {children}
        </a>
      ),
      // Only web images; a relative path would resolve against the canvas, not the file.
      img: ({ src, alt }) =>
        typeof src === 'string' && /^(https?|data):/i.test(src) ? (
          <img src={src} alt={alt} loading="lazy" />
        ) : (
          <span className="markdown-missing-image">{alt || 'image'}</span>
        )
    }
  }, [id, path, updateNodeData])

  let body
  if (!content) {
    body = null
  } else if (content.error) {
    body = (
      <div className="preview-overlay">
        <span className="preview-overlay-title">Can't show this document</span>
        <span className="preview-overlay-detail">{content.error}</span>
      </div>
    )
  } else if (!content.text?.trim()) {
    body = (
      <div className="preview-overlay quiet">
        <DocumentIcon size={22} />
        <span>{fileName(path)} is empty.</span>
      </div>
    )
  } else {
    body = (
      <article ref={articleRef} className="markdown">
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {content.text}
        </Markdown>
      </article>
    )
  }

  return (
    <div className={`card document-card${active ? ' active' : ''}`}>
      <NodeResizer
        minWidth={320}
        minHeight={200}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_e, r) => updateNode(id, { position: { x: snap(r.x), y: snap(r.y) }, width: snap(r.width), height: snap(r.height) })}
      />
      {/* Anchors for the line to the session that opened this document. */}
      <SideHandles type="source" />
      <div className="card-header document-drag">
        <span className="card-label">
          <DocumentIcon size={14} />
        </span>
        <span className="card-title">{titleOf(content?.text, path)}</span>
        <span className="terminal-chip document-file" title={path}>
          {fileName(path)}
        </span>
        <button className="icon-button nodrag" title="Open in its app" onClick={() => window.canvas.document.openInApp(path)}>
          <ExternalIcon size={14} />
        </button>
        <button className="icon-button danger nodrag" title="Close document" onClick={() => deleteElements({ nodes: [{ id }] })}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="document-body nodrag nowheel nopan">{body}</div>
    </div>
  )
}

export default memo(DocumentNode)
