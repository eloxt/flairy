import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewerImage } from '@shared/ipc'

const MIN_SCALE = 0.1
const MAX_SCALE = 20
/** Multiplier per wheel notch; raised to the (normalized) deltaY for smoothness. */
const WHEEL_ZOOM_BASE = 1.0015

interface Transform {
  scale: number
  /** Image top-left offset from the container top-left, in CSS px. */
  tx: number
  ty: number
}

/**
 * Standalone window that shows one user-attached image full size. The image is
 * fetched once from main (stashed there when the window opened) by the id in the
 * query string. Supports wheel-zoom toward the cursor, drag-to-pan, double-click
 * to reset, and Esc/Cmd-W to close.
 */
export function ImageViewer(): React.JSX.Element {
  const [image, setImage] = useState<ViewerImage | null>(null)
  const [missing, setMissing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  /** Natural image size, set on load; the basis for fit + zoom math. */
  const natural = useRef<{ w: number; h: number } | null>(null)
  const [t, setT] = useState<Transform>({ scale: 1, tx: 0, ty: 0 })
  /** Live drag state (pointer id + last client position), or null when idle. */
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)

  // Fetch (and consume) the image main stashed for this window on open.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id')
    if (!id) {
      setMissing(true)
      return
    }
    void window.api.getViewerImage(id).then((img) => {
      if (img) setImage(img)
      else setMissing(true)
    })
  }, [])

  /** Scale + offset that fits the image fully inside the container, centered. */
  const fitTransform = useCallback((): Transform => {
    const el = containerRef.current
    const nat = natural.current
    if (!el || !nat) return { scale: 1, tx: 0, ty: 0 }
    const cw = el.clientWidth
    const ch = el.clientHeight
    // Never upscale past 1× on fit — a small image shows at its true size.
    const scale = Math.min(cw / nat.w, ch / nat.h, 1)
    return { scale, tx: (cw - nat.w * scale) / 2, ty: (ch - nat.h * scale) / 2 }
  }, [])

  const reset = useCallback(() => setT(fitTransform()), [fitTransform])

  const onImgLoad = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    natural.current = { w: img.naturalWidth, h: img.naturalHeight }
    setT(fitTransform())
  }, [fitTransform])

  // Re-fit on window resize (only meaningful once the image has loaded).
  useEffect(() => {
    const onResize = (): void => {
      if (natural.current) setT(fitTransform())
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fitTransform])

  // Esc / Cmd-W close the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w')) {
        window.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Wheel-zoom toward the cursor. Non-passive so we can preventDefault the page
  // zoom/scroll; React's onWheel is passive, hence the manual listener.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (!natural.current) return
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setT((prev) => {
        const factor = WHEEL_ZOOM_BASE ** -e.deltaY
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor))
        // Keep the image point under the cursor fixed while scaling.
        const ratio = scale / prev.scale
        return { scale, tx: cx - (cx - prev.tx) * ratio, ty: cy - (cy - prev.ty) * ratio }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [image])

  const onPointerDown = (e: React.PointerEvent): void => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    setT((prev) => ({ ...prev, tx: prev.tx + dx, ty: prev.ty + dy }))
  }
  const endDrag = (e: React.PointerEvent): void => {
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  const src = image ? `data:${image.mimeType};base64,${image.data}` : ''

  return (
    <div
      ref={containerRef}
      onDoubleClick={reset}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative h-screen w-screen touch-none select-none overflow-hidden bg-black"
      style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
    >
      {/* Transparent strip to drag the frameless window (no native title bar
          with hiddenInset). Sits above the pan surface; the native traffic
          lights stay clickable on top of an app-region drag region. */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-8"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      {missing ? (
        <div className="flex h-full w-full items-center justify-center text-sm text-white/50">
          Image unavailable
        </div>
      ) : (
        image && (
          <img
            ref={imgRef}
            src={src}
            onLoad={onImgLoad}
            draggable={false}
            alt=""
            className="absolute left-0 top-0 max-w-none origin-top-left"
            style={{
              transform: `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})`
            }}
          />
        )
      )}
    </div>
  )
}
