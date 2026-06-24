import path from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'

/**
 * Resolves the path to a bundled CLI binary (`rg`, `fd`).
 *
 * The binaries are shipped per platform/arch (currently darwin-arm64 and
 * win32-x64) and copied into the app at build time via electron-builder's
 * per-platform `extraResources` (see package.json `build`), landing under
 * `<resources>/bin`.
 *
 * Resolution order:
 *   1. Explicit env override (FLAIRY_RG_PATH / FLAIRY_FD_PATH) — escape hatch
 *      for development or unsupported platforms.
 *   2. Packaged app: `<process.resourcesPath>/bin/<name>`.
 *   3. Dev (electron-vite): `<appPath>/resources/bin/<platform>-<arch>/<name>`.
 *
 * If the resolved file does not exist, the consuming tool surfaces a clear
 * spawn ENOENT error rather than failing here, so this never throws.
 */

const ENV_OVERRIDES: Record<string, string | undefined> = {
  rg: 'FLAIRY_RG_PATH',
  fd: 'FLAIRY_FD_PATH'
}

/**
 * Directory holding the bundled CLI binaries.
 *
 *   - Packaged app: `<process.resourcesPath>/bin`.
 *   - Dev (electron-vite): `<appPath>/resources/bin/<platform>-<arch>`.
 *
 * Used both to resolve a specific tool's absolute path (see `resolveBinary`)
 * and to prepend onto the bash tool's PATH so bundled tools are callable from
 * free-form shell commands (see `getShellEnv`).
 */
export function getBundledBinDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin')
  }
  return path.join(app.getAppPath(), 'resources', 'bin', `${process.platform}-${process.arch}`)
}

export function resolveBinary(name: 'rg' | 'fd'): string {
  const override = process.env[ENV_OVERRIDES[name] ?? '']
  if (override) return override

  const exe = process.platform === 'win32' ? `${name}.exe` : name
  return path.join(getBundledBinDir(), exe)
}

/**
 * Resolve the bundled POSIX shell on Windows.
 *
 * We ship the Unicode build of busybox-w32 (`busybox.exe`), a single ~700KB exe
 * providing an `ash` POSIX shell plus built-in coreutils applets (ls, grep, sed,
 * …) via standalone-shell mode. This lets the agent's bash-style commands run on
 * Windows without the user installing Git Bash, matching Flairy's zero-config
 * goal. The Unicode build is required so CJK paths/output survive (the plain
 * build uses the legacy OEM code page).
 *
 * Returns undefined off Windows, or when the binary is missing (unsupported
 * arch / dev machine without it), so callers fall back to cmd.exe.
 */
export function resolveBundledShell(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const p = path.join(getBundledBinDir(), 'busybox.exe')
  return existsSync(p) ? p : undefined
}
