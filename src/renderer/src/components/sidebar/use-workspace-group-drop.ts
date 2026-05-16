import { useCallback, useState } from 'react'
import type React from 'react'
import type { WorkspaceGroupId } from '../../../../shared/types'
import { hasWorkspaceDragData, readWorkspaceDragDataIds } from './workspace-status'

export function useWorkspaceGroupDrop(args: {
  onAssign: (worktreeIds: readonly string[], groupId: WorkspaceGroupId | null) => void
  groupId: WorkspaceGroupId | null
}): {
  isOver: boolean
  bind: React.HTMLAttributes<HTMLElement>
} {
  const [isOver, setIsOver] = useState(false)

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasWorkspaceDragData(e.dataTransfer)) {
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsOver(true)
  }, [])

  const onDragLeave = useCallback(() => setIsOver(false), [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasWorkspaceDragData(e.dataTransfer)) {
        return
      }
      e.preventDefault()
      setIsOver(false)
      const ids = readWorkspaceDragDataIds(e.dataTransfer)
      if (ids.length === 0) {
        return
      }
      args.onAssign(ids, args.groupId)
    },
    [args]
  )

  return {
    isOver,
    bind: { onDragOver, onDragLeave, onDrop }
  }
}
