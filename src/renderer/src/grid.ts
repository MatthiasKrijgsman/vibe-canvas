import type { XYPosition } from '@xyflow/react'

/** Spacing of the background dots; node positions and sizes snap to it. */
export const GRID = 24
export const snap = (v: number) => Math.round(v / GRID) * GRID
export const snapPoint = (p: XYPosition): XYPosition => ({ x: snap(p.x), y: snap(p.y) })
