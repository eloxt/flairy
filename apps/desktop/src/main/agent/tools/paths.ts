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

/** True when `abs` is `root` itself or nested anywhere beneath it. */
function isWithin(abs: string, root: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve a path relative to `cwd` and enforce that it stays inside `cwd`.
 * Throws if the resolved path escapes the working directory.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath)
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  if (!isWithin(abs, cwd)) {
    throw new Error(`Path escapes the working directory: ${filePath}`)
  }
  return abs
}

/**
 * Like `resolveToCwd`, but additionally permits paths that fall inside any of
 * `extraRoots` (read-only roots outside the session cwd, e.g. the materialized
 * skills directory). Relative paths still resolve against `cwd`; absolute paths
 * are accepted as long as they land in `cwd` OR one of the extra roots. Used by
 * the read-only tools (read/grep/find/ls) so the agent can open skill files for
 * progressive disclosure regardless of which working directory the session uses.
 */
export function resolveWithinRoots(filePath: string, cwd: string, extraRoots: string[] = []): string {
  const expanded = expandPath(filePath)
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  if (isWithin(abs, cwd) || extraRoots.some((root) => isWithin(abs, root))) {
    return abs
  }
  throw new Error(`Path escapes the working directory: ${filePath}`)
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}
