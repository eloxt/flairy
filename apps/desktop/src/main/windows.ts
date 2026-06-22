import { shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

/**
 * Window management. Each window loads its own renderer HTML entry (`index` for
 * the main app, `settings` for the Settings window) — built as separate bundles
 * by electron-vite, so neither window ships the other's code. The preload +
 * security flags are identical across windows so every window reaches the same
 * typed `window.api` bridge.
 */

const PRELOAD = join(import.meta.dirname, '../preload/index.mjs')
const RENDERER_DIR = join(import.meta.dirname, '../renderer')

/** Single reused Settings window, if open. */
let settingsWindow: BrowserWindow | null = null

// contextIsolation is the real renderer<->main boundary. sandbox is false
// because with "type": "module" the preload is ESM, and Electron's sandbox
// requires a CommonJS preload. nodeIntegration stays off.
const webPreferences = {
  preload: PRELOAD,
  sandbox: false,
  contextIsolation: true,
  nodeIntegration: false
} as const

/** Load a renderer HTML entry (`index` → main app, `settings` → Settings window). */
function loadRenderer(win: BrowserWindow, entry: 'index' | 'settings' = 'index'): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    win.loadURL(entry === 'index' ? base : `${base}/${entry}.html`)
  } else {
    win.loadFile(join(RENDERER_DIR, `${entry}.html`))
  }
}

/** External links open in the OS browser, never as in-app navigations. */
function openLinksExternally(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    // Center the traffic lights inside the 48px (h-12) custom title bar:
    // ~14px cluster → y = (48 - 14) / 2 ≈ 17.
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences
  })

  win.on('ready-to-show', () => win.show())
  openLinksExternally(win)
  loadRenderer(win)
  return win
}

/** Open the standalone Settings window, or focus it if already open. */
export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  const win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 520,
    minHeight: 480,
    show: false,
    title: 'Settings',
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    settingsWindow = null
  })
  openLinksExternally(win)
  loadRenderer(win, 'settings')
  settingsWindow = win
}

/** Send an event to every live renderer window (config + auth changes fan out). */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}
