import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { WorkspaceGroupColor, WorkspaceGroupId } from '../../../../shared/types'
import { WORKSPACE_GROUP_COLOR_IDS } from '../../../../shared/workspace-groups'
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
  onStartRename: (groupId: WorkspaceGroupId) => void
  onRecolor: (groupId: WorkspaceGroupId, color: WorkspaceGroupColor) => void
  onReorder: (groupId: WorkspaceGroupId, direction: 'up' | 'down') => void
  onUngroup: (groupId: WorkspaceGroupId) => void
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
  onStartRename,
  onRecolor,
  onReorder,
  onUngroup
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
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-2 px-2 py-1 select-none">
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onStartRename(groupId)}>Rename</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Change color</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {WORKSPACE_GROUP_COLOR_IDS.map((swatchColor) => (
              <ContextMenuItem key={swatchColor} onSelect={() => onRecolor(groupId, swatchColor)}>
                <span
                  aria-hidden
                  className={`inline-block w-2 h-2 rounded-full mr-2 ${getWorkspaceGroupSwatchClass(swatchColor)}`}
                />
                {swatchColor}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => onToggleCollapsed(groupId)}>
          {collapsed ? 'Expand' : 'Collapse'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onReorder(groupId, 'up')}>Move up</ContextMenuItem>
        <ContextMenuItem onSelect={() => onReorder(groupId, 'down')}>Move down</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onUngroup(groupId)}>Ungroup</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
