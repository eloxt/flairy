import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Streamdown } from "streamdown";
import { Terminal, CircleAlert, ChevronRight, Sparkle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toolBucket, toolDisplayKey } from "@/lib/tool-display";
import { useChat } from "@/store/chat-store";
import type { UiMessage } from "@/store/chat-store";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Onboarding } from "./Onboarding";
import "streamdown/styles.css";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import "katex/dist/katex.min.css";
import { cjk } from "@streamdown/cjk";

/**
 * A render unit for the thread. We fold the store's flat message list into rows
 * at render time (the store stays one-message-per-tool-call, so hydration and
 * sync are untouched): the tool calls of one assistant turn — a parallel batch,
 * tagged with a shared `batchId` — collapse into one `group`; a lone call stays
 * a `tool` line; everything else is a `msg`.
 */
type Row =
  | { kind: "msg"; key: string; m: UiMessage }
  | { kind: "tool"; key: string; m: UiMessage }
  | { kind: "group"; key: string; tools: UiMessage[] };

/** Group adjacent tool calls that share a batch; pass other messages through. */
function toRows(messages: UiMessage[]): Row[] {
  const rows: Row[] = [];
  let run: UiMessage[] = [];
  const flush = (): void => {
    if (run.length === 1)
      rows.push({ kind: "tool", key: run[0].id, m: run[0] });
    else if (run.length > 1)
      rows.push({ kind: "group", key: `group-${run[0].id}`, tools: run });
    run = [];
  };
  const batchOf = (m: UiMessage): string => m.batchId ?? m.id;
  for (const m of messages) {
    if (m.role === "tool") {
      // A new batch (a different assistant turn) starts its own group, even when
      // it sits right after the previous turn's calls with no text between.
      if (run.length && batchOf(m) !== batchOf(run[0])) flush();
      run.push(m);
      continue;
    }
    // A tools-only turn leaves an empty assistant bubble in the live store (the
    // stream opens the message before its tool calls); replay drops it. Skip it
    // so the two paths render identically and it adds no blank row — unless it
    // carries reasoning, which is worth showing on its own.
    if (m.role === "assistant" && !m.text.trim() && !m.thinking?.trim())
      continue;
    flush();
    rows.push({ kind: "msg", key: m.id, m });
  }
  flush();
  return rows;
}

export function MessageList({
  messages,
}: {
  messages: UiMessage[];
}): React.JSX.Element {
  const approvalCount = useChat((s) => s.approvalQueue.length);
  const questionCount = useChat((s) => s.questionQueue.length);
  const pendingScrollIndex = useChat((s) => s.pendingScrollIndex);
  const clearPendingScroll = useChat((s) => s.clearPendingScroll);
  const running = useChat((s) => s.running);
  const rows = useMemo(() => toRows(messages), [messages]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // The row key to flash after a search jump; cleared after the highlight fades.
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

  // Consume a queued search-jump target. Runs in an effect (not during render) so
  // the Virtuoso ref is attached and rows are laid out; rAF lets layout settle
  // before scrolling. Falls back to the nearest preceding message row, else the top.
  useEffect(() => {
    if (
      pendingScrollIndex == null ||
      pendingScrollIndex < 0 ||
      rows.length === 0
    )
      return;
    let index = rows.findIndex(
      (r) => r.kind === "msg" && r.m.sourceIndex === pendingScrollIndex,
    );
    if (index < 0) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (
          r.kind === "msg" &&
          r.m.sourceIndex != null &&
          r.m.sourceIndex < pendingScrollIndex
        ) {
          index = i;
          break;
        }
      }
    }
    if (index < 0) index = 0;
    const key = rows[index].key;
    // Clear INSIDE the rAF (not synchronously): clearing now would flip
    // pendingScrollIndex, re-run this effect, and its cleanup would cancel the
    // pending frame before the scroll ever fires.
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index, align: "center" });
      setHighlightKey(key);
      clearPendingScroll();
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingScrollIndex, rows, clearPendingScroll]);

  // Fade the highlight out after a short beat.
  useEffect(() => {
    if (!highlightKey) return;
    const id = setTimeout(() => setHighlightKey(null), 1600);
    return () => clearTimeout(id);
  }, [highlightKey]);

  // Pending approvals and questions render inline in the footer, so keep the
  // list mounted whenever there's a message, an approval, OR a question to show.
  if (messages.length === 0 && approvalCount === 0 && questionCount === 0)
    return <EmptyState />;

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="absolute inset-0 scrollbar-gutter-both"
      data={rows}
      // Only follow output while the agent is streaming. Otherwise `followOutput`
      // would pin a freshly opened session to the bottom on entry (at the first
      // frame the list is trivially "at bottom", so it keeps scrolling there as
      // rows fill in) — we want it to stay where it loads instead.
      followOutput={running ? "smooth" : false}
      computeItemKey={(_i, row) => row.key}
      components={{ Header: Spacer, Footer: ApprovalFooter }}
      itemContent={(_i, row) => (
        <RowView row={row} highlight={row.key === highlightKey} />
      )}
    />
  );
}

