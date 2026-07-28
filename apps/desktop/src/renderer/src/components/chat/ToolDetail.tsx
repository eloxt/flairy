import { Fragment, lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconFileText,
  IconFolder,
  IconLink,
  IconListSearch,
  IconPencil,
  IconSearch,
  IconWorld,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { UiMessage } from "@/store/chat-store";
import type { SearchSource } from "@shared/web-search";
import { TodoList } from "./TodoList";
import { Favicon, relativeDate } from "./Citations";

// Same on-demand load as the old MessageList usage: @pierre/diffs is heavy and
// only needed once an edit/write row is expanded.
const DiffView = lazy(() =>
  import("./DiffView").then((m) => ({ default: m.DiffView })),
);

/**
 * The expanded detail of one tool call, rendered per tool type — a terminal
 * face for bash, a file card for read/edit/write, a source list for web search,
 * the plan checklist for todo_write… — instead of raw "arguments / result"
 * JSON dumps. Every renderer shares one visual grammar: a single hairline
 * {@link Card}, an optional {@link CardHead} carrying the call's key argument
 * plus a stat, and a body that clamps long content behind a fade + "show all"
 * pill ({@link Clamp}) rather than an inner scrollbar.
 *
 * Dispatch is data-first (a diff patch or parsed todos win over the tool name)
 * so MCP tools that happen to produce the same shapes get the same treatment.
 */
export function ToolDetail({ m }: { m: UiMessage }): React.JSX.Element | null {
  const args = parseArgs(m.toolArgs);
  // While the call runs, `m.text` is a localized "running…" placeholder, not
  // tool output — never render it as a result.
  const text = m.running ? "" : m.text;
  if (m.diffPatch) return <DiffDetail m={m} args={args} />;
  if (m.todos) return <TodoDetail todos={m.todos} />;
  switch (m.toolName) {
    case "bash":
      return <BashDetail m={m} args={args} text={text} />;
    case "read":
      return <ReadDetail m={m} args={args} text={text} />;
    case "grep":
      return <GrepDetail m={m} args={args} text={text} />;
    case "find":
    case "ls":
      return <ListDetail m={m} args={args} text={text} />;
    case "web_search":
      if (m.sources?.length) return <SearchDetail m={m} args={args} sources={m.sources} />;
      break;
    case "web_fetch":
      return <FetchDetail m={m} args={args} text={text} />;
    case "ask": {
      const qa = parseAskResult(text);
      if (qa) return <AskDetail pairs={qa} />;
      break;
    }
  }
  return <GenericDetail m={m} args={args} text={text} />;
}

/** Best-effort re-parse of the pretty-printed args JSON kept on the message. */
function parseArgs(toolArgs: string | undefined): Record<string, unknown> | undefined {
  if (!toolArgs) return undefined;
  try {
    const v = JSON.parse(toolArgs) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    // Truncated payloads (see formatToolArgs) or non-JSON string args.
    return undefined;
  }
}

function argStr(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = args?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Tool outputs append machine-facing notices as a trailing `[…]` block
 * ("Showing lines 1-200 of 812…", "50 matches limit reached…"). Strip it from
 * the human-facing body; the useful part (line ranges) is re-surfaced as a
 * header stat by the caller.
 */
function splitNotice(text: string): { body: string; notice?: string } {
  const match = /\n\n\[([^\]]+)\]\s*$/.exec(text);
  if (!match) return { body: text };
  return { body: text.slice(0, match.index), notice: match[1] };
}

/* ── shared surface ─────────────────────────────────────────────────────── */

function Card({
  error,
  children,
}: {
  error?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] border bg-card",
        error ? "border-destructive/30" : "border-border",
      )}
    >
      {children}
    </div>
  );
}

