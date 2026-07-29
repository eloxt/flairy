import { BrowserWindow, Notification, powerMonitor } from 'electron'
import { Cron } from 'croner'
import { IPC } from '@shared/ipc'
import { SCHEDULE_RUN_PREFIX } from '@shared/injected-events'
import type { AgentManager } from '../agent/agent-manager'
import type { ServerClient } from '../sync/server-client'
import type { TelegramManager } from '../telegram/telegram-manager'
import type { TurnOrigin } from '../agent/turn-origin'
import {
  getScheduledTask,
  getSession,
  listOverdueScheduledTasks,
  listScheduledTasks,
  updateScheduledTask,
  type ScheduledTask
} from '../store/db'
import { broadcast, showMainWindow } from '../windows'
import { t } from '../locale'

/**
 * The scheduled-task engine. croner owns the precise timing (one `Cron` job per
 * active task, cron pattern or one-shot Date); this module owns everything
 * around it: firing a headless agent run into the task's own session, catch-up
 * for triggers missed while the app was asleep or closed, and the completion
 * reminders (desktop notification + Telegram push).
 *
 * A run is just a `submit()` of a machine-authored user message (the
 * SCHEDULE_RUN_PREFIX injected-event convention) with a `schedule` turn origin,
 * so the reply lands in the conversation the task was created in, streams live
 * if that conversation happens to be open, and persists/syncs like any other
 * turn. The origin routes approvals/`ask` to the auto-deny schedule channel —
 * a headless run can never block on a human.
 */

/** Sweep cadence for the overdue catch-up scan (also retries busy-session skips). */
const OVERDUE_SWEEP_MS = 60_000

/** Cap for the notification body preview. */
const NOTIFY_BODY_LIMIT = 180

let agents: AgentManager | null = null
let server: ServerClient | null = null
let telegram: TelegramManager | null = null

/** Live croner jobs keyed by task id. Mirrors DB rows with status 'active'. */
const jobs = new Map<string, Cron>()

/** In-flight runs keyed by sessionId (one run per session at a time). */
const running = new Map<string, { taskId: string; title: string; lastText: string }>()

let overdueTimer: ReturnType<typeof setInterval> | undefined
let offEvents: (() => void) | undefined
let offConfig: (() => void) | undefined
let sawConfig = false

export function initScheduler(a: AgentManager, s: ServerClient, tg: TelegramManager): void {
  agents = a
  server = s
  telegram = tg

  for (const task of listScheduledTasks()) syncTaskJob(task.id)

  // Catch-up scans: at startup, on wake from sleep, when the LLM config first
  // arrives (runs skipped for a missing config become due again), and a slow
  // safety-net sweep (also retries "session was busy" skips). Each claims
  // before submitting, so overlapping scans can never double-fire.
  runOverdueScan()
  overdueTimer = setInterval(runOverdueScan, OVERDUE_SWEEP_MS)
  overdueTimer.unref()
  powerMonitor.on('resume', runOverdueScan)
  offConfig = server.onConfig(() => {
    if (sawConfig) return
    sawConfig = true
    runOverdueScan()
  })

  const onEvent = (env: {
    sessionId: string
    event: { type: string; role?: string; text?: string }
    origin: TurnOrigin
  }): void => {
    try {
      if (env.origin.kind !== 'schedule') return
      const run = running.get(env.sessionId)
      if (!run || run.taskId !== env.origin.taskId) return
      if (env.event.type === 'message_end' && env.event.role === 'assistant') {
        run.lastText = env.event.text ?? run.lastText
      } else if (env.event.type === 'agent_end') {
        running.delete(env.sessionId)
        finishRun(env.sessionId, run)
      }
    } catch (err) {
      console.error('[schedule] delivery failed:', err)
    }
  }
  a.events.on('event', onEvent)
  offEvents = () => a.events.off('event', onEvent)
}

export function stopScheduler(): void {
  for (const job of jobs.values()) job.stop()
  jobs.clear()
  running.clear()
  if (overdueTimer) clearInterval(overdueTimer)
  overdueTimer = undefined
  powerMonitor.removeListener('resume', runOverdueScan)
  offEvents?.()
  offEvents = undefined
  offConfig?.()
  offConfig = undefined
}

/**
 * Reconcile one task's croner job with its DB row (create/replace/remove).
 * The schedule tool and the session-delete paths call this after any mutation.
 */
export function syncTaskJob(taskId: string): void {
  jobs.get(taskId)?.stop()
  jobs.delete(taskId)
  const task = getScheduledTask(taskId)
  if (!task || task.status !== 'active') return
  try {
    let job: Cron
    if (task.cron) {
      job = new Cron(task.cron, () => fire(taskId))
    } else if (task.onceAt && task.onceAt > Date.now()) {
      job = new Cron(new Date(task.onceAt), () => fire(taskId))
    } else {
      // Overdue one-shot: no timer needed — the catch-up scan claims it.
      return
    }
    jobs.set(taskId, job)
    const next = job.nextRun()
    if (next && next.getTime() !== task.nextRunAt) {
      updateScheduledTask(taskId, { nextRunAt: next.getTime() })
    }
  } catch (err) {
    console.error(`[schedule] invalid schedule for task ${taskId}:`, err)
  }
}

