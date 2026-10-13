import type { Project } from '../../shared/types'
import { PROJECT_DRAG_TYPE, useCanvas } from './canvasContext'
import { CloseIcon, FolderIcon, PlusIcon, TerminalIcon } from './icons'
import type { TerminalNodeType } from './nodes/TerminalNode'

interface Props {
  terminals: TerminalNodeType[]
  onAddProject: () => void
  onRemoveProject: (project: Project) => void
  onOpenTerminal: (project: Project) => void
  onFocusNode: (id: string) => void
}

function shortPath(path: string): string {
  const home = window.canvas.homeDir
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export default function Sidebar({ terminals, onAddProject, onRemoveProject, onOpenTerminal, onFocusNode }: Props) {
  const { projects, dropTarget } = useCanvas()

  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar">
        <span className="sidebar-brand">VibeCanvas</span>
      </div>

      <div className="sidebar-heading">
        <span>Projects</span>
        <button className="icon-button" title="Add project" onClick={onAddProject}>
          <PlusIcon size={14} />
        </button>
      </div>

      <div className="sidebar-section">
        {projects.length === 0 && (
          <div className="empty-projects">Add a folder to get started. Each project is a directory Claude Code runs in.</div>
        )}
        {projects.map((project) => {
          const sessions = terminals.filter((t) => t.data.projectId === project.id)
          const isTarget = dropTarget?.kind === 'project' && dropTarget.id === project.id
          return (
            <div key={project.id} className={`project${isTarget ? ' drop-target' : ''}`} data-project-id={project.id}>
              <div
                className="project-row"
                title={project.path}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id)
                  e.dataTransfer.effectAllowed = 'copy'
                  document.body.classList.add('dragging-project')
                }}
                onDragEnd={() => document.body.classList.remove('dragging-project')}
              >
                <FolderIcon className="project-icon" />
                <div className="project-text">
                  <span className="project-name">{project.name}</span>
                  <span className="project-path">
                    <bdi>{shortPath(project.path)}</bdi>
                  </span>
                </div>
                <button className="icon-button" title="New session" onClick={() => onOpenTerminal(project)}>
                  <PlusIcon size={14} />
                </button>
                <button className="icon-button danger" title="Remove project" onClick={() => onRemoveProject(project)}>
                  <CloseIcon size={14} />
                </button>
              </div>
              {sessions.length > 0 && (
                <div className="session-list">
                  {sessions.map((t) => (
                    <div key={t.id} className="session-row" onClick={() => onFocusNode(t.id)}>
                      <TerminalIcon size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
                      <span>{t.data.title || 'Claude Code'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-footer">
        <button className="button" onClick={onAddProject}>
          <FolderIcon size={14} />
          Add project
        </button>
        <div className="hint">
          Drag a project onto the canvas to start a session there, or double-click the canvas to write a prompt.
        </div>
      </div>
    </aside>
  )
}
