import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import { getWorkspaceStatus } from './workspace-status'

function sortBoardWorktrees(a: Worktree, b: Worktree): number {
  return b.lastActivityAt - a.lastActivityAt || a.displayName.localeCompare(b.displayName)
}

export function groupWorkspaceKanbanWorktrees(params: {
  worktrees: readonly Worktree[]
  visibleWorktreeIds: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): Map<WorkspaceStatus, Worktree[]> {
  const { worktrees, visibleWorktreeIds, workspaceStatuses } = params
  const grouped = new Map<WorkspaceStatus, Worktree[]>(
    workspaceStatuses.map((status) => [status.id, []])
  )

  for (const worktree of worktrees) {
    if (!visibleWorktreeIds.has(worktree.id)) {
      continue
    }
    grouped.get(getWorkspaceStatus(worktree, workspaceStatuses))!.push(worktree)
  }

  for (const items of grouped.values()) {
    items.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || sortBoardWorktrees(a, b))
    clusterByWorkspaceGroup(items)
  }
  return grouped
}

export function clusterByWorkspaceGroup(items: Worktree[]): void {
  if (items.length < 2) {
    return
  }
  const seenGroups = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!
    if (a.isPinned) {
      continue
    }
    const groupId = a.workspaceGroupId
    if (!groupId || seenGroups.has(groupId)) {
      continue
    }
    seenGroups.add(groupId)
    let insertAt = i + 1
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!
      if (b.isPinned) {
        continue
      }
      if (b.workspaceGroupId === groupId) {
        if (j !== insertAt) {
          const moved = items.splice(j, 1)[0]!
          items.splice(insertAt, 0, moved)
        }
        insertAt++
      }
    }
  }
}
