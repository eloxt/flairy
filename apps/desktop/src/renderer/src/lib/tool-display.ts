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
  todo_write: 'tools.todo_write'
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
  todo_write: 'todo_write'
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
    default:
      return undefined
  }
}
