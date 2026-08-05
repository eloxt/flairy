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

/**
 * Unicode spaces models sometimes emit inside paths (NBSP, en/em spaces,
 * narrow NBSP, ideographic space) — normalized to a regular space before
 * resolution. Ported from pi-agent-core (harness/tools/path-utils.ts).
 */
const UNICODE_SPACES = /[  -   　]/g
const NARROW_NO_BREAK_SPACE = ' '

/**
 * Clean up model-authored path quirks before resolution: normalize Unicode
 * spaces to ASCII space and strip a leading `@` (models copy `@path` mention
 * syntax from prompts into tool calls). Ported from pi-agent-core.
 */
function normalizeToolPath(filePath: string): string {
  const normalized = filePath.replace(UNICODE_SPACES, ' ')
  return normalized.startsWith('@') ? normalized.slice(1) : normalized
}

/** Expand a leading `~` to the home directory. */
export function expandPath(filePath: string): string {
  const path = normalizeToolPath(filePath)
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return path
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

/**
 * Like `resolveWithinRoots`, but when the exact path doesn't exist, try
 * filename variants the model plausibly meant: macOS screenshot names carry a
 * narrow no-break space before "AM"/"PM" (the model types a regular space),
 * macOS filesystems store names NFD-decomposed, and smart apostrophes in names
 * arrive as ASCII `'`. First existing variant wins; all variants are character
 * substitutions of the already-contained resolved path, so containment holds.
 * Read-only callers only — mutating tools must not guess at names. Ported from
 * pi-agent-core (resolveReadToolPath).
 */
export async function resolveReadPathWithinRoots(
  filePath: string,
  cwd: string,
  extraRoots: string[] = []
): Promise<string> {
  const resolved = resolveWithinRoots(filePath, cwd, extraRoots)
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize('NFD'),
    resolved.replace(/'/g, '’'),
    resolved.normalize('NFD').replace(/'/g, '’')
  ]
  for (const variant of new Set(variants)) {
    if (await pathExists(variant)) return variant
  }
  return resolved
}
