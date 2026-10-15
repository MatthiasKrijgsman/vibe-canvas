import { Handle, Position } from '@xyflow/react'

const SIDES = [
  ['left', Position.Left],
  ['right', Position.Right],
  ['top', Position.Top],
  ['bottom', Position.Bottom]
] as const

export type Side = (typeof SIDES)[number][0]

/** Invisible anchors on each side of a card for the connectors drawn between cards. */
export default function SideHandles({ type }: { type: 'source' | 'target' }) {
  return SIDES.map(([id, position]) => (
    <Handle key={id} id={id} type={type} position={position} isConnectable={false} className="run-handle" />
  ))
}
