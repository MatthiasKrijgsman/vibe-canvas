import { getBezierPath, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'
import { usePreviewActive } from './previews'

/** Line from a preview card (source) to the session that opened it; flows while Claude uses it. */
function LinkEdge({ source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const active = usePreviewActive(source)
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return (
    <g className={`link-edge${active ? ' active' : ''}`}>
      <path d={path} className="link-edge-line" />
      {active && <path d={path} className="link-edge-flow" />}
      <circle cx={sourceX} cy={sourceY} r={3.5} className="link-edge-end" />
      <circle cx={targetX} cy={targetY} r={3.5} className="link-edge-end" />
    </g>
  )
}

export default memo(LinkEdge)
