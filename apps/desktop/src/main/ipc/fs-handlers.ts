import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { stat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { ipcMain } from 'electron'
import {
  IPC,
  type ListWorkspaceFilesArgs,
  type ListWorkspaceFilesResult,
  type ReadWorkspaceFileArgs,
  type ReadWorkspaceFileResult,
  type WorkspaceGitStatusEntry
} from '@shared/ipc'
import { listSessions, listRecentDirectories } from '../store/db'
import { resolveBinary } from '../agent/tools/binaries'

/**
 * Read-only filesystem IPC backing the Files tab (workspace tree + preview).
 * Both handlers only accept a `root` that is some known project session's
 * workspacePath — the renderer never gets arbitrary disk access, mirroring the
 * cwd-confinement the agent tools enforce.
 */

/** Enumeration cap: enough for any reasonable workspace, bounded for pathological ones. */
const MAX_FILES = 20_000
/** Preview size cap — bigger files render as a "too large" notice. */
const MAX_PREVIEW_BYTES = 1024 * 1024
/** Bytes sniffed for a NUL to classify a file as binary (git's heuristic). */
const BINARY_SNIFF_BYTES = 8000
const GIT_STATUS_TIMEOUT_MS = 3000

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

/** True when `abs` is `root` itself or nested anywhere beneath it. */
function isWithin(abs: string, root: string): boolean {
  const rel = path.relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * A root is trusted iff the user explicitly picked it: a project session's
 * workspacePath, or a recent working-directory pick (covers the home screen's
 * pending workspace, which has no session until the first message — every
 * pick goes through addRecentDirectory before it can become pendingCwd).
 */
function isKnownWorkspace(root: string): boolean {
  return (
    listSessions().some((s) => s.workspacePath === root) ||
    listRecentDirectories().includes(root)
  )
}

/** All file paths under `root` (relative, posix), gitignore-aware via bundled fd. */
function listFilesWithFd(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      '--color=never',
      '--type',
      'f',
      '--hidden',
      '--no-require-git',
      '--exclude',
      '.git',
      '--max-results',
      String(MAX_FILES),
      '--base-directory',
      root
    ]
    const child = spawn(resolveBinary('fd'), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const rl = createInterface({ input: child.stdout })
    const lines: string[] = []
    let stderr = ''

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    rl.on('line', (line) => {
      const trimmed = line.replace(/\r$/, '')
      if (trimmed) lines.push(toPosixPath(trimmed))
    })
    child.on('error', (error) => {
      rl.close()
      const msg =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Bundled fd binary not found. Set FLAIRY_FD_PATH to override.'
          : `Failed to run fd: ${error.message}`
      reject(new Error(msg))
    })
    child.on('close', (code) => {
      rl.close()
      if (code !== 0 && lines.length === 0) {
        reject(new Error(stderr.trim() || `fd exited with code ${code}`))
        return
      }
      resolve({ paths: lines, truncated: lines.length >= MAX_FILES })
    })
  })
}

/**
 * Working-tree status via system git, best-effort: end-user machines may have
 * no git at all, and the workspace may not be a repo — both resolve to null and
 * the tree simply renders without status tints.
 */
function readGitStatus(root: string): Promise<WorkspaceGitStatusEntry[] | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', root, 'status', '--porcelain', '-z'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, GIT_STATUS_TIMEOUT_MS)
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve(null)
        return
      }
      const entries: WorkspaceGitStatusEntry[] = []
      // -z output: NUL-separated `XY <path>` records; rename/copy records are
      // followed by one extra NUL-separated origin-path field to skip.
      const fields = out.split('\0')
      for (let i = 0; i < fields.length; i++) {
        const record = fields[i]
        if (record.length < 4) continue
        const x = record[0]
        const y = record[1]
        const filePath = record.slice(3)
        if (x === 'R' || x === 'C') i++ // skip the origin path field
        const status = mapGitStatus(x, y)
        if (status) entries.push({ path: filePath, status })
      }
      resolve(entries)
    })
  })
}

function mapGitStatus(x: string, y: string): WorkspaceGitStatusEntry['status'] | null {
  if (x === '?' || y === '?') return 'untracked'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'R' || x === 'C') return 'renamed'
  if (x === 'A') return 'added'
  if (x === 'M' || x === 'T' || y === 'M' || y === 'T') return 'modified'
  return null
}

export function registerFsHandlers(): void {
  ipcMain.handle(
    IPC.FsListFiles,
    async (_e, args: ListWorkspaceFilesArgs): Promise<ListWorkspaceFilesResult> => {
      if (!isKnownWorkspace(args.root)) {
        throw new Error('Unknown workspace root')
      }
      const [{ paths, truncated }, gitStatus] = await Promise.all([
        listFilesWithFd(args.root),
        readGitStatus(args.root)
      ])
      return { paths, truncated, gitStatus }
    }
  )

  ipcMain.handle(
    IPC.FsReadFile,
    async (_e, args: ReadWorkspaceFileArgs): Promise<ReadWorkspaceFileResult> => {
      if (!isKnownWorkspace(args.root)) {
        throw new Error('Unknown workspace root')
      }
      try {
        const abs = path.resolve(args.root, args.relPath)
        if (!isWithin(abs, args.root)) {
          return { kind: 'error', message: 'Path escapes the workspace' }
        }
        // Re-check after resolving symlinks so a link inside the workspace can't
        // point the read outside it.
        const real = await realpath(abs)
        const realRoot = await realpath(args.root)
        if (!isWithin(real, realRoot)) {
          return { kind: 'error', message: 'Path escapes the workspace' }
        }
        const info = await stat(real)
        if (!info.isFile()) {
          return { kind: 'error', message: 'Not a file' }
        }
        if (info.size > MAX_PREVIEW_BYTES) {
          return { kind: 'tooLarge', size: info.size }
        }
        const buf = await readFile(real)
        if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          return { kind: 'binary', size: info.size }
        }
        return { kind: 'text', content: buf.toString('utf-8'), size: info.size }
      } catch (e) {
        return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
      }
    }
  )
}
