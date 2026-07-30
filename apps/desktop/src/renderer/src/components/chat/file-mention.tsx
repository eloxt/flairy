import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconFile, IconFolder } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/**
 * `@` file mentions for the composer (design borrowed from pi-coding-agent's
 * TUI autocomplete): when the session has a workspace, typing `@` at a token
 * boundary opens a fuzzy file picker over the workspace tree. Picking a file
 * inserts `@relative/path ` as plain text — the agent's own read/grep tools
 * resolve it, so nothing changes on the wire. Directories insert `@dir/` with
 * the popup kept open, so the user can keep drilling down. Paths with spaces
 * are wrapped as `@"path with space"`.
 *
 * The file list comes from the existing `fs:list-files` IPC (fd enumeration,
 * gitignore-aware, files only); directories are derived from the file paths.
 * Filtering happens here in the renderer against the cached list.
 */

interface MentionEntry {
  /** Workspace-relative posix path, no trailing slash. */
  path: string;
  /** Last path segment, for display and filename-first scoring. */
  name: string;
  lowerPath: string;
  lowerName: string;
  isDir: boolean;
}

/** The `@…` token under the cursor plus the filtered suggestions. */
interface MentionState {
  /** Index in the textarea value where the `@` starts. */
  start: number;
  /** The full token, `@` (and optional quote) included. */
  token: string;
  items: MentionEntry[];
  active: number;
}

/** Characters that end a path token (mirrors pi's PATH_DELIMITERS + newline). */
const DELIMITERS = new Set([" ", "\t", "\n", '"', "'", "="]);
const MAX_ITEMS = 20;
/** Re-list the workspace when the cached enumeration is older than this. */
const CACHE_TTL_MS = 30_000;

/**
 * Extract the `@…` token that ends at the cursor, or null when the cursor
 * isn't inside one. Handles the unclosed-quote form `@"src/my file` so paths
 * with spaces stay one token. Scans only the current line — quotes in earlier
 * prose shouldn't leak quoting state into the token.
 */
function extractAtToken(
  text: string,
  cursor: number,
): { start: number; token: string } | null {
  const before = text.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);

  let inQuote = false;
  let quoteStart = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuote = !inQuote;
      if (inQuote) quoteStart = i;
    }
  }
  if (inQuote && quoteStart > 0 && line[quoteStart - 1] === "@") {
    const at = quoteStart - 1;
    if (at === 0 || DELIMITERS.has(line[at - 1])) {
      return { start: lineStart + at, token: line.slice(at) };
    }
  }

  let tokenStart = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    if (DELIMITERS.has(line[i])) {
      tokenStart = i + 1;
      break;
    }
  }
  if (line[tokenStart] !== "@") return null;
  return { start: lineStart + tokenStart, token: line.slice(tokenStart) };
}

/**
 * pi's scoring: exact filename beats filename prefix beats filename substring
 * beats full-path substring; matching directories get a bonus so they surface
 * first as drill-down targets.
 */
function scoreEntry(entry: MentionEntry, lowerQuery: string): number {
  let score = 0;
  if (entry.lowerName === lowerQuery) score = 100;
  else if (entry.lowerName.startsWith(lowerQuery)) score = 80;
  else if (entry.lowerName.includes(lowerQuery)) score = 50;
  else if (entry.lowerPath.includes(lowerQuery)) score = 30;
  if (entry.isDir && score > 0) score += 10;
  return score;
}

function depth(path: string): number {
  let n = 0;
  for (let i = 0; i < path.length; i++) if (path[i] === "/") n++;
  return n;
}

function toEntry(path: string, isDir: boolean): MentionEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, lowerPath: path.toLowerCase(), lowerName: name.toLowerCase(), isDir };
}

/** Files straight from fd, plus every ancestor directory derived from them. */
function buildEntries(paths: string[]): MentionEntry[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    let i = p.indexOf("/");
    while (i !== -1) {
      dirs.add(p.slice(0, i));
      i = p.indexOf("/", i + 1);
    }
  }
  const entries: MentionEntry[] = [];
  for (const d of dirs) entries.push(toEntry(d, true));
  for (const p of paths) entries.push(toEntry(p, false));
  return entries;
}

function filterEntries(entries: MentionEntry[], rawQuery: string): MentionEntry[] {
  if (!rawQuery) {
    // No query yet: a browsable top — shallow paths first, alphabetical.
    return [...entries]
      .sort(
        (a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path),
      )
      .slice(0, MAX_ITEMS);
  }
  const lowerQuery = rawQuery.toLowerCase();
  const scored: { entry: MentionEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, lowerQuery);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return scored.slice(0, MAX_ITEMS).map((s) => s.entry);
}

/** The text spliced in for a picked entry (quote when spaces are involved). */
function completionText(entry: MentionEntry, quotedPrefix: boolean): string {
  const path = entry.isDir ? `${entry.path}/` : entry.path;
  return quotedPrefix || path.includes(" ") ? `@"${path}"` : `@${path}`;
}

