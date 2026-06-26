import { useRef, useState } from 'react'
import {
  useUi,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH
} from '@/store/ui-store'
import { cn } from '@/lib/utils'
import { RightSidebar } from './RightSidebar'

/**
 * The right details drawer. Mirrors the left sidebar's offcanvas behaviour: a
 * **gap** in the flex row collapses to push the chat area, while the actual
 * fixed-width panel slides off to the right via a transform. Because the panel
 * keeps its full width and only translates, its contents never reflow during the
 * open/close animation (unlike resizing the width directly).
 *
 * A thin handle on the left edge drags to resize; the open width is persisted.
 */
export function RightPanel(): React.JSX.Element {
  const open = useUi((s) => s.rightPanelOpen)
  const width = useUi((s) => s.rightPanelWidth)
  const setWidth = useUi((s) => s.setRightPanelWidth)
  // While dragging, the width tracks the cursor 1:1, so the open/close easing
  // must be off or it would lag a frame behind.
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ startX: number; startW: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!open) return
    e.preventDefault()
    dragState.current = { startX: e.clientX, startW: width }
    setDragging(true)

    const onMove = (ev: PointerEvent): void => {
      const s = dragState.current
      if (!s) return
      // The panel grows as the cursor moves left (toward the chat), so subtract.
      const max = Math.min(RIGHT_PANEL_MAX_WIDTH, Math.round(window.innerWidth * 0.6))
      setWidth(Math.min(max, Math.max(RIGHT_PANEL_MIN_WIDTH, s.startW + (s.startX - ev.clientX))))
    }
    const onUp = (): void => {
      dragState.current = null
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const ease = dragging ? '' : 'transition-[width,transform] duration-200 ease-linear'

  return (
    // Gap: reserves the panel's width in the flex row and collapses to 0 when
    // closed (this is what pushes the chat area). `relative` so the handle, which
    // must not be clipped, can sit on its left edge.
    <div
      className={cn('relative h-full shrink-0', dragging ? '' : 'transition-[width] duration-200 ease-linear')}
      style={{ width: open ? width : 0 }}
    >
      {/* Drag-to-resize handle straddling the left edge (the chat ↔ panel border). */}
      <div
        onPointerDown={onPointerDown}
        className={cn(
          'absolute inset-y-0 left-0 z-20 w-1 -translate-x-1/2 cursor-col-resize',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border/70 after:transition-colors',
          'hover:after:bg-border',
          dragging && 'after:bg-primary',
          !open && 'pointer-events-none opacity-0'
        )}
      />
      {/* Clip window (fills the gap): hides the panel as it slides out right. */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Frosted rail matching the left sidebar (bg-sidebar → translucent under
            vibrancy). The inset shadow sits on its inner left edge, so the seam
            shadow falls onto the panel and slides away with it when closed. */}
        <div
          className={cn(
            'absolute inset-y-0 right-0 bg-sidebar shadow-[inset_4px_0_12px_-8px_var(--rail-shadow)]',
            ease
          )}
          style={{ width, transform: open ? 'translateX(0)' : 'translateX(100%)' }}
        >
          <RightSidebar />
        </div>
      </div>
    </div>
  )
}
