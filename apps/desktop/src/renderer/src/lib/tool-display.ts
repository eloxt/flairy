/**
 * Maps internal tool names (read, ls, bash…) to i18n catalog KEYS for the UI.
 * End users shouldn't see machine names; keep this aligned with the local tools
 * registered in apps/desktop/src/main/agent/tools.
 *
 * Returns a `tools.*` key (e.g. `'tools.read'`) that the caller resolves with
 * `t(...)` / `i18n.t(...)`. The labels are bare verb phrases ("read a file",
 * "读取文件") so they slot into the `approval.wantsTo` / `chat.toolRunning`
 * sentence templates. Unknown / MCP tools fall back to `'tools.fallback'`
 * ("use a tool" / "工具"), matching the previous catch-all behavior.
 */
const BUILTIN_KEYS: Record<string, string> = {
  read: 'tools.read',
  write: 'tools.write',
  edit: 'tools.edit',
  bash: 'tools.bash',
  grep: 'tools.grep',
  find: 'tools.find',
  ls: 'tools.ls',
  ask: 'tools.ask',
  web_search: 'tools.web_search',
  web_fetch: 'tools.web_fetch',
  todo_write: 'tools.todo_write',
  github_read: 'tools.github_read',
  github_create_repo: 'tools.github_create_repo',
  github_push: 'tools.github_push',
  github_issue_write: 'tools.github_issue_write',
  github_pr_write: 'tools.github_pr_write',
  dispatch_task: 'tools.dispatch_task',
  dispatch_review: 'tools.dispatch_review'
}

/** Resolve the i18n key for a tool name's user-facing label. */
export function toolDisplayKey(name: string | undefined): string {
  if (!name) return 'tools.fallback'
  return BUILTIN_KEYS[name] ?? 'tools.fallback'
}

/**
 * Map a tool name to a coarse *activity* bucket for the grouped summary line
 * (e.g. "Read 3 files, ran 2 commands"). Distinct from `toolDisplayKey`: that
 * labels one call as a verb phrase; this aggregates a run of calls into a
 * count-pluralized clause. Returns an `activity.*` key stem; unknown / MCP tools
 * fall into `other`. Keep aligned with BUILTIN_KEYS above.
 */
const ACTIVITY_BUCKETS: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'grep',
  find: 'find',
  ls: 'ls',
  ask: 'ask',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  todo_write: 'todo_write',
  // All GitHub operations aggregate into one clause; both dispatch flavors
  // (implement / review) into another.
  github_read: 'github',
  github_create_repo: 'github',
  github_push: 'github',
  github_issue_write: 'github',
  github_pr_write: 'github',
  dispatch_task: 'dispatch',
  dispatch_review: 'dispatch'
}

/** Resolve the activity bucket stem (e.g. `'read'`, `'other'`) for a tool name. */
export function toolBucket(name: string | undefined): string {
  if (!name) return 'other'
  return ACTIVITY_BUCKETS[name] ?? 'other'
}

/**
 * The single most telling argument of a tool call, for the expanded tool row —
 * the file a read/write/edit touched, the directory an ls listed, the pattern a
 * grep/find searched, the command bash ran. Returns a trimmed string, or
 * `undefined` when there's nothing worth showing (so the label stands alone).
 *
 * Called from both the live stream (`tool_execution_start.args`) and replay
 * (a pi `toolCall` part's `arguments`), so a watched run and its reload show the
 * same hint. Kept separate from `toolDisplayKey` because this is the raw value
 * (a path / pattern / command), not a translated label.
 */
export function toolArgSummary(name: string | undefined, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'ls':
      return str(a.path)
    case 'bash':
      return str(a.command)
    case 'grep':
    case 'find':
      return str(a.pattern)
    case 'web_search':
      return str(a.query)
    case 'web_fetch':
      return str(a.url)
    case 'github_read':
      return str(a.action)
    case 'github_create_repo':
      return str(a.name)
    case 'github_push':
      return str(a.branch)
    case 'github_issue_write':
      return str(a.title) ?? (a.number != null ? `${str(a.action) ?? ''} #${a.number}`.trim() : str(a.action))
    case 'github_pr_write':
      return str(a.title) ?? (a.number != null ? `#${a.number}` : str(a.action))
    case 'dispatch_task':
      return a.issueNumber != null ? `#${a.issueNumber}` : undefined
    case 'dispatch_review':
      return a.prNumber != null ? `PR #${a.prNumber}` : undefined
    default:
      return undefined
  }
}

/**
 * The full argument object of a tool call, pretty-printed as JSON for the
 * expanded detail's "Arguments" card. Returns `undefined` when there's nothing
 * worth showing (no args, or an empty object) so the card is skipped. Called
 * from both the live stream (`tool_execution_start.args`) and replay (a pi
 * `toolCall` part's `arguments`), so a watched run and its reload render the
 * same. Purely presentational — never sent to the model.
 */
/**
 * Display cap for the pretty-printed arguments. A `write` of a large file would
 * otherwise pin the whole file content in the store as a second copy (the diff
 * view already shows it); past this, the card shows a truncation note instead.
 */
const MAX_TOOL_ARGS_CHARS = 20_000

export function formatToolArgs(args: unknown): string | undefined {
  if (args == null) return undefined
  if (typeof args === 'string') {
    const s = args.trim()
    if (!s) return undefined
    return s.length > MAX_TOOL_ARGS_CHARS ? s.slice(0, MAX_TOOL_ARGS_CHARS) + '\n…' : s
  }
  try {
    const json = JSON.stringify(args, null, 2)
    if (!json || json === '{}' || json === 'null') return undefined
    return json.length > MAX_TOOL_ARGS_CHARS
      ? json.slice(0, MAX_TOOL_ARGS_CHARS) + '\n…'
      : json
  } catch {
    return undefined
  }
}
