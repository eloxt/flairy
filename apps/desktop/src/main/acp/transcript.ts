import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, rmSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Full on-disk transcripts for ACP worker runs. The in-memory tail (4KB) is
 * for the live Runs panel; diagnosing a failed or misbehaving worker needs the
 * whole session — every message, tool call (with raw input), permission
 * decision, and the adapter's stderr. One append-only log per run, path
 * derived from the run id so nothing new is persisted in SQLite.
 */

const DIR_NAME = 'worker-transcripts'
const MAX_AGE_DAYS = 14

export function transcriptsDir(): string {
  return join(app.getPath('userData'), DIR_NAME)
}

/** Derived, deterministic path. Run ids are UUIDs; sanitize anyway. */
export function transcriptPath(runId: string): string {
  return join(transcriptsDir(), `${runId.replace(/[^a-zA-Z0-9-]/g, '')}.log`)
}

export function hasTranscript(runId: string): boolean {
  return existsSync(transcriptPath(runId))
}

export interface TranscriptWriter {
  /** Raw text (message chunks) — appended verbatim. */
  raw(text: string): void
  /** One timestamped event line (tool calls, permissions, lifecycle). */
  event(line: string): void
  close(): void
}

const ts = (): string => new Date().toISOString().slice(11, 19)

export function createTranscript(runId: string): TranscriptWriter {
  let stream: WriteStream | null = null
  try {
    mkdirSync(transcriptsDir(), { recursive: true })
    stream = createWriteStream(transcriptPath(runId), { flags: 'a' })
  } catch (err) {
    // Transcripts are diagnostics — a failure to open one must never fail the run.
    console.error('[transcript] open failed', err)
  }
  // Track whether the last write ended mid-line so event lines stay on their own line.
  let midLine = false
  const write = (text: string): void => {
    try {
      stream?.write(text)
    } catch {
      // Disk full etc. — drop silently, the run itself matters more.
    }
  }
  return {
    raw: (text) => {
      if (!text) return
      write(text)
      midLine = !text.endsWith('\n')
    },
    event: (line) => {
      write(`${midLine ? '\n' : ''}[${ts()}] ${line}\n`)
      midLine = false
    },
    close: () => {
      try {
        stream?.end()
      } catch {
        // already closed
      }
      stream = null
    }
  }
}

/** Drop transcripts older than the retention window (called once at startup). */
export function sweepOldTranscripts(): void {
  const dir = transcriptsDir()
  if (!existsSync(dir)) return
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true })
      } catch {
        // Skip files we can't stat/remove.
      }
    }
  } catch (err) {
    console.error('[transcript] sweep failed', err)
  }
}