function RowView({
  row,
  highlight,
}: {
  row: Row;
  highlight?: boolean;
}): React.JSX.Element {
  const inner =
    row.kind === "group" ? (
      <ToolGroup tools={row.tools} />
    ) : row.kind === "tool" ? (
      <SingleTool m={row.m} />
    ) : (
      <MessageRow m={row.m} />
    );
  // Transient ring after a search jump; fades as `highlight` flips back to false.
  return (
    <div
      className={cn(
        "transition-colors duration-700",
        highlight && "bg-accent/40",
      )}
    >
      {inner}
    </div>
  );
}

const Spacer = (): React.JSX.Element => <div className="h-6" />;

/**
 * Renders any pending approval requests as inline, non-blocking cards, then
 * leaves room at the bottom so the last item clears the floating composer.
 * Height tracks the composer's live size via the `--composer-h` CSS variable it
 * publishes (falls back to 9rem before the composer has measured itself).
 */
const ApprovalFooter = (): React.JSX.Element => {
  const approvalQueue = useChat((s) => s.approvalQueue);
  const questionQueue = useChat((s) => s.questionQueue);
  return (
    <>
      <ThinkingRow />
      {approvalQueue.map((req) => (
        <ApprovalCard key={req.approvalId} payload={req} />
      ))}
      {questionQueue.map((req) => (
        <QuestionCard key={req.questionId} payload={req} />
      ))}
      <div style={{ height: "var(--composer-h, 9rem)" }} />
    </>
  );
};

/**
 * The pause between sending and the first token. Three dots breathing in place —
 * the only signal the agent is awake. Shown only in that gap: once text streams
 * the caret takes over, and once a tool runs its own row pulses instead.
 */
