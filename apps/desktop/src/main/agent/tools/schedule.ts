import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Cron } from 'croner'
import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  type ScheduledTask
} from '../../store/db'
import { abortTaskRun, nextRunFor, syncTaskJob } from '../../schedule/scheduler'
import { getLanguage } from '../../locale'

/**
 * schedule — let the agent create and manage tasks that Flairy runs for the
 * user automatically, on a recurring schedule or once at a set time. A task is
 * bound to the session it was created in: the trigger and the reply land in
 * that same conversation (headless, schedule-origin turn). Local-only per
 * device — the definitions never sync. Exempt from the approval gate in
 * agent-service.ts: creating a task only writes local metadata; the run itself
 * is gated per-tool when it fires (schedule channel auto-denies).
 */

/** Minimum gap between recurring fires — stops a runaway model from spamming runs. */
const MIN_INTERVAL_MS = 15 * 60_000

const ACTIONS = ['create', 'list', 'get', 'update', 'pause', 'resume', 'delete'] as const

export function createScheduleTool(sessionId: string): AgentTool<any> {
  return {
    name: 'schedule',
    label: 'schedule',
    description:
      'Create and manage tasks that Flairy runs for the user automatically — on a repeating schedule (daily, weekly, every few hours…) or once at a specific time. ' +
      'Use `create` when the user asks for something to happen regularly or later ("every morning…", "each Monday…", "tomorrow at 9 remind me…"). ' +
      'The task runs headlessly in THIS conversation and its reply appears here; the user gets notified. Do not promise any other delivery mechanism. ' +
      '`prompt` must be a complete, self-contained instruction: when it runs, you will NOT remember this conversation or any previous run — spell out what to find or do, the output format, and the language to answer in. ' +
      '`title` and `scheduleDescription` must be short and in the user\'s language ("每天早上 8 点" / "Every day at 8:00 AM"); never show raw schedule expressions to the user. ' +
      'Times are in the user\'s local timezone. Recurring schedules use a standard 5-field cron expression in `cron`; a one-time task uses `onceAt` instead. ' +
      'After `create`, confirm naturally and mention the next run time. Use `list` first to find a task id before update/pause/resume/delete; `get` returns one task\'s full details including its instruction. ' +
      'Do NOT create a task for something you can simply do right now.',
    parameters: Type.Object(
      {
        action: Type.Union(
          ACTIONS.map((a) => Type.Literal(a)),
          { description: 'What to do: create / list / update / pause / resume / delete.' }
        ),
        id: Type.Optional(
          Type.String({ description: 'Task id (from `list`). Required for update/pause/resume/delete.' })
        ),
        title: Type.Optional(
          Type.String({ description: 'Short task name in the user\'s language (e.g. "HackerNews 早报").' })
        ),
        prompt: Type.Optional(
          Type.String({
            description:
              'Self-contained instruction executed on every run, with no memory of this chat. Include everything: what to do, output format, reply language.'
          })
        ),
        cron: Type.Optional(
          Type.String({
            description:
              '5-field cron expression, local time (e.g. "0 8 * * *" = daily 8:00, "0 9 * * 1" = Mondays 9:00). Recurring tasks only.'
          })
        ),
        onceAt: Type.Optional(
          Type.String({
            description: 'One-time run moment as ISO 8601 local time (e.g. "2026-07-30T08:00:00"). Instead of `cron`.'
          })
        ),
        scheduleDescription: Type.Optional(
          Type.String({
            description: 'The schedule in plain words, in the user\'s language (e.g. "每天早上 8 点"). Required for create.'
          })
        )
      },
      { additionalProperties: false }
    ),
    executionMode: 'sequential',
    execute: async (_id, params: any) => {
      const action = params?.action as (typeof ACTIONS)[number]
      switch (action) {
        case 'create':
          return doCreate(sessionId, params)
        case 'list':
          return doList(sessionId)
        case 'get':
          return doGet(requireTask(params?.id))
        case 'update':
          return doUpdate(requireTask(params?.id), params)
        case 'pause':
          return setStatus(requireTask(params?.id), 'paused')
        case 'resume':
          return setStatus(requireTask(params?.id), 'active')
        case 'delete':
          return setStatus(requireTask(params?.id), 'deleted')
        default:
          throw new Error(`Unknown action "${String(params?.action)}" — use one of: ${ACTIONS.join(', ')}.`)
      }
    }
  }
}

type ToolResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> }

function requireTask(id: unknown): ScheduledTask {
  const taskId = typeof id === 'string' ? id.trim() : ''
  if (!taskId) throw new Error('This action requires a task "id" — call {action: "list"} first to find it.')
  const task = getScheduledTask(taskId)
  if (!task || task.status === 'deleted') throw new Error(`No task with id "${taskId}" — call {action: "list"}.`)
  return task
}

/** Validate a cron expression; returns nothing, throws a model-readable error. */
function validateCron(cron: string): void {
  let probe: Cron
  try {
    // Callback-less Cron = pure pattern evaluator; nothing gets scheduled.
    probe = new Cron(cron)
  } catch (err) {
    throw new Error(`Invalid schedule expression "${cron}": ${err instanceof Error ? err.message : String(err)}`)
  }
  const next = probe.nextRuns(2)
  probe.stop()
  if (next.length < 2) return // fires at most once more — no interval to enforce
  if (next[1].getTime() - next[0].getTime() < MIN_INTERVAL_MS) {
    throw new Error('Schedules must be at least 15 minutes apart. Pick a less frequent schedule.')
  }
}