/** Icon + the call's key argument + a right-aligned stat, atop the card. */
function CardHead({
  icon,
  primary,
  mono = true,
  meta,
}: {
  icon: React.ReactNode;
  primary: string;
  mono?: boolean;
  meta?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <span className="shrink-0 text-muted-foreground/60 [&>svg]:size-3.5">{icon}</span>
      <span
        className={cn(
          "min-w-0 truncate text-xs font-medium text-foreground",
          mono && "font-mono",
        )}
        title={primary}
      >
        {primary}
      </span>
      {meta && (
        <span className="ml-auto shrink-0 pl-3 text-[11px] tabular-nums text-muted-foreground/70">
          {meta}
        </span>
      )}
    </div>
  );
}

/**
 * Clamps tall content behind a bottom fade and a centered "show all" pill that
 * expands it in place — no nested scrollbar inside the chat's scroll. The fade
 * and pill only appear when the content actually overflows. base-ui's
 * Collapsible panel resets its height var to `auto` once the open transition
 * settles, so growing in place is safe.
 */
function Clamp({
  collapsedClass = "max-h-56",
  className,
  children,
}: {
  collapsedClass?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1);
  });
  return (
    <div className="relative">
      <div
        ref={ref}
        className={cn(!expanded && cn(collapsedClass, "overflow-hidden"), className)}
      >
        {children}
      </div>
      {!expanded && clipped && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card to-transparent" />
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("toolDetail.showAll")}
          </button>
        </>
      )}
    </div>
  );
}

/** Monospace body text shared by outputs, file previews and listings. */
function MonoBody({
  text,
  error,
  className,
}: {
  text: string;
  error?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-relaxed",
        error ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {text}
    </pre>
  );
}

/* ── bash · terminal face ───────────────────────────────────────────────── */

function BashDetail({
  m,
  args,
  text,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
  text: string;
}): React.JSX.Element {
  const command = argStr(args, "command") ?? m.toolArg ?? "";
  const { body } = splitNotice(text);
  return (
    <Card error={m.isError}>
      {command && (
        <div className="flex min-w-0 gap-2 px-3 py-2 font-mono text-xs leading-relaxed">
          <span className="select-none text-muted-foreground/60">$</span>
          <span className="min-w-0 whitespace-pre-wrap break-all text-foreground">
            {command}
          </span>
        </div>
      )}
      {body.trim() && (
        <div className={cn(command && "border-t border-border")}>
          <Clamp>
            <MonoBody text={body} error={m.isError} />
          </Clamp>
        </div>
      )}
    </Card>
  );
}

/* ── read · file head + content preview ─────────────────────────────────── */