function ThinkingRow(): React.JSX.Element | null {
  const show = useChat((s) => {
    if (!s.running) return false;
    const last = s.messages[s.messages.length - 1];
    return last?.role === "user";
  });
  if (!show) return null;
  return (
    <div className="animate-message-in mx-auto w-full max-w-3xl px-6 py-2.5">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-muted-foreground"
            style={{
              animation: "var(--animate-thinking)",
              animationDelay: `${i * 160}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * First-run: a single quiet line — just an invitation — followed on a fresh
 * install by the {@link Onboarding} guide pointing at the composer's working-
 * directory and permission controls.
 */
function EmptyState(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto px-6 py-12">
      <div className="mx-auto max-w-md text-center">
        <h1 className="animate-rise-in text-2xl font-medium tracking-tight text-foreground">
          {t("chat.emptyTitle")}
        </h1>
        <p
          className="animate-rise-in mt-2 text-sm text-muted-foreground"
          style={{ animationDelay: "90ms" }}
        >
          {t("chat.emptySubtitle")}
        </p>
        <Onboarding />
      </div>
    </div>
  );
}

function MessageRow({ m }: { m: UiMessage }): React.JSX.Element {
  if (m.role === "user") return <UserRow m={m} />;
  return <AssistantRow m={m} />;
}

/** User turn: a quiet, right-aligned chip. Restraint over a loud bubble. */
function UserRow({ m }: { m: UiMessage }): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-2.5">
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5 text-sm leading-relaxed text-secondary-foreground">
          {m.text}
        </div>
      </div>
    </div>
  );
}

/** Agent turn: full-width prose, no frame. The words carry it. */
function AssistantRow({ m }: { m: UiMessage }): React.JSX.Element {
  const hasText = Boolean(m.text.trim());
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-2.5">
      {m.thinking?.trim() && (
        <ReasoningBlock
          text={m.thinking}
          streaming={m.streaming && !hasText}
          answered={hasText}
        />
      )}
      {hasText && (
        <Streamdown
          parseIncompleteMarkdown
          isAnimating={Boolean(m.streaming)}
          animated
          caret="block"
          plugins={{ code, mermaid, math, cjk }}
          className="space-y-3 text-sm leading-relaxed [&_:where(h1,h2,h3,h4)]:tracking-tight [&_code]:font-mono"
        >
          {m.text}
        </Streamdown>
      )}
    </div>
  );
}

/**
 * The model's reasoning for a turn: a quiet, collapsible disclosure above the
 * answer. Auto-expands while reasoning is still streaming and no answer has
 * arrived yet (so it's visible live); collapses once the answer lands or on
 * replay. Mirrors the tool-row disclosure pattern.
 */
function ReasoningBlock({
  text,
  streaming,
  answered,
}: {
  text: string;
  streaming?: boolean;
  answered?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(Boolean(streaming) && !answered);
  // Auto-collapse once non-reasoning content (the answer) arrives — the false →
  // true transition of `answered` — while still letting the user toggle it back.
  const wasAnswered = useRef(Boolean(answered));
  useEffect(() => {
    if (!wasAnswered.current && answered) setOpen(false);
    wasAnswered.current = Boolean(answered);
  }, [answered]);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <Sparkle
          className={cn("size-3.5 shrink-0", streaming && "animate-pulse")}
        />
        <span>{streaming ? t("chat.reasoningLive") : t("chat.reasoning")}</span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * One tool call: a low-intrusion single line — tool name + a status icon,
 * collapsed by default; click to reveal the raw output. The presentational unit
 * shared by a standalone call (`SingleTool`) and the members of a `ToolGroup`,
 * so a lone call and a grouped one read identically.
 */
function ToolEntry({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
          strokeWidth={2}
        />
        {m.isError ? (
          <CircleAlert
            className="size-3.5 shrink-0 text-destructive"
            strokeWidth={2}
          />
        ) : (
          <Terminal
            className="size-3.5 shrink-0 text-muted-foreground"
            strokeWidth={2}
          />
        )}
        <span
          className={cn(
            "shrink-0 text-xs font-medium",
            m.isError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {t(toolDisplayKey(m.toolName))}
        </span>
        {m.toolArg && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/60"
            title={m.toolArg}
          >
            {m.toolArg}
          </span>
        )}
      </button>
      {open && (
        <pre
          className={cn(
            "mt-1 max-h-56 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed",
            m.isError
              ? "border-destructive/30 text-destructive"
              : "border-border text-muted-foreground",
          )}
        >
          {m.text}
        </pre>
      )}
    </div>
  );
}

/** A lone tool call, in the standard message rhythm. */
function SingleTool({ m }: { m: UiMessage }): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-0.5">
      <ToolEntry m={m} />
    </div>
  );
}

/**
 * Fold a run of tool calls into one plain-language clause — "Read 3 files, ran
 * 2 commands" — built from per-tool *activity* buckets (see `toolBucket`). First
 * appearance sets order; i18next handles the plural. The first letter is
 * capitalized for the collapsed header.
 */
function summarizeTools(tools: UiMessage[], t: TFunction): string {
  const counts = new Map<string, number>();
  for (const m of tools) {
    const b = toolBucket(m.toolName);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const clause = [...counts]
    .map(([bucket, count]) => t(`activity.${bucket}`, { count }))
    .join(t("activity.separator"));
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/**
 * A contiguous run of tool calls (parallel batches and back-to-back rounds),
 * collapsed into one quiet line so the agent's work doesn't bury the
 * conversation. Collapsed it shows a plain-language summary; expanded it reveals
 * each call along a hairline rail. The right-hand status dot mirrors a single
 * tool's, so the two states share one visual language.
 */
function ToolGroup({ tools }: { tools: UiMessage[] }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anyRunning = tools.some((m) => m.running);
  const anyError = tools.some((m) => m.isError);
  const doneCount = tools.filter((m) => !m.running).length;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
          strokeWidth={2}
        />
        {anyError ? (
          <CircleAlert
            className="size-3.5 shrink-0 text-destructive"
            strokeWidth={2}
          />
        ) : (
          <Terminal
            className="size-3.5 shrink-0 text-muted-foreground"
            strokeWidth={2}
          />
        )}
        <span
          className={cn(
            "text-xs font-medium",
            anyError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {anyRunning ? t("chat.working") : summarizeTools(tools, t)}
        </span>
        {anyRunning && doneCount > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground/60">
            · {doneCount}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-0.5 ml-[0.6rem] border-l border-border pl-2.5">
          {tools.map((m) => (
            <ToolEntry key={m.id} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}
