import React from 'react'

type AreaSelectionRect = {
  left: number
  top: number
  width: number
  height: number
}

type WorkspaceKanbanAreaSelectionOverlayProps = {
  rect: AreaSelectionRect | null
}

export default function WorkspaceKanbanAreaSelectionOverlay({
  rect
}: WorkspaceKanbanAreaSelectionOverlayProps): React.JSX.Element | null {
  if (!rect) {
    return null
  }

  return (
    <div
      data-workspace-board-selection-rect=""
      className="pointer-events-none absolute z-30 rounded-md border border-sidebar-ring bg-sidebar-ring/15"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }}
    />
  )
}
