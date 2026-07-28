import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  type WriteStream
} from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { TranscriptEvent } from '@shared/ipc'

/**
 * Structured on-disk transcripts for ACP worker runs, one JSONL file per run
 * (path derived from the run id — nothing persisted in SQLite). The in-memory
 * tail (4KB) feeds the live Runs panel; this is the full record the in-app
 * transcript viewer renders: every message, thought, tool call with raw input,
 * permission decision, stderr, and the final outcome.
 *
 * Streaming text (messages/thoughts/stderr) arrives as many small chunks;
 * writing each as its own event would bloat the file and fragment the viewer,
 * so the writer coalesces per stream and flushes on stream switch, size
 * threshold, or close.
 */

const DIR_NAME = 'worker-transcripts'
const MAX_AGE_DAYS = 14
/** Coalesced text blocks flush at this size even without a stream switch. */
const FLUSH_THRESHOLD = 16_384
/** Reader cap: don't ship unbounded logs across IPC. */
const MAX_READ_EVENTS = 5_000

export function transcriptsDir(): string {
  return join(app.getPath('userData'), DIR_NAME)
}

/** Derived, deterministic path. Run ids are UUIDs; sanitize anyway. */
export function transcriptPath(runId: string): string {
  return join(transcriptsDir(), `${runId.replace(/[^a-zA-Z0-9-]/g, '')}.jsonl`)
}

export function hasTranscript(runId: string): boolean {
  return existsSync(transcriptPath(runId))
}

type TextStreamType = 'message' | 'thought' | 'stderr'

export interface TranscriptWriter {
  meta(data: { backend: string; command: string; cwd: string; readOnly: boolean; prompt: string }): void
  text(stream: TextStreamType, chunk: string): void
  tool(title: string, kind?: string, input?: string): void
  toolFailed(title: string, output?: string): void
  plan(entries: string[]): void
  permission(data: { title: string; kind?: string; locations: string[]; allowed: boolean }): void
  configError(text: string): void
  outcome(outcome: string, error?: string): void
  close(): void
}

export function createTranscript(runId: string): TranscriptWriter {
  let stream: WriteStream | null = null
  try {
    mkdirSync(transcriptsDir(), { recursive: true })
    stream = createWriteStream(transcriptPath(runId), { flags: 'a' })
  } catch (err) {
    // Transcripts are diagnostics — a failure to open one must never fail the run.
    console.error('[transcript] open failed', err)
  }

  let bufType: TextStreamType | null = null
  let buf = ''
  let bufStart = 0

  const writeEvent = (e: TranscriptEvent): void => {
    try {
      stream?.write(`${JSON.stringify(e)}\n`)
    } catch {
      // Disk full etc. — drop silently, the run itself matters more.
    }
  }
  const flush = (): void => {
    if (bufType && buf) writeEvent({ t: bufStart, type: bufType, text: buf })
    bufType = null
    buf = ''
  }

  return {
    meta: (data) => writeEvent({ t: Date.now(), type: 'meta', ...data }),
    text: (type, chunk) => {
      if (!chunk) return
      if (bufType !== type) {
        flush()
        bufType = type
        bufStart = Date.now()
      }
      buf += chunk
      if (buf.length >= FLUSH_THRESHOLD) flush()
    },
    tool: (title, kind, input) => {
      flush()
      writeEvent({ t: Date.now(), type: 'tool', title, kind, input })
    },
    toolFailed: (title, output) => {
      flush()
      writeEvent({ t: Date.now(), type: 'tool_failed', title, output })
    },
    plan: (entries) => {
      flush()
      writeEvent({ t: Date.now(), type: 'plan', entries })
    },
    permission: (data) => {
      flush()
      writeEvent({ t: Date.now(), type: 'permission', ...data })
    },
    configError: (text) => {
      flush()
      writeEvent({ t: Date.now(), type: 'config_error', text })
    },
    outcome: (outcome, error) => {
      flush()
      writeEvent({ t: Date.now(), type: 'outcome', outcome, error })
    },
    close: () => {
      flush()
      try {
        stream?.end()
      } catch {
        // already closed
      }
      stream = null
    }
  }
}

/**
 * Parse a run's transcript for the in-app viewer. Tolerant of a torn final
 * line (crash mid-write); capped so a runaway log can't flood IPC — when over
 * the cap the OLDEST events are dropped and `truncated` says so.
 */
export function readTranscript(runId: string): { events: TranscriptEvent[]; truncated: boolean } {
  const p = transcriptPath(runId)
  if (!existsSync(p)) return { events: [], truncated: false }
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch {
    return { events: [], truncated: false }
  }
  const lines = raw.split('\n').filter(Boolean)
  const truncated = lines.length > MAX_READ_EVENTS
  const events: TranscriptEvent[] = []
  for (const line of truncated ? lines.slice(-MAX_READ_EVENTS) : lines) {
    try {
      events.push(JSON.parse(line) as TranscriptEvent)
    } catch {
      // Torn line — skip.
    }
  }
  return { events, truncated }
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
