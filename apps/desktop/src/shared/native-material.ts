/**
 * Whether the OS can back a window with a translucent native material: always
 * on macOS (vibrancy / transparent windows), and on Windows 11 22H2+ where the
 * DWM system-backdrop API behind Electron's `backgroundMaterial` exists. On
 * older Windows builds the option is silently ignored and the window paints
 * opaque, so both sides of the treatment gate on this check: main only sets
 * `backgroundMaterial`, and the renderer only goes transparent (`.vibrancy`),
 * when it returns true — otherwise transparent page regions would show the bare
 * window backing instead of a material.
 *
 * Imported by the main and preload bundles only. The local `process`
 * declaration keeps the file compilable under the renderer tsconfig (which
 * excludes Node's types); `getSystemVersion` is Electron's, available in both
 * processes.
 */
declare const process: { platform: string; getSystemVersion(): string }

/** Windows 11 22H2 — first build with DWMWA_SYSTEMBACKDROP_TYPE (Mica/Acrylic). */
const WIN11_22H2_BUILD = 22621

export function supportsWindowMaterial(): boolean {
  if (process.platform === 'darwin') return true
  if (process.platform !== 'win32') return false
  const build = Number(process.getSystemVersion().split('.')[2])
  return build >= WIN11_22H2_BUILD
}
