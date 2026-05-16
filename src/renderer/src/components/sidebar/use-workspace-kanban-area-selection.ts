import React, { useCallback, useEffect, useRef, useState } from 'react'

type AreaSelectionRect = {
  left: number
  top: number
  width: number
  height: number
}

type AreaSelectionCardRect = {
  id: string
  rect: DOMRect
}

type AreaSelectionDragState = {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
  baseSelectedIds: Set<string>
  baseAnchorId: string | null
  cardRects: readonly AreaSelectionCardRect[]
  started: boolean
  frameId: number | null
}

type UpdateSelectionForArea = (
  areaIds: readonly string[],
  additive: boolean,
  baseSelectedIds?: ReadonlySet<string>,
  baseAnchorId?: string | null
) => void

type UseWorkspaceKanbanAreaSelectionParams = {
  open: boolean
  boardRef: React.RefObject<HTMLDivElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectionAnchorId: string | null
  updateSelectionForArea: UpdateSelectionForArea
}

const AREA_SELECTION_DRAG_THRESHOLD = 4

function getAreaSelectionRect(state: AreaSelectionDragState): AreaSelectionRect {
  const left = Math.min(state.startX, state.currentX)
  const top = Math.min(state.startY, state.currentY)
  return {
    left,
    top,
    width: Math.abs(state.currentX - state.startX),
    height: Math.abs(state.currentY - state.startY)
  }
}

function doRectsIntersect(a: AreaSelectionRect, b: DOMRect): boolean {
  return (
    a.left <= b.right &&
    a.left + a.width >= b.left &&
    a.top <= b.bottom &&
    a.top + a.height >= b.top
  )
}

function shouldIgnoreAreaSelectionStart(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  return Boolean(
    target.closest(
      [
        '[data-workspace-board-card-id]',
        '[data-workspace-pin-drop-target]',
        'a',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="menu"]',
        '[role="menuitem"]'
      ].join(',')
    )
  )
}

function isScrollbarPointerDown(event: React.PointerEvent<HTMLElement>): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const rect = target.getBoundingClientRect()
  const hitsVerticalScrollbar =
    target.scrollHeight > target.clientHeight && event.clientX >= rect.right - 14
  const hitsHorizontalScrollbar =
    target.scrollWidth > target.clientWidth && event.clientY >= rect.bottom - 14
  return hitsVerticalScrollbar || hitsHorizontalScrollbar
}

function getAreaSelectionCardRects(board: HTMLElement): AreaSelectionCardRect[] {
  const cardRects: AreaSelectionCardRect[] = []
  const seen = new Set<string>()
  const cards = board.querySelectorAll<HTMLElement>('[data-workspace-board-card-id]')
  for (const card of cards) {
    const id = card.dataset.workspaceBoardCardId
    if (!id || seen.has(id)) {
      continue
    }
    cardRects.push({ id, rect: card.getBoundingClientRect() })
    seen.add(id)
  }
  return cardRects
}

function getAreaSelectionCardIds(
  cardRects: readonly AreaSelectionCardRect[],
  selectionRect: AreaSelectionRect
): string[] {
  const ids: string[] = []
  for (const card of cardRects) {
    if (doRectsIntersect(selectionRect, card.rect)) {
      ids.push(card.id)
    }
  }
  return ids
}

