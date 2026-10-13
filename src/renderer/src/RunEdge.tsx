import { getBezierPath, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'

/** Animated connector from a running prompt to the terminal executing it. */
function RunEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return (
    <g className="run-edge">
      <path d={path} className="run-edge-track" />
      <path d={path} className="run-edge-flow" />
      <circle r={4} className="run-edge-dot">
        <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
      </circle>
      <circle cx={targetX} cy={targetY} r={4} className="run-edge-end" />
    </g>
  )
}

export default memo(RunEdge)