export interface FileMention {
  /** Non-null while the popup is showing. */
  state: MentionState | null;
  /** Recompute from the textarea's live value/cursor (onChange + onSelect). */
  refresh: () => void;
  /** Returns true when the key was consumed by the popup. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  apply: (entry: MentionEntry) => void;
  setActive: (index: number) => void;
  close: () => void;
}

export function useFileMention(options: {
  /** Workspace root, or null when mentions are unavailable (plain chats). */
  root: string | null;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Applies a completed text (setText + autosize) — caret is handled here. */
  onApplyText: (next: string) => void;
}): FileMention {
  const { root, taRef, onApplyText } = options;
  const [state, setState] = useState<MentionState | null>(null);
  // Workspace enumeration cache; one workspace at a time is plenty.
  const cacheRef = useRef<{ root: string; entries: MentionEntry[]; at: number } | null>(null);
  const loadingRef = useRef<string | null>(null);
  // Esc remembers the exact token it dismissed; any further typing re-arms.
  const dismissedRef = useRef<string | null>(null);
  // Caret to restore after a completion re-renders the controlled textarea,
  // and whether to re-run refresh() then (directory picks keep drilling).
  const pendingCaretRef = useRef<{ caret: number; reopen: boolean } | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback((): void => {
    const el = taRef.current;
    if (!root || !el) {
      setState(null);
      return;
    }
    const cursor = el.selectionStart ?? el.value.length;
    const found = extractAtToken(el.value, cursor);
    if (!found) {
      dismissedRef.current = null;
      setState(null);
      return;
    }
    if (dismissedRef.current === found.token) {
      setState(null);
      return;
    }
    dismissedRef.current = null;

    // Fetch (or revalidate) the enumeration; filter whatever is cached now and
    // the fetch completion re-runs refresh to fill in.
    const cache = cacheRef.current;
    const stale = !cache || cache.root !== root || Date.now() - cache.at > CACHE_TTL_MS;
    if (stale && loadingRef.current !== root) {
      loadingRef.current = root;
      window.api
        .listWorkspaceFiles({ root })
        .then((res) => {
          cacheRef.current = { root, entries: buildEntries(res.paths), at: Date.now() };
        })
        .catch(() => {
          // Unknown root or fd failure — nothing to suggest, don't re-hammer.
          cacheRef.current = { root, entries: [], at: Date.now() };
        })
        .finally(() => {
          loadingRef.current = null;
          refreshRef.current();
        });
    }
    const entries = cacheRef.current?.root === root ? cacheRef.current.entries : [];
    const quoted = found.token.startsWith('@"');
    const items = filterEntries(entries, found.token.slice(quoted ? 2 : 1));
    if (items.length === 0) {
      setState(null);
      return;
    }
    setState({ start: found.start, token: found.token, items, active: 0 });
  }, [root, taRef]);
  refreshRef.current = refresh;

  // Session/workspace switch: any open popup belongs to the old textarea text.
  useEffect(() => {
    setState(null);
    dismissedRef.current = null;
  }, [root]);

  useLayoutEffect(() => {
    const pending = pendingCaretRef.current;
    if (!pending) return;
    pendingCaretRef.current = null;
    const el = taRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pending.caret, pending.caret);
    }
    if (pending.reopen) refresh();
  });

  const apply = useCallback(
    (entry: MentionEntry): void => {
      const el = taRef.current;
      if (!el || !state) return;
      const cursor = el.selectionStart ?? el.value.length;
      const value = completionText(entry, state.token.startsWith('@"'));
      // Files get a trailing space (mention finished); directories don't, so
      // typing continues the path. Quoted directories put the caret before the
      // closing quote for the same reason.
      const suffix = entry.isDir ? "" : " ";
      const caretInValue = entry.isDir && value.endsWith('"') ? value.length - 1 : value.length;
      const next = el.value.slice(0, state.start) + value + suffix + el.value.slice(cursor);
      pendingCaretRef.current = {
        caret: state.start + caretInValue + suffix.length,
        reopen: entry.isDir,
      };
      setState(null);
      onApplyText(next);
    },
    [state, taRef, onApplyText],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!state) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : state.items.length - 1;
        setState((s) => s && { ...s, active: (s.active + delta) % s.items.length });
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        apply(state.items[state.active]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissedRef.current = state.token;
        setState(null);
        return true;
      }
      return false;
    },
    [state, apply],
  );

  const setActive = useCallback((index: number): void => {
    setState((s) => (s && s.active !== index ? { ...s, active: index } : s));
  }, []);

  const close = useCallback((): void => setState(null), []);

  return { state, refresh, onKeyDown, apply, setActive, close };
}

/**
 * The suggestion panel, anchored above the composer shell. Plain list, not a
 * base-ui popup: focus must stay in the textarea the whole time.
 */
export function FileMentionPopup({
  mention,
}: {
  mention: FileMention;
}): React.JSX.Element | null {
  const activeRef = useRef<HTMLButtonElement>(null);
  const active = mention.state?.active;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!mention.state) return null;
  const { items } = mention.state;

  return (
    <div className="absolute inset-x-0 bottom-full z-50 mb-2 rounded-2xl [corner-shape:squircle] bg-popover text-popover-foreground ring-1 ring-foreground/10 animate-in fade-in-0 slide-in-from-bottom-1 duration-100">
      {/* The fade mask must live on a child: on the shell it would eat the
          panel's own background and ring at the edges. */}
      <div role="listbox" className="max-h-72 overflow-y-auto overscroll-contain scroll-fade-y p-1">
        {items.map((entry, i) => {
          const slash = entry.path.lastIndexOf("/");
          const dir = slash === -1 ? "" : entry.path.slice(0, slash);
          return (
            <button
              key={(entry.isDir ? "d:" : "f:") + entry.path}
              ref={i === active ? activeRef : undefined}
              type="button"
              role="option"
              aria-selected={i === active}
              // Keep focus in the textarea: select on mousedown, never focus.
              onMouseDown={(e) => {
                e.preventDefault();
                mention.apply(entry);
              }}
              onMouseMove={() => mention.setActive(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-xl [corner-shape:squircle] px-2.5 py-1.5 text-left text-sm",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              {entry.isDir ? (
                <IconFolder className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <IconFile className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="shrink-0">
                {entry.name}
                {entry.isDir ? "/" : ""}
              </span>
              {dir && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
