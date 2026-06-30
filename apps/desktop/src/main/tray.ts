import { app, Menu, Tray, nativeImage } from "electron";
import { join } from "node:path";
import { t } from "./locale";
import { showMainWindow } from "./windows";

/**
 * System tray / menu-bar presence. Lets Flairy keep running with no window open
 * (see the close-to-tray behavior in windows.ts) and gives a way back in:
 *   - left-click  → show + focus the main window
 *   - right-click → a small menu (open main window / quit)
 *
 * On Linux, AppIndicator doesn't emit click/right-click events, so we fall back
 * to a set context menu (the only interaction model it supports there).
 */

let tray: Tray | null = null;

/** Resolve the bundled tray icon, mirroring the bin resolution in agent/tools/binaries.ts. */
function trayIconPath(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, "tray")
    : join(app.getAppPath(), "resources", "tray");
  return join(dir, process.platform === "darwin" ? "iconTemplate.png" : "icon.png");
}

/** Create the tray icon and wire its interactions. No-op if one already exists. */
export function createTray(): void {
  if (tray) return;
  const image = nativeImage.createFromPath(trayIconPath());
  // macOS menu-bar icons are monochrome templates so they adapt to light/dark.
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Flairy");

  const menu = Menu.buildFromTemplate([
    { label: t("tray.open"), click: () => showMainWindow() },
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() },
  ]);

  if (process.platform === "linux") {
    // AppIndicator only supports a set context menu (no click events).
    tray.setContextMenu(menu);
  } else {
    // Keep left-click free to show the window; pop the menu on right-click only.
    // (Calling setContextMenu would make macOS open the menu on left-click too.)
    tray.on("click", () => showMainWindow());
    tray.on("right-click", () => tray?.popUpContextMenu(menu));
  }
}

/** Remove the tray icon (on quit). */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