export function useWorkspaceKanbanAreaSelection({
  open,
  boardRef,
  selectedWorktreeIds,
  selectionAnchorId,
  updateSelectionForArea
}: UseWorkspaceKanbanAreaSelectionParams): {
  areaSelectionRect: AreaSelectionRect | null
  handleAreaSelectionPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
} {
  const dragRef = useRef<AreaSelectionDragState | null>(null)
  const updateSelectionForAreaRef = useRef(updateSelectionForArea)
  const [areaSelectionRect, setAreaSelectionRect] = useState<AreaSelectionRect | null>(null)

  useEffect(() => {
    updateSelectionForAreaRef.current = updateSelectionForArea
  }, [updateSelectionForArea])

  const cancelAreaSelectionDrag = useCallback(() => {
    const state = dragRef.current
    if (state && state.frameId !== null) {
      window.cancelAnimationFrame(state.frameId)
    }
    dragRef.current = null
    setAreaSelectionRect(null)
  }, [])

  const flushAreaSelectionDrag = useCallback(() => {
    const state = dragRef.current
    const board = boardRef.current
    if (!state || !board) {
      return
    }

    state.frameId = null
    const deltaX = state.currentX - state.startX
    const deltaY = state.currentY - state.startY
    if (!state.started && Math.hypot(deltaX, deltaY) < AREA_SELECTION_DRAG_THRESHOLD) {
      return
    }

    state.started = true
    const viewportRect = getAreaSelectionRect(state)
    const boardRect = board.getBoundingClientRect()
    const clippedLeft = Math.max(viewportRect.left, boardRect.left)
    const clippedTop = Math.max(viewportRect.top, boardRect.top)
    const clippedRight = Math.min(viewportRect.left + viewportRect.width, boardRect.right)
    const clippedBottom = Math.min(viewportRect.top + viewportRect.height, boardRect.bottom)

    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) {
      setAreaSelectionRect(null)
      updateSelectionForAreaRef.current(
        [],
        state.additive,
        state.baseSelectedIds,
        state.baseAnchorId
      )
      return
    }

    setAreaSelectionRect({
      left: clippedLeft - boardRect.left,
      top: clippedTop - boardRect.top,
      width: clippedRight - clippedLeft,
      height: clippedBottom - clippedTop
    })
    updateSelectionForAreaRef.current(
      getAreaSelectionCardIds(state.cardRects, viewportRect),
      state.additive,
      state.baseSelectedIds,
      state.baseAnchorId
    )
  }, [boardRef])

  const scheduleAreaSelectionDragFlush = useCallback(() => {
    const state = dragRef.current
    if (!state || state.frameId !== null) {
      return
    }
    // Why: marquee hit-testing reads card layout, so keep it at frame cadence
    // instead of doing synchronous DOM work for every pointermove event.
    state.frameId = window.requestAnimationFrame(flushAreaSelectionDrag)
  }, [flushAreaSelectionDrag])

  const finishAreaSelectionDrag = useCallback(
    (event: PointerEvent) => {
      const state = dragRef.current
      if (!state) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      if (state.frameId !== null) {
        window.cancelAnimationFrame(state.frameId)
        state.frameId = null
      }
      flushAreaSelectionDrag()
      dragRef.current = null
      setAreaSelectionRect(null)
    },
    [flushAreaSelectionDrag]
  )

  const handleAreaSelectionPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        event.pointerType === 'touch' ||
        isScrollbarPointerDown(event) ||
        shouldIgnoreAreaSelectionStart(event.target)
      ) {
        return
      }

      const board = boardRef.current
      if (!board) {
        return
      }
      cancelAreaSelectionDrag()
      const isMac = navigator.userAgent.includes('Mac')
      const additive =
        event.shiftKey ||
        (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        additive,
        baseSelectedIds: new Set(selectedWorktreeIds),
        baseAnchorId: selectionAnchorId,
        cardRects: getAreaSelectionCardRects(board),
        started: false,
        frameId: null
      }
      event.preventDefault()
    },
    [boardRef, cancelAreaSelectionDrag, selectedWorktreeIds, selectionAnchorId]
  )

  useEffect(() => {
    if (!open) {
      cancelAreaSelectionDrag()
      return
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      event.preventDefault()
      scheduleAreaSelectionDragFlush()
    }

    const handlePointerUp = (event: PointerEvent): void => {
      if (!dragRef.current) {
        return
      }
      event.preventDefault()
      finishAreaSelectionDrag(event)
    }

    document.addEventListener('pointermove', handlePointerMove, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerUp, true)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerUp, true)
      cancelAreaSelectionDrag()
    }
  }, [cancelAreaSelectionDrag, finishAreaSelectionDrag, open, scheduleAreaSelectionDragFlush])

  return { areaSelectionRect, handleAreaSelectionPointerDown }
}
