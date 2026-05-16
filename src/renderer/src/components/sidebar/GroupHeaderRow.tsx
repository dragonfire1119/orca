import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { WorkspaceGroupColor, WorkspaceGroupId } from '../../../../shared/types'
import { getWorkspaceGroupSwatchClass } from './workspace-status'

type Props = {
  groupId: WorkspaceGroupId
  name: string
  color: WorkspaceGroupColor
  memberCount: number
  collapsed: boolean
  isRenaming?: boolean
  onToggleCollapsed: (groupId: WorkspaceGroupId) => void
  onRenameCommit: (groupId: WorkspaceGroupId, name: string) => void
  onRenameCancel: (groupId: WorkspaceGroupId) => void
  onContextMenu: (groupId: WorkspaceGroupId, e: React.MouseEvent) => void
}

export function GroupHeaderRow({
  groupId,
  name,
  color,
  memberCount,
  collapsed,
  isRenaming,
  onToggleCollapsed,
  onRenameCommit,
  onRenameCancel,
  onContextMenu
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming) {
      setDraft(name)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isRenaming, name])

  const Chevron = collapsed ? ChevronRight : ChevronDown

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 select-none"
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(groupId, e)
      }}
    >
      <button
        type="button"
        aria-label={collapsed ? 'Expand group' : 'Collapse group'}
        onClick={() => onToggleCollapsed(groupId)}
        className="opacity-70 hover:opacity-100"
      >
        <Chevron size={14} />
      </button>
      <span
        aria-hidden
        data-testid="workspace-group-color-dot"
        className={`inline-block w-2 h-2 rounded-full ${getWorkspaceGroupSwatchClass(color)}`}
      />
      {isRenaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRenameCommit(groupId, draft)
            } else if (e.key === 'Escape') {
              onRenameCancel(groupId)
            }
          }}
          onBlur={() => onRenameCommit(groupId, draft)}
          className="flex-1 bg-transparent border-b border-border focus:outline-none text-sm"
        />
      ) : (
        <span className="flex-1 text-sm font-medium truncate">{name}</span>
      )}
      <span className="text-xs text-muted-foreground tabular-nums">{memberCount}</span>
    </div>
  )
}