function ReadDetail({
  m,
  args,
  text,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
  text: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const path = argStr(args, "path") ?? m.toolArg ?? "";
  const { body, notice } = splitNotice(text);
  const range = notice
    ? /Showing lines (\d+)-(\d+) of (\d+)/.exec(notice)
    : null;
  const meta = range
    ? t("toolDetail.lineRange", { start: range[1], end: range[2], total: range[3] })
    : body.trim()
      ? t("toolDetail.lineCount", { count: body.split("\n").length })
      : undefined;
  return (
    <Card error={m.isError}>
      <CardHead icon={<IconFileText strokeWidth={2} />} primary={path} meta={meta} />
      {body.trim() && (
        <Clamp>
          <MonoBody text={body} error={m.isError} />
        </Clamp>
      )}
    </Card>
  );
}

/* ── edit / write · file head + diff ────────────────────────────────────── */

function DiffDetail({
  m,
  args,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
}): React.JSX.Element {
  const path = argStr(args, "path") ?? m.toolArg ?? "";
  let add = 0;
  let del = 0;
  for (const line of (m.diffPatch ?? "").split("\n")) {
    if (/^\+(?!\+\+)/.test(line)) add++;
    else if (/^-(?!--)/.test(line)) del++;
  }
  return (
    <Card error={m.isError}>
      <CardHead
        icon={<IconPencil strokeWidth={2} />}
        primary={path}
        meta={`+${add} −${del}`}
      />
      <Clamp collapsedClass="max-h-96">
        <Suspense fallback={null}>
          <DiffView
            patch={m.diffPatch ?? ""}
            className="mt-0 max-h-none overflow-visible rounded-none border-0"
          />
        </Suspense>
      </Clamp>
    </Card>
  );
}

/* ── grep · pattern head + grouped matches ──────────────────────────────── */

function GrepDetail({
  m,
  args,
  text,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
  text: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const pattern = argStr(args, "pattern") ?? m.toolArg ?? "";
  const { body } = splitNotice(text);
  // Default (no-context) output is `path:line: text` — group it per file. Any
  // other shape (context blocks, "No matches found") renders as-is.
  const byFile = new Map<string, number[]>();
  const lines = body.split("\n").filter((l) => l.trim());
  let parsed = lines.length > 0;
  for (const line of lines) {
    const match = /^(.+?):(\d+): /.exec(line);
    if (!match) {
      parsed = false;
      break;
    }
    const nums = byFile.get(match[1]) ?? [];
    if (nums.length === 0) byFile.set(match[1], nums);
    nums.push(Number(match[2]));
  }
  const meta = parsed
    ? [
        t("toolDetail.matchCount", { count: lines.length }),
        t("toolDetail.fileCount", { count: byFile.size }),
      ].join(" · ")
    : undefined;
  return (
    <Card error={m.isError}>
      <CardHead icon={<IconSearch strokeWidth={2} />} primary={pattern} meta={meta} />
      {body.trim() &&
        (parsed ? (
          <Clamp>
            <div className="px-3 py-2 font-mono text-xs leading-loose">
              {[...byFile].map(([file, nums]) => (
                <div key={file} className="flex min-w-0 gap-2.5">
                  <span className="truncate text-foreground" title={file}>
                    {file}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground/60">
                    {nums.map((n) => `:${n}`).join(" ")}
                  </span>
                </div>
              ))}
            </div>
          </Clamp>
        ) : (
          <Clamp>
            <MonoBody text={body} error={m.isError} />
          </Clamp>
        ))}
    </Card>
  );
}

/* ── find / ls · listing ────────────────────────────────────────────────── */

function ListDetail({
  m,
  args,
  text,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
  text: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const isFind = m.toolName === "find";
  const primary =
    (isFind ? argStr(args, "pattern") : argStr(args, "path")) ?? m.toolArg ?? "";
  const { body } = splitNotice(text);
  const entries = body.split("\n").filter((l) => l.trim());
  // Placeholder results ("(empty directory)", "No files found…") aren't entries.
  const listy = entries.length > 0 && !/^[([]/.test(entries[0]);
  const meta = listy
    ? t(isFind ? "toolDetail.fileCount" : "toolDetail.entryCount", {
        count: entries.length,
      })
    : undefined;
  return (
    <Card error={m.isError}>
      <CardHead
        icon={isFind ? <IconListSearch strokeWidth={2} /> : <IconFolder strokeWidth={2} />}
        primary={primary}
        meta={meta}
      />
      {body.trim() && (
        <Clamp>
          <MonoBody text={body} error={m.isError} />
        </Clamp>
      )}
    </Card>
  );
}

/* ── web_search · clickable source rows ─────────────────────────────────── */

function SearchDetail({
  m,
  args,
  sources,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
  sources: SearchSource[];
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const query = argStr(args, "query") ?? m.toolArg ?? "";
  const ordered = [...sources].sort((a, b) => a.i - b.i);
  return (
    <Card error={m.isError}>
      <CardHead
        icon={<IconWorld strokeWidth={2} />}
        primary={query}
        mono={false}
        meta={t("toolDetail.resultCount", { count: sources.length })}
      />
      <Clamp collapsedClass="max-h-72">
        <div className="p-1.5">
          {ordered.map((s) => {
            const when = relativeDate(s.date, i18n.language);
            return (
              <button
                key={s.i}
                type="button"
                onClick={() => void window.api.openExternal(s.url)}
                className="flex w-full min-w-0 items-center gap-2.5 rounded-[7px] px-2 py-1 text-left transition-colors hover:bg-accent"
              >
                <span className="w-4 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60">
                  {s.i}
                </span>
                <Favicon source={s} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate text-[13px] text-foreground">
                  {s.title}
                </span>
                <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground/60">
                  {s.domain}
                  {when && ` · ${when}`}
                </span>
              </button>
            );
          })}
        </div>
      </Clamp>
    </Card>
  );
}

/* ── web_fetch · url head + prose excerpt ───────────────────────────────── */

function FetchDetail({
  m,
  args,
  text,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
  text: string;
}): React.JSX.Element {
  const url = argStr(args, "url") ?? m.toolArg ?? "";
  // Fetch display text is `# title\nurl\n\body` (see web-fetch.ts) — the head
  // already shows the url, so lift the title and drop the duplicate line.
  let title: string | undefined;
  let body = text;
  if (body.startsWith("# ")) {
    const lines = body.split("\n");
    title = lines[0].slice(2).trim();
    body = lines.slice(lines[1]?.trim() === url ? 2 : 1).join("\n").trim();
  }
  return (
    <Card error={m.isError}>
      <CardHead icon={<IconLink strokeWidth={2} />} primary={url} />
      {(title || body) && (
        <Clamp>
          <div className="px-3.5 py-2.5 text-[13px] leading-relaxed">
            {title && <div className="mb-1 font-medium text-foreground">{title}</div>}
            {body && (
              <div className="whitespace-pre-wrap text-muted-foreground">{body}</div>
            )}
          </div>
        </Clamp>
      )}
    </Card>
  );
}

/* ── todo_write · the plan checklist ────────────────────────────────────── */

function TodoDetail({ todos }: { todos: NonNullable<UiMessage["todos"]> }): React.JSX.Element {
  return (
    <Card>
      <div className="px-3.5 py-2.5">
        <TodoList todos={todos} className="[&_li]:text-[13px]" />
      </div>
    </Card>
  );
}

/* ── ask · question → the user's answer ─────────────────────────────────── */

/** Parse the ask tool's `Q: …\nA: …` result blocks; null if the shape differs. */
function parseAskResult(text: string): { q: string; a: string }[] | null {
  const blocks = text.split("\n\n").filter((b) => b.trim());
  if (blocks.length === 0) return null;
  const pairs: { q: string; a: string }[] = [];
  for (const block of blocks) {
    const match = /^Q: ([\s\S]+?)\nA: ([\s\S]+)$/.exec(block.trim());
    if (!match) return null;
    pairs.push({ q: match[1].trim(), a: match[2].trim() });
  }
  return pairs;
}

function AskDetail({ pairs }: { pairs: { q: string; a: string }[] }): React.JSX.Element {
  return (
    <Card>
      <div className="flex flex-col gap-3 px-3.5 py-2.5 text-[13px] leading-relaxed">
        {pairs.map((p, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="text-muted-foreground">{p.q}</div>
            <div className="flex gap-2.5">
              <span className="w-0.5 shrink-0 rounded-full bg-foreground/25" />
              <span className="min-w-0 text-foreground">{p.a}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── fallback · MCP / unknown tools ─────────────────────────────────────── */

function GenericDetail({
  m,
  args,
  text,
}: {
  m: UiMessage;
  args?: Record<string, unknown>;
  text: string;
}): React.JSX.Element | null {
  const entries = args ? Object.entries(args) : [];
  const hasArgs = entries.length > 0 || Boolean(m.toolArgs?.trim());
  const hasText = Boolean(text.trim());
  if (!hasArgs && !hasText) return null;
  return (
    <Card error={m.isError}>
      {entries.length > 0 ? (
        // Args flattened to a quiet key · value grid — never a raw JSON dump.
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-0.5 px-3 py-2 font-mono text-xs leading-relaxed">
          {entries.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground/60">{k}</dt>
              <dd className="m-0 min-w-0 break-all text-foreground">
                {typeof v === "string" ? v : JSON.stringify(v)}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        hasArgs && (
          <Clamp>
            <MonoBody text={m.toolArgs ?? ""} />
          </Clamp>
        )
      )}
      {hasText && (
        <div className={cn(hasArgs && "border-t border-border")}>
          <Clamp>
            <MonoBody text={text} error={m.isError} />
          </Clamp>
        </div>
      )}
    </Card>
  );
}
