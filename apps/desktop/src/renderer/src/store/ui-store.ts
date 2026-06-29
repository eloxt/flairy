import { create } from 'zustand'

/**
 * Small renderer-only UI state, kept out of the hot-path chat store. Holds the
 * right details panel's open/closed flag and its width, both persisted to
 * localStorage so the choice survives reloads.
 */
const OPEN_KEY = 'flairy.rightPanelOpen'
const WIDTH_KEY = 'flairy.rightPanelWidth'

export const RIGHT_PANEL_MIN_WIDTH = 300
export const RIGHT_PANEL_MAX_WIDTH = 600
const RIGHT_PANEL_DEFAULT_WIDTH = 380

/**
 * Comfortable minimum for the chat column. Message content is capped at Tailwind's
 * `max-w-3xl` (48rem) inside `px-6` gutters (1.5rem each side) — 51rem ≈ 816px — so
 * below this the messages can no longer reach their intended width. We treat
 * opening the details panel as "squeezing" the chat only when it would push the
 * column under this; otherwise the window is left as-is.
 */
export const MIN_CHAT_WIDTH = 816

const clampWidth = (w: number): number =>
  Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(w)))

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? clampWidth(n) : RIGHT_PANEL_DEFAULT_WIDTH
  } catch {
    return RIGHT_PANEL_DEFAULT_WIDTH
  }
}

interface UiState {
  rightPanelOpen: boolean
  rightPanelWidth: number
  toggleRightPanel: () => void
  /** Open the details panel, first widening the window if it would squeeze the chat. */
  openRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelWidth: (width: number) => void
}

/**
 * Before opening the details panel, make sure it won't squeeze the chat column
 * below MIN_CHAT_WIDTH. The panel steals `panelWidth` px from the chat row; the
 * chat column currently spans that whole row (the panel is closed when we open
 * it), so its measured width is exactly the space the panel is about to share. If
 * what's left would be too narrow, ask main to grow the window by the shortfall —
 * the chat keeps its width and the window absorbs the panel instead. Opening only
 * ever grows the window; closing does nothing here (callers just clear the flag).
 */
function growWindowIfPanelWouldSqueeze(panelWidth: number): void {
  const col = document.querySelector('[data-chat-column]')
  if (!col) return
  const available = col.getBoundingClientRect().width
  const shortfall = MIN_CHAT_WIDTH - (available - panelWidth)
  if (shortfall > 0) void window.api?.growWindowWidth(Math.ceil(shortfall))
}

export const useUi = create<UiState>((set, get) => ({
  rightPanelOpen: readOpen(),
  rightPanelWidth: readWidth(),
  // Opening goes through openRightPanel so it can widen the window first; closing
  // is unconditional — just clear the flag (no width check on the way down).
  toggleRightPanel: () => {
    if (get().rightPanelOpen) get().setRightPanelOpen(false)
    else get().openRightPanel()
  },
  openRightPanel: () => {
    growWindowIfPanelWouldSqueeze(get().rightPanelWidth)
    get().setRightPanelOpen(true)
  },
  setRightPanelOpen: (open) => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      // ignore (private mode / storage disabled): state still updates in-memory
    }
    set({ rightPanelOpen: open })
  },
  setRightPanelWidth: (width) => {
    const w = clampWidth(width)
    try {
      localStorage.setItem(WIDTH_KEY, String(w))
    } catch {
      // ignore
    }
    set({ rightPanelWidth: w })
  }
}))
