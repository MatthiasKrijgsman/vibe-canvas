import type { Effort } from '../../shared/types'

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'Most capable for complex work' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Fast and capable for everyday tasks' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', description: 'Fastest for quick answers' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', description: 'Creative writing and storytelling' }
] as const

export const DEFAULT_MODEL = 'claude-opus-5-5'

export const EFFORTS: { id: Effort; name: string }[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Extra high' },
  { id: 'max', name: 'Max' }
]

export const DEFAULT_EFFORT: Effort = 'medium'

export const modelName = (id?: string) => MODELS.find((m) => m.id === id)?.name ?? id
