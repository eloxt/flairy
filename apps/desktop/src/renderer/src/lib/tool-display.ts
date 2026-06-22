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
  ls: 'tools.ls'
}

/** Resolve the i18n key for a tool name's user-facing label. */
export function toolDisplayKey(name: string | undefined): string {
  if (!name) return 'tools.fallback'
  return BUILTIN_KEYS[name] ?? 'tools.fallback'
}
