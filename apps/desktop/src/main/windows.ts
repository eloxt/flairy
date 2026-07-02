import { shell, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { getCloseToTrayPref } from "./store/db";

/**
 * Window management. Each window loads its own renderer HTML entry (`index` for
 * the main app, `settings` for the Settings window) — built as separate bundles
 * by electron-vite, so neither window ships the other's code. The preload +
 * security flags are identical across windows so every window reaches the same
 * typed `window.api` bridge.
 */

const PRELOAD = join(import.meta.dirname, "../preload/index.mjs");
const RENDERER_DIR = join(import.meta.dirname, "../renderer");

/** Single reused Settings window, if open. */
let settingsWindow: BrowserWindow | null = null;

/**
 * The current main window. Tracked at module scope (not captured by callers) so
 * everything that pushes to the renderer — agent events, approval/question
 * prompts, dialogs — resolves the LIVE window at send time. On macOS the main
 * window can be closed and recreated via the dock (see app `activate`); a
 * captured reference would then be a destroyed object and every send would throw
 * "Object has been destroyed". Always go through getMainWindow().
 */
let mainWindow: BrowserWindow | null = null;

/** The live main window, or null if none is currently open (or it's destroyed). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/**
 * Set true once a real quit is underway (tray/menu Quit, Cmd+Q) so the main
 * window's `close` handler lets the window be destroyed instead of hiding it.
 */
let quitting = false;
export function markQuitting(): void {
  quitting = true;
}

/** Bring the main window to the front, recreating it if it was fully closed. */
export function showMainWindow(): void {
  const win = getMainWindow();
  if (win) {
    win.show();
    win.focus();
  } else {
    createMainWindow();
  }
}

// contextIsolation is the real renderer<->main boundary. sandbox is false
// because with "type": "module" the preload is ESM, and Electron's sandbox
// requires a CommonJS preload. nodeIntegration stays off.
const webPreferences = {
  preload: PRELOAD,
  sandbox: false,
  contextIsolation: true,
  nodeIntegration: false,
} as const;

/** Load a renderer HTML entry (`index` → main app, `settings` → Settings window). */
type RendererEntry = "index" | "settings" | "image-viewer";

/**
 * Load a renderer HTML entry. `query` (without a leading `?`) is appended so a
 * window can read parameters from `location.search` — used to tell the image
 * viewer which stashed image to fetch.
 */
function loadRenderer(
  win: BrowserWindow,
  entry: RendererEntry = "index",
  query = "",
): void {
  const search = query ? `?${query}` : "";
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    win.loadURL(
      entry === "index" ? `${base}${search}` : `${base}/${entry}.html${search}`,
    );
  } else {
    win.loadFile(
      join(RENDERER_DIR, `${entry}.html`),
      query ? { search } : undefined,
    );
  }
}

/** External links open in the OS browser, never as in-app navigations. */
function openLinksExternally(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });
}

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    // Center the traffic lights inside the 48px (h-12) custom title bar:
    // ~14px cluster → y = (48 - 14) / 2 ≈ 17.
    trafficLightPosition: { x: 16, y: 15 },
    // Transparent rails on macOS: the renderer paints the chat surface opaque and
    // leaves the side rails translucent (the `.vibrancy` class), so the desktop
    // shows through the sidebar/details panel. We use a genuinely transparent
    // window rather than the native `vibrancy` material: on macOS 26 (Tahoe) with
    // Electron 34 the NSVisualEffectView materials render as a flat opaque gray
    // and never reveal the desktop, so the frosted-glass approach is dead. A
    // `transparent` window lets the rail's low-alpha `--sidebar` tint show the
    // real desktop behind it (no blur, but actually see-through).
    ...(isMac
      ? {
          vibrancy: "popover" as const,
          visualEffectState: "active" as const,
          backgroundColor: "#00000000",
        }
      : {
          backgroundMaterial: "mica" as const,
        }),
    webPreferences,
  });

  win.on("ready-to-show", () => win.show());
  // Track the live main window so renderer-bound sends always resolve the current
  // one, even after a close→reopen on macOS. Clear the ref only if THIS window is
  // the one being destroyed (a later recreate overwrites it again).
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Close-to-tray: hide the window instead of destroying it so its renderer state
  // survives for an instant reopen. Bypassed during a real quit, and when the user
  // turned the preference off (then it closes like an ordinary window).
  win.on("close", (e) => {
    if (quitting) return;
    if (!getCloseToTrayPref()) return;
    e.preventDefault();
    win.hide();
  });
  openLinksExternally(win);
  loadRenderer(win);
  mainWindow = win;
  return win;
}

/** Open the standalone Settings window, or focus it if already open. */
export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 520,
    minHeight: 480,
    show: false,
    title: "Settings",
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences,
  });

  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    settingsWindow = null;
  });
  openLinksExternally(win);
  loadRenderer(win, "settings");
  settingsWindow = win;
}

/**
 * Open a standalone window showing a single image full size (zoom/pan handled in
 * the renderer). `id` keys the image main stashed for the viewer to fetch on load.
 * Each call spawns a fresh window so several images can be inspected side by side.
 */
export function openImageViewerWindow(id: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 320,
    minHeight: 240,
    show: false,
    title: "Image",
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences,
  });

  win.on("ready-to-show", () => win.show());
  openLinksExternally(win);
  loadRenderer(win, "image-viewer", `id=${encodeURIComponent(id)}`);
  return win;
}

/**
 * Widen the main window by `delta` px. Used when opening the details panel would
 * otherwise squeeze the chat column: the renderer asks for exactly the shortfall.
 * Clamped to the current display's work area, and the window is nudged left if
 * growing would push its right edge off-screen. Never shrinks. Animated on macOS
 * so the resize reads as one motion with the panel's slide-out.
 */
export function growMainWindowWidth(delta: number): void {
  const win = getMainWindow();
  const grow = Math.ceil(delta);
  if (!win || !Number.isFinite(grow) || grow <= 0) return;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width + grow, area.width);
  if (width <= bounds.width) return; // already as wide as the screen allows
  // Keep the (now wider) window fully on-screen: pull x left if the right edge
  // would spill past the work area, but never past its left edge.
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  win.setBounds({ x, y: bounds.y, width, height: bounds.height }, true);
}

/** Send an event to every live renderer window (config + auth changes fan out). */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
