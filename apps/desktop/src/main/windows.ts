import { shell, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import liquidGlass from "electron-liquid-glass";
import { IPC } from "@shared/ipc";
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
type RendererEntry = "index" | "settings" | "image-viewer" | "launcher";

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
    // Center the traffic lights inside the 48px (h-12) custom title bar, which
    // now sits 8px lower (the inset panel's top gutter): ~14px cluster →
    // y = 8 + (48 - 14) / 2 ≈ 25.
    trafficLightPosition: { x: 20, y: 25 },
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

/**
 * Open the standalone Settings window, or focus it if already open. `tab`
 * preselects a settings tab on a fresh open (carried as a URL query the
 * renderer's SettingsPage reads once at mount).
 */
export function openSettingsWindow(tab?: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 780,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Settings",
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    // Same frosted treatment as the main window: the settings sidebar is a
    // translucent rail (`.vibrancy` on <html>), the content pane paints opaque.
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
  win.on("closed", () => {
    settingsWindow = null;
  });
  openLinksExternally(win);
  loadRenderer(win, "settings", tab ? `tab=${encodeURIComponent(tab)}` : "");
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

/* ---------- quick launcher (Spotlight-style) window ---------- */

/**
 * Singleton launcher window. Created lazily on first summon and then only
 * hidden/shown (never destroyed) so its renderer stays warm and a summon is
 * instant. Frameless + TRANSPARENT.
 *
 * On macOS the glass comes from the real thing: electron-liquid-glass inserts
 * a native NSGlassEffectView BEHIND the web content (Tahoe Liquid Glass;
 * gracefully degrades to the legacy blur material on older macOS), so the
 * renderer paints no surface of its own — window = card exactly, corners
 * rounded natively, and the window casts a real system shadow.
 *
 * Elsewhere (Windows) the renderer paints a translucent tint + CSS shadow
 * inside a 24px transparent gutter (no native material to lean on), so the
 * window is 2×24px taller than the card. Hence the mode-dependent heights —
 * the renderer mirrors them, keyed off the `glass=1` query.
 */
let launcherWindow: BrowserWindow | null = null;

/** Native Liquid Glass mode (the library safely no-ops off-mac). */
const LAUNCHER_GLASS = process.platform === "darwin";

const LAUNCHER_WIDTH = 640;
/** Collapsed: the capsule input row (+ shadow gutter in CSS mode). */
export const LAUNCHER_COLLAPSED_HEIGHT = LAUNCHER_GLASS ? 64 : 112;
/** Expanded: input + streaming reply area (+ gutter in CSS mode). */
export const LAUNCHER_EXPANDED_HEIGHT = LAUNCHER_GLASS ? 460 : 508;

/**
 * How long a hidden launcher keeps its conversation. Re-summon within this
 * window and the previous quick chat is still there to continue; after it, the
 * summon starts fresh automatically (the renderer also has a new-chat button
 * for an explicit reset at any time).
 */
const LAUNCHER_KEEP_MS = 5 * 60_000;

/** When the launcher was last hidden (0 = never shown yet → fresh). */
let launcherHiddenAt = 0;

function createLauncherWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: LAUNCHER_WIDTH,
    height: LAUNCHER_COLLAPSED_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    // NOTE: backdrop-filter CANNOT work in this window: Chromium only samples
    // a backdrop that lives inside an opaque-background subtree, and the whole
    // point here is a fully transparent page over the native glass view.
    // (Verified empirically — tiny-alpha backgrounds, dropping `transparent`,
    // layer promotion and un-clipping all fail; an opaque thread background
    // works but defeats the glass.) Floating chrome uses translucent tints.
    backgroundColor: "#00000000",
    // The native glass layer gives the window a real shape for the system
    // shadow; in CSS mode the shadow is painted by the renderer instead.
    hasShadow: LAUNCHER_GLASS,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences,
  });
  // Float above regular windows, and on macOS follow the user across Spaces.
  // Deliberately NOT `visibleOnFullScreen: true`: joining fullscreen Spaces
  // requires macOS to treat the app as an accessory, which HIDES the Dock icon
  // for the whole app. Keeping the Dock icon wins; summoning over a fullscreen
  // app just switches Spaces instead.
  win.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true);
  }
  // Spotlight behavior: clicking anywhere else dismisses the launcher.
  win.on("blur", () => win.hide());
  // Stamp EVERY hide path (blur, Esc, toggle, handoff) so the keep-window
  // countdown for the next summon starts from the moment it disappeared.
  win.on("hide", () => {
    launcherHiddenAt = Date.now();
  });
  win.on("closed", () => {
    if (launcherWindow === win) launcherWindow = null;
  });
  openLinksExternally(win);
  if (LAUNCHER_GLASS) {
    // Attach the native glass view once the page is up (the library wants the
    // content view to exist). 32px radius = a perfect capsule at the 64px
    // collapsed height, and reads Tahoe-native on the expanded panel.
    win.webContents.once("did-finish-load", () => {
      try {
        liquidGlass.addView(win.getNativeWindowHandle(), { cornerRadius: 32 });
      } catch (err) {
        console.error("[launcher] failed to attach glass view:", err);
      }
    });
  }
  loadRenderer(win, "launcher", LAUNCHER_GLASS ? "glass=1" : "");
  return win;
}

/**
 * Center the launcher on the display the cursor is on, top edge ~22% down the
 * work area (Spotlight-esque), then show it. Re-summoned within the keep
 * window, the previous conversation stays (current height kept, caret back in
 * the input); after it — or on first summon — the renderer resets to a fresh
 * collapsed chat.
 */
function presentLauncher(win: BrowserWindow): void {
  const reset =
    launcherHiddenAt === 0 || Date.now() - launcherHiddenAt > LAUNCHER_KEEP_MS;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const x = Math.round(area.x + (area.width - LAUNCHER_WIDTH) / 2);
  const y = Math.round(area.y + area.height * 0.22);
  const height = reset ? LAUNCHER_COLLAPSED_HEIGHT : win.getBounds().height;
  win.setBounds({ x, y, width: LAUNCHER_WIDTH, height });
  win.show();
  win.focus();
  // Transparent windows cache their shadow shape — recompute after the bounds
  // change or the old outline ghosts around the new one.
  if (LAUNCHER_GLASS) win.invalidateShadow();
  win.webContents.send(IPC.LauncherShown, { reset });
}

/** Toggle the launcher: hide if visible, else summon it (creating on first use). */
export function toggleLauncherWindow(): void {
  const existing = launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : null;
  if (existing) {
    if (existing.isVisible()) existing.hide();
    else presentLauncher(existing);
    return;
  }
  const win = createLauncherWindow();
  launcherWindow = win;
  // First summon: the renderer isn't ready yet — present once it is so the
  // window never flashes unpainted.
  win.once("ready-to-show", () => presentLauncher(win));
}

export function hideLauncherWindow(): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide();
}

/**
 * Resize the launcher to `height` px (renderer-driven: collapsed input vs
 * expanded reply view). Top edge stays put — the card grows downward. Clamped
 * to [collapsed, 70% of the work area] so it can't run off-screen.
 */
export function resizeLauncherWindow(height: number): void {
  const win = launcherWindow;
  if (!win || win.isDestroyed() || !Number.isFinite(height)) return;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const h = Math.min(
    Math.max(Math.round(height), LAUNCHER_COLLAPSED_HEIGHT),
    Math.round(area.height * 0.7),
  );
  win.setBounds({ ...bounds, height: h });
  if (LAUNCHER_GLASS) win.invalidateShadow();
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
