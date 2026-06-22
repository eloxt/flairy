import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Path helpers for the tool implementations.
 *
 * FLAIRY DEVIATION FROM pi-coding-agent: pi's tools accept any relative or
 * absolute path and read/write anywhere on disk. Flairy targets non-technical
 * users and runs the agent against a per-session working directory, so every
 * tool path is CONFINED to `cwd`. `resolveToCwd` throws if a path escapes it.
 * This is the same containment the previous hand-written tools enforced.
 */

/** Expand a leading `~` to the home directory. */
export function expandPath(filePath: string): string {
  if (filePath === '~') return homedir()
  if (filePath.startsWith('~/')) return resolve(homedir(), filePath.slice(2))
  return filePath
}

/**
 * Resolve a path relative to `cwd` and enforce that it stays inside `cwd`.
 * Throws if the resolved path escapes the working directory.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath)
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  const rel = relative(cwd, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the working directory: ${filePath}`)
  }
  return abs
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}
