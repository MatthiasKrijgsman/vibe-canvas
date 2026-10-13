import type { XYPosition } from '@xyflow/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { NoteIcon } from './icons'

interface Props {
  pointer: XYPosition
  /** Where the arrow leaves the dragged card; null while the pointer is over the card. */
  from: XYPosition | null
  label: string
}

/** A slightly bowed line from `a` to `b`. */
function curve(a: XYPosition, b: XYPosition): string {
  const bend = 0.12
  const cx = (a.x + b.x) / 2 - (b.y - a.y) * bend
  const cy = (a.y + b.y) / 2 + (b.x - a.x) * bend
  return `M${a.x} ${a.y} Q${cx} ${cy} ${b.x} ${b.y}`
}

/** Follows the pointer while a prompt is dragged: an arrow from the card and a chip saying what a drop does. */
export default function PromptDragOverlay({ pointer, from, label }: Props) {
  const chipRef = useRef<HTMLDivElement>(null)
  const [chip, setChip] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const { offsetWidth: width, offsetHeight: height } = chipRef.current!
    if (width !== chip.width || height !== chip.height) setChip({ width, height })
  })

  // Keep the chip on the far side of the pointer, so the arrow never runs underneath it,
  // unless that would push it off the window.
  const left = !!from && pointer.x < from.x && pointer.x - chip.width - 12 >= 8
  const above = !!from && pointer.y < from.y && pointer.y - chip.height - 8 >= 8
  const offset = `translate(${left ? 'calc(-100% - 12px)' : '12px'}, ${above ? 'calc(-100% - 8px)' : '8px'})`

  return (
    <>
      {from && (
        <svg className="drag-arrow">
          <defs>
            <marker
              id="drag-arrow-head"
              viewBox="0 0 10 10"
              refX="7"
              refY="5"
              markerWidth="11"
              markerHeight="11"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10z" />
            </marker>
          </defs>
          <circle cx={from.x} cy={from.y} r={3.5} />
          <path d={curve(from, pointer)} markerEnd="url(#drag-arrow-head)" />
        </svg>
      )}
      <div ref={chipRef} className="drag-chip" style={{ left: pointer.x, top: pointer.y, transform: offset }}>
        <NoteIcon size={13} />
        <span>{label}</span>
      </div>
    </>
  )
}
