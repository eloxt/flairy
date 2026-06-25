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
  setRightPanelOpen: (open: boolean) => void
  setRightPanelWidth: (width: number) => void
}

export const useUi = create<UiState>((set, get) => ({
  rightPanelOpen: readOpen(),
  rightPanelWidth: readWidth(),
  toggleRightPanel: () => get().setRightPanelOpen(!get().rightPanelOpen),
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
