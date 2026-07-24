import { globalShortcut } from "electron";
import type { LauncherShortcutStatus } from "@shared/ipc";
import { getLauncherShortcutPref, setLauncherShortcutPref } from "./store/db";
import { toggleLauncherWindow } from "./windows";

/**
 * Global (system-wide) shortcuts. Currently just one: the quick-launcher summon
 * chord. The chord is a preference (SQLite settings KV); changing it in Settings
 * re-registers on the spot. Registration can fail when another app owns the
 * chord — we persist the choice anyway and report `registered: false` so the
 * Settings UI can show a plain-language hint.
 */

let registeredOk = false;

/** (Re)register the launcher shortcut from the saved preference. */
export function syncLauncherShortcut(): boolean {
  // Only launcher chords are ever registered, so a blanket unregister is safe
  // and avoids tracking the previously-registered accelerator.
  globalShortcut.unregisterAll();
  const accelerator = getLauncherShortcutPref();
  if (!accelerator) {
    registeredOk = true; // "off" is a successfully-applied state
    return true;
  }
  try {
    registeredOk = globalShortcut.register(accelerator, () => toggleLauncherWindow());
  } catch {
    // Malformed accelerator strings throw; treat like a failed registration.
    registeredOk = false;
  }
  return registeredOk;
}

export function getLauncherShortcutStatus(): LauncherShortcutStatus {
  return { accelerator: getLauncherShortcutPref(), registered: registeredOk };
}

/** Persist a new chord ('' = off) and re-register immediately. */
export function setLauncherShortcut(accelerator: string): LauncherShortcutStatus {
  setLauncherShortcutPref(accelerator);
  syncLauncherShortcut();
  return getLauncherShortcutStatus();
}

/** Unregister everything (before quit). */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
