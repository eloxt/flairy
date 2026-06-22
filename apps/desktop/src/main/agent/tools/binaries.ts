import path from 'node:path'
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

export function resolveBinary(name: 'rg' | 'fd'): string {
  const override = process.env[ENV_OVERRIDES[name] ?? '']
  if (override) return override

  const exe = process.platform === 'win32' ? `${name}.exe` : name

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', exe)
  }

  // Dev: binaries live in the repo's resources tree, split by platform/arch.
  return path.join(app.getAppPath(), 'resources', 'bin', `${process.platform}-${process.arch}`, exe)
}
