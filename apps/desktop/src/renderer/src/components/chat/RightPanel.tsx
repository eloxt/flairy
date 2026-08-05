import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
 * The open/close toggle is an always-visible grabber pill at the vertical
 * middle of the divider (the window's right edge while closed): dim at rest,
 * on hover its two segments tilt into a chevron pointing the action's
 * direction. Clicking toggles; dragging it resizes (same as the divider
 * handle), and a drag suppresses the click so letting go after a resize never
 * collapses the panel.
 */
export function RightPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useUi((s) => s.rightPanelOpen)
  const toggle = useUi((s) => s.toggleRightPanel)
  const width = useUi((s) => s.rightPanelWidth)
  const setWidth = useUi((s) => s.setRightPanelWidth)
  // While dragging, the width tracks the cursor 1:1, so the open/close easing
  // must be off or it would lag a frame behind.
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ startX: number; startW: number } | null>(null)
  // Mount the panel's CONTENT only while it's open (plus the close animation):
  // a closed panel otherwise keeps RightSidebar subscribed to `messages`, and
  // its ModelPanel re-scans the whole thread on every streamed token — pure
  // waste while nothing is visible. Unmount is delayed past the 200ms slide so
  // the content doesn't blink out mid-animation.
  const [contentMounted, setContentMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setContentMounted(true)
      return
    }
    const timer = setTimeout(() => setContentMounted(false), 250)
    return () => clearTimeout(timer)
  }, [open])
  // Set when a pointerdown on the grabber turns into an actual resize drag, so
  // the click that fires on release doesn't also toggle the panel.
  const movedRef = useRef(false)

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!open) return
    e.preventDefault()
    dragState.current = { startX: e.clientX, startW: width }
    movedRef.current = false
    setDragging(true)

    const onMove = (ev: PointerEvent): void => {
      const s = dragState.current
      if (!s) return
      if (Math.abs(ev.clientX - s.startX) > 3) movedRef.current = true
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
      {/* Always-visible grabber at the vertical middle of the divider, on the
          chat side so it stays inside the window while the panel is closed. At
          rest its two segments align into one dim pill; on hover (or keyboard
          focus) they tilt into a thin chevron pointing the way the panel will
          move — "<" to open, ">" to close. Click toggles; while open, dragging
          it resizes exactly like the divider handle it overlaps (movedRef then
          swallows the click). */}
      <button
        type="button"
        onPointerDown={onPointerDown}
        onClick={() => {
          if (movedRef.current) return
          toggle()
        }}
        aria-label={t('panel.toggle')}
        aria-pressed={open}
        title={t('panel.toggle')}
        className={cn(
          'group absolute right-full top-1/2 z-30 flex h-16 w-6 -translate-y-1/2 flex-col items-center justify-center outline-none',
          open ? 'cursor-col-resize' : 'cursor-pointer'
        )}
      >
        {/* The 1px counter-translations overlap the segments' rounded ends so
            the resting state reads as one continuous line. Each segment pivots
            around its inner end (origin-bottom / origin-top): the joint stays
            pinned while the outer ends swing, so the chevron's tip is the two
            rounded caps stacked on one point — no concave notch. The dimming
            lives on this wrapper (not the segments' bg color): a group opacity
            composites the two bars into one layer first, so the overlap
            doesn't render double-dense. */}
        <div
          aria-hidden
          className="flex flex-col items-center opacity-35 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <span
            className={cn(
              'h-[18px] w-[3px] origin-bottom translate-y-[1px] rounded-full bg-muted-foreground transition-transform duration-150 ease-out',
              open
                ? 'group-hover:-rotate-[20deg] group-focus-visible:-rotate-[20deg]'
                : 'group-hover:rotate-[20deg] group-focus-visible:rotate-[20deg]'
            )}
          />
          <span
            className={cn(
              'h-[18px] w-[3px] origin-top -translate-y-[1px] rounded-full bg-muted-foreground transition-transform duration-150 ease-out',
              open
                ? 'group-hover:rotate-[20deg] group-focus-visible:rotate-[20deg]'
                : 'group-hover:-rotate-[20deg] group-focus-visible:-rotate-[20deg]'
            )}
          />
        </div>
      </button>
      {/* Clip window (fills the gap): hides the panel as it slides out right. */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Frosted rail matching the left sidebar (bg-sidebar → translucent under
            vibrancy). The inset shadow sits on its inner left edge, so the seam
            shadow falls onto the panel and slides away with it when closed. */}
        <div
          className={cn(
            'absolute inset-y-0 right-0 bg-sidebar',
            ease
          )}
          style={{ width, transform: open ? 'translateX(0)' : 'translateX(100%)' }}
        >
          {contentMounted && <RightSidebar />}
        </div>
      </div>
    </div>
  )
}