function parseOnceAt(raw: string): number {
  const at = new Date(raw).getTime()
  if (Number.isNaN(at)) throw new Error(`Could not parse "${raw}" as a date/time — use ISO 8601 like "2026-07-30T08:00:00".`)
  if (at <= Date.now()) throw new Error('That time is already in the past — pick a future moment.')
  return at
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' })
}

function doCreate(sessionId: string, params: any): ToolResult {
  const title = str(params?.title)
  const prompt = str(params?.prompt)
  const scheduleText = str(params?.scheduleDescription)
  const cron = str(params?.cron) || undefined
  const onceRaw = str(params?.onceAt) || undefined
  if (!title || !prompt || !scheduleText) {
    throw new Error('create requires "title", "prompt", and "scheduleDescription".')
  }
  if (!!cron === !!onceRaw) {
    throw new Error('create requires exactly one of "cron" (recurring) or "onceAt" (one-time).')
  }
  let onceAt: number | undefined
  if (cron) validateCron(cron)
  else onceAt = parseOnceAt(onceRaw!)

  const task = createScheduledTask({
    sessionId,
    title,
    prompt,
    cron,
    onceAt,
    scheduleText,
    nextRunAt: nextRunFor({ cron, onceAt }) ?? undefined
  })
  syncTaskJob(task.id)
  const created = getScheduledTask(task.id) ?? task
  return {
    content: [
      {
        type: 'text',
        text: `Scheduled task created (id ${created.id}). Schedule: ${created.scheduleText}. Next run: ${fmtTime(created.nextRunAt)}.`
      }
    ],
    details: { action: 'create', task: created }
  }
}

function doList(sessionId: string): ToolResult {
  const tasks = listScheduledTasks(true)
  if (tasks.length === 0) {
    return {
      content: [{ type: 'text', text: 'No scheduled tasks exist yet.' }],
      details: { action: 'list', tasks: [] }
    }
  }
  const lines = tasks.map((task) => {
    const where = task.sessionId === sessionId ? 'this conversation' : 'another conversation'
    return (
      `- id ${task.id} · "${task.title}" · ${task.scheduleText} · status: ${task.status}` +
      ` · next run: ${fmtTime(task.nextRunAt)} · runs in ${where}`
    )
  })
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: { action: 'list', tasks }
  }
}

/**
 * Full details of one task — notably its instruction. The scheduled-run trigger
 * message references the task by id instead of repeating the (possibly long)
 * instruction on every run; when the model can't recall it from context (e.g.
 * compression folded the creation away), it fetches it here on demand.
 */
function doGet(task: ScheduledTask): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          `Task "${task.title}" (id ${task.id}) · ${task.scheduleText} · status: ${task.status}` +
          ` · next run: ${fmtTime(task.nextRunAt)}\n` +
          `Instruction: ${task.prompt}`
      }
    ],
    details: { action: 'get', task }
  }
}

function doUpdate(task: ScheduledTask, params: any): ToolResult {
  const patch: Parameters<typeof updateScheduledTask>[1] = {}
  const title = str(params?.title)
  const prompt = str(params?.prompt)
  const scheduleText = str(params?.scheduleDescription)
  const cron = str(params?.cron) || undefined
  const onceRaw = str(params?.onceAt) || undefined
  if (title) patch.title = title
  if (prompt) patch.prompt = prompt
  if (scheduleText) patch.scheduleText = scheduleText
  if (cron && onceRaw) throw new Error('Pass only one of "cron" or "onceAt".')
  if (cron) {
    validateCron(cron)
    patch.cron = cron
    patch.onceAt = undefined
    patch.nextRunAt = nextRunFor({ cron }) ?? undefined
  } else if (onceRaw) {
    const onceAt = parseOnceAt(onceRaw)
    patch.onceAt = onceAt
    patch.cron = undefined
    patch.nextRunAt = onceAt
  }
  if ((cron || onceRaw) && !scheduleText) {
    throw new Error('When changing the schedule, also pass an updated "scheduleDescription".')
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('update needs at least one of "title", "prompt", "cron"/"onceAt", "scheduleDescription".')
  }
  const next = updateScheduledTask(task.id, patch)!
  syncTaskJob(task.id)
  const fresh = getScheduledTask(task.id) ?? next
  return {
    content: [
      { type: 'text', text: `Task "${fresh.title}" updated. Schedule: ${fresh.scheduleText}. Next run: ${fmtTime(fresh.nextRunAt)}.` }
    ],
    details: { action: 'update', task: fresh }
  }
}

function setStatus(task: ScheduledTask, status: 'paused' | 'active' | 'deleted'): ToolResult {
  const patch: Parameters<typeof updateScheduledTask>[1] = { status }
  // Resuming recomputes the next occurrence (the paused-era one may be stale);
  // an expired one-shot cannot be resumed — nothing left to run.
  if (status === 'active') {
    if (task.onceAt && task.onceAt <= Date.now()) {
      throw new Error('That one-time task\'s moment has already passed — create a new task instead.')
    }
    patch.nextRunAt = nextRunFor(task) ?? undefined
  }
  const next = updateScheduledTask(task.id, patch)!
  syncTaskJob(task.id)
  if (status !== 'active') abortTaskRun(task.id)
  const verb = status === 'paused' ? 'paused' : status === 'active' ? 'resumed' : 'deleted'
  const tail =
    status === 'active' ? ` Next run: ${fmtTime(getScheduledTask(task.id)?.nextRunAt)}.` : ''
  return {
    content: [{ type: 'text', text: `Task "${next.title}" ${verb}.${tail}` }],
    details: { action: verb, task: next }
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
