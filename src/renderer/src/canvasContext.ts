import { createContext, useContext } from 'react'
import type { Project } from '../../shared/types'

export type DropTarget = { kind: 'project'; id: string } | { kind: 'terminal'; id: string } | null

/** A prompt that was sent to a terminal and hasn't finished yet. */
export interface PromptRun {
  terminalId: string
  /** Stop events to wait for: 2 when the terminal was busy (its current turn ends first). */
  stopsLeft: number
}

export interface CanvasContextValue {
  dropTarget: DropTarget
  projects: Project[]
  closeTerminal: (id: string) => void
  runs: Record<string, PromptRun>
  terminalTitle: (terminalId: string) => string
}

export const CanvasContext = createContext<CanvasContextValue>({
  dropTarget: null,
  projects: [],
  closeTerminal: () => {},
  runs: {},
  terminalTitle: () => ''
})

export const useCanvas = () => useContext(CanvasContext)

/** Node ids that should grab keyboard focus once they mount. */
export const pendingFocus = new Set<string>()
