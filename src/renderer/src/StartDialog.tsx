import { type ReactNode, useEffect, useState } from 'react'
import type { Effort, Project } from '../../shared/types'
import { BranchIcon, FolderIcon, RemoteIcon } from './icons'
import { imageUrl } from './images'
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODELS } from './models'

export interface SessionOptions {
  model: string
  effort: Effort
  worktree: boolean
  remoteControl: boolean
}

interface Props {
  project: Project
  prompt?: { text: string; images?: string[] }
  onStart: (options: SessionOptions) => void
  onCancel: () => void
}

/** Asked before a new session starts: which model and effort level to run with, and where. */
export default function StartDialog({ project, prompt, onStart, onCancel }: Props) {
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [effort, setEffort] = useState<Effort>(DEFAULT_EFFORT)
  const [worktree, setWorktree] = useState(false)
  const [remoteControl, setRemoteControl] = useState(false)
  const start = (m = model) => onStart({ model: m, effort, worktree, remoteControl })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onStart({ model, effort, worktree, remoteControl })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [model, effort, worktree, remoteControl, onStart, onCancel])

  const images = prompt?.images ?? []

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>Start a session</h2>
          <span className="dialog-project">
            <FolderIcon size={13} />
            {project.name}
          </span>
        </div>

        {prompt && (prompt.text.trim() || images.length > 0) && (
          <div className="dialog-prompt">
            {prompt.text.trim() && <p>{prompt.text.trim()}</p>}
            {images.length > 0 && (
              <div className="dialog-prompt-images">
                {images.map((path) => (
                  <img key={path} src={imageUrl(path)} alt="" />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="dialog-label">Model</div>
        <div className="model-grid">
          {MODELS.map((m) => (
            <button
              key={m.id}
              className={`model-option${model === m.id ? ' selected' : ''}`}
              onClick={() => setModel(m.id)}
              onDoubleClick={() => start(m.id)}
            >
              <span className="model-name">{m.name}</span>
              <span className="model-description">{m.description}</span>
            </button>
          ))}
        </div>

        <div className="dialog-label">Effort</div>
        <div className="segmented">
          {EFFORTS.map((e) => (
            <button key={e.id} className={effort === e.id ? 'selected' : ''} onClick={() => setEffort(e.id)}>
              {e.name}
            </button>
          ))}
        </div>

        <div className="dialog-toggles">
          <Toggle
            icon={<BranchIcon size={14} />}
            label="Worktree"
            description="Work on a new branch in its own git worktree"
            checked={worktree}
            onChange={setWorktree}
          />
          <Toggle
            icon={<RemoteIcon size={14} />}
            label="Remote Control"
            description="Continue the session from claude.ai or the Claude app"
            checked={remoteControl}
            onChange={setRemoteControl}
          />
        </div>

        <div className="dialog-actions">
          <button className="button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="button brand" onClick={() => start()}>
            Start session
            <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

interface ToggleProps {
  icon: ReactNode
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}

function Toggle({ icon, label, description, checked, onChange }: ToggleProps) {
  return (
    <button
      className={`dialog-toggle${checked ? ' on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="dialog-toggle-icon">{icon}</span>
      <span className="dialog-toggle-text">
        <span className="dialog-toggle-label">{label}</span>
        <span className="dialog-toggle-description">{description}</span>
      </span>
      <span className="switch" />
    </button>
  )
}