/** Drop every job whose task can no longer fire (after cascading session deletes). */
export function reconcileJobs(): void {
  const live = new Set(listScheduledTasks().map((task) => task.id))
  for (const [id, job] of jobs) {
    if (live.has(id)) continue
    job.stop()
    jobs.delete(id)
  }
}

/** The next scheduled occurrence for a task's cron/once spec, or null. */
export function nextRunFor(task: Pick<ScheduledTask, 'cron' | 'onceAt'>): number | null {
  if (task.cron) {
    // Callback-less Cron = pure pattern evaluator; nothing gets scheduled.
    const probe = new Cron(task.cron)
    const next = probe.nextRun()
    probe.stop()
    return next ? next.getTime() : null
  }
  if (task.onceAt) return task.onceAt
  return null
}

/**
 * Abort a task's in-flight run, if any (the schedule tool calls this on
 * pause/delete so a cancelled task doesn't keep talking).
 */
export function abortTaskRun(taskId: string): void {
  if (!agents) return
  for (const [sessionId, run] of running) {
    if (run.taskId !== taskId) continue
    running.delete(sessionId)
    void agents.get(sessionId)?.abort()
  }
}

function runOverdueScan(): void {
  try {
    for (const task of listOverdueScheduledTasks(Date.now())) fire(task.id)
  } catch (err) {
    console.error('[schedule] overdue scan failed:', err)
  }
}

/**
 * Fire one run of a task, if it can run right now. Skips (leaving `next_run_at`
 * in the past so a later scan retries) when the LLM config hasn't arrived or
 * the session is mid-turn; claims (advances `next_run_at` / completes a
 * one-shot) BEFORE the un-awaited submit so nothing can double-fire.
 */
function fire(taskId: string): void {
  try {
    const task = getScheduledTask(taskId)
    if (!task || task.status !== 'active' || !agents) return
    if (!server?.getConfig()?.llm.main) return
    if (!getSession(task.sessionId)) {
      // The conversation is gone (crash between delete and cascade, import
      // drift…): the task has nowhere to run or reply — retire it.
      updateScheduledTask(taskId, { status: 'deleted' })
      syncTaskJob(taskId)
      return
    }
    if (running.has(task.sessionId) || agents.get(task.sessionId)?.isRunning()) return

    const now = Date.now()
    if (task.cron) {
      const next = jobs.get(taskId)?.nextRun()?.getTime() ?? nextRunFor(task)
      updateScheduledTask(taskId, { lastRunAt: now, nextRunAt: next ?? undefined })
    } else {
      updateScheduledTask(taskId, { status: 'completed', lastRunAt: now, nextRunAt: undefined })
      syncTaskJob(taskId)
    }

    running.set(task.sessionId, { taskId, title: task.title, lastText: '' })
    const origin: TurnOrigin = { kind: 'schedule', taskId }
    // The trigger deliberately does NOT repeat the task's instruction: the
    // create/update tool call earlier in this same conversation already carries
    // it, so re-sending it every run just burns tokens. When the model can't
    // recall it exactly (context compression), it fetches via schedule `get`.
    const text =
      `${SCHEDULE_RUN_PREFIX} Scheduled task "${task.title}" (id ${taskId}) is due — run it now, ` +
      'following that task\'s instruction from earlier in this conversation (its create/update call); ' +
      `if you cannot recall the exact instruction, call schedule {"action":"get","id":"${taskId}"} first. ` +
      'The user is not present: do not ask questions or wait for input — reply with one self-contained ' +
      'message the user will read later.'
    // Deliberately un-awaited (telegram-manager precedent): a run that blocks
    // must never stall the scheduler; completion arrives via the event bus.
    try {
      void agents.getOrCreate(task.sessionId, origin).submit(text, undefined, origin)
    } catch (err) {
      running.delete(task.sessionId)
      console.error(`[schedule] failed to start run for task ${taskId}:`, err)
    }
  } catch (err) {
    console.error(`[schedule] fire(${taskId}) failed:`, err)
  }
}

/** A run ended: remind the user (focus-guarded OS notification + Telegram). */
function finishRun(sessionId: string, run: { taskId: string; title: string; lastText: string }): void {
  // The task may have been deleted mid-run — then the reply is moot.
  const task = getScheduledTask(run.taskId)
  if (!task || task.status === 'deleted') return
  notifyDone(sessionId, run.title, run.lastText)
  if (run.lastText.trim()) void telegram?.sendScheduledResult(sessionId, run.lastText)
}

function notifyDone(sessionId: string, title: string, text: string): void {
  if (!Notification.isSupported() || BrowserWindow.getFocusedWindow()) return
  const body = text.trim()
    ? text.trim().replace(/\s+/g, ' ').slice(0, NOTIFY_BODY_LIMIT)
    : t('scheduleFailedBody')
  const n = new Notification({ title: `${t('scheduleDoneTitle')} · ${title}`, body })
  n.on('click', () => {
    showMainWindow()
    const meta = getSession(sessionId)
    if (meta) broadcast(IPC.ScheduleOpenSession, meta)
  })
  n.show()
}
