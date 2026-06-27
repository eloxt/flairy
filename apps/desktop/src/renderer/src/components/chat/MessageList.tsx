import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Streamdown } from "streamdown";
import {
  CircleAlert,
  ChevronRight,
  Sparkle,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { toolBucket, toolDisplayKey } from "@/lib/tool-display";
import { useChat } from "@/store/chat-store";
import type { UiMessage } from "@/store/chat-store";
import type { SearchSource } from "@shared/web-search";
import {
  CitationChip,
  CitationsProvider,
  remarkCitations,
  SourcesList,
} from "./Citations";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Onboarding } from "./Onboarding";
import { Announcements } from "./Announcements";
import "streamdown/styles.css";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import "katex/dist/katex.min.css";
import { cjk } from "@streamdown/cjk";

// Stable references for <Streamdown>. Passing fresh object/array literals on each
// render defeats Streamdown's internal memoization — its Block memo compares
// remarkPlugins/rehypePlugins by reference, and plugins/components feed useMemos —
// so every markdown block would re-render and re-run its parser effect on every
// streamed token. During streaming that churn compounds into a "maximum update
// depth exceeded" (React #185) crash. Hoisting these keeps the identities stable.
// These MUST stay module-level constants — do NOT compute remarkPlugins per render
// (even via useMemo): an unstable reference resets Streamdown's stateful animation
// plugin every commit and re-triggers the parser's setState, reproducing #185.
const STREAMDOWN_PLUGINS = { code, mermaid, math, cjk };
const STREAMDOWN_REMARK_PLUGINS = [remarkCitations];
const STREAMDOWN_COMPONENTS = { sup: CitationChip };

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
  const running = useChat((s) => s.running);
  const sessionId = useChat((s) => s.sessionId);
  const rows = useMemo(() => toRows(messages), [messages]);
  // Per-assistant-message citation registry: ALL web_search sources gathered so
  // far in the current turn (reset at each user message), so an answer can cite
  // any search in the turn — not just the nearest one. Ids are turn-unique (the
  // tool blocks them per turn), so the merge can't collide; we still dedupe by id
  // (first wins) to be safe across old sessions and to drop accidental repeats.
  // Each assistant gets a SNAPSHOT (slice) so a later search doesn't retroactively
  // add sources to an earlier bubble in the same turn.
  //
  // `footerIds` marks the ONE bubble per turn that renders the Sources footer: the
  // turn's last sources-bearing assistant. An intermediate answer (more tool calls
  // follow it) must not show the list mid-turn — it belongs at the end. The active
  // turn (still running) is left out entirely until it ends, so the footer only
  // appears once the turn is done; completed earlier turns always get theirs.
  const { sourcesByMessage, footerIds } = useMemo(() => {
    const map = new Map<string, SearchSource[]>();
    const footers = new Set<string>();
    let acc: SearchSource[] = [];
    let seen = new Set<number>();
    let lastSourcedId: string | null = null;
    const finalizeTurn = (): void => {
      if (lastSourcedId) footers.add(lastSourcedId);
      lastSourcedId = null;
    };
    for (const m of messages) {
      if (m.role === "user") {
        finalizeTurn();
        acc = [];
        seen = new Set<number>();
      } else if (m.role === "tool" && m.sources?.length) {
        for (const s of m.sources) {
          if (seen.has(s.i)) continue;
          seen.add(s.i);
          acc.push(s);
        }
      } else if (m.role === "assistant" && acc.length) {
        map.set(m.id, acc.slice());
        lastSourcedId = m.id;
      }
    }
    // The last turn closes here — but only attach its footer once it's no longer
    // running, so a mid-turn answer doesn't show the list before the turn ends.
    if (!running) finalizeTurn();
    return { sourcesByMessage: map, footerIds: footers };
  }, [messages, running]);
  // The row key to flash after a search/timeline jump; cleared once it fades.
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  // Row keys already present, so only genuinely new rows play the slide-up
  // entrance — never the whole thread on open. Reset per session (below).
  const seenRef = useRef<{ sid: string | null; keys: Set<string> } | null>(null);

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

  // Reset the "seen" set whenever the session changes so a reopened/switched
  // thread mounts without a cascade of entrances. Rows added afterwards to the
  // OPEN session (a sent message, a streamed reply, a tool line) fall outside it
  // and get the one-shot slide-up. Keys are deliberately never removed: a row
  // keeps its `animate-message-in` class across re-renders (every streamed
  // token), and a CSS animation only fires once per mount — so streaming can't
  // restart or cut the entrance short.
  if (!seenRef.current || seenRef.current.sid !== sessionId)
    seenRef.current = { sid: sessionId, keys: new Set(rows.map((r) => r.key)) };
  const seenKeys = seenRef.current.keys;

  // MessageScroller replaces react-virtuoso: it renders real DOM rows (no
  // windowing) and stays fast via content-visibility on each item. `autoScroll`
  // pins to the live edge ONLY while the reader is already at the bottom — so a
  // freshly opened session is NOT yanked down and reading history isn't
  // interrupted by streamed tokens (the behaviour the old `followOutput` guard
  // had to fake). `defaultScrollPosition="last-anchor"` opens at the most recent
  // turn; user rows are anchors, so each turn settles cleanly into view.
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller className="absolute inset-0">
        <MessageScrollerViewport>
          {/* gap-0: rows carry their own vertical rhythm via per-row padding, so
              the container must not add the primitive's default gap between them. */}
          <MessageScrollerContent className="gap-0">
            <Spacer />
            {rows.map((row) => (
              <MessageScrollerItem
                key={row.key}
                messageId={row.key}
                // Anchor each user turn so the scroller treats it as a turn
                // boundary (for last-anchor open and turn-aware scrolling).
                scrollAnchor={row.kind === "msg" && row.m.role === "user"}
              >
                <RowView
                  row={row}
                  highlight={row.key === highlightKey}
                  // Genuinely new rows slide in; history (and reduced-motion
                  // users, via the CSS @media guard) render straight to rest.
                  animate={!seenKeys.has(row.key)}
                  sources={
                    row.kind === "msg" ? sourcesByMessage.get(row.m.id) : undefined
                  }
                  showSources={row.kind === "msg" && footerIds.has(row.m.id)}
                />
              </MessageScrollerItem>
            ))}
            <ApprovalFooter />
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* Jump-to-live-edge affordance, lifted above the floating composer. */}
        <MessageScrollerButton
          direction="end"
          className="rounded-full"
          style={{ bottom: "calc(var(--composer-h, 9rem) + 0.5rem)" }}
        />
        <ScrollController rows={rows} onHighlight={setHighlightKey} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/**
 * Consumes the store's queued scroll targets and drives the scroller. Lives
 * INSIDE the provider so it can call `useMessageScroller`. Two sources feed it:
 *   - `pendingScrollIndex`: a full-text search hit, located by the persisted pi
 *     message index (`sourceIndex`); falls back to the nearest preceding message
 *     row, else the top.
 *   - `pendingScrollId`: a timeline-tab jump, located by in-memory UiMessage id
 *     (works for live and replayed messages alike).
 * Both resolve to a row `key` (which is the item's `messageId`) and scroll to it.
 * Since every row is in the DOM, `scrollToMessage` always finds its target — no
 * layout/virtualization race — but we still defer to a rAF so the scroll runs
 * after the current commit, and clear the target INSIDE the frame so clearing it
 * doesn't re-run the effect and cancel the pending scroll before it fires.
 */
function ScrollController({
  rows,
  onHighlight,
}: {
  rows: Row[];
  onHighlight: (key: string | null) => void;
}): null {
  const { scrollToMessage } = useMessageScroller();
  const pendingScrollIndex = useChat((s) => s.pendingScrollIndex);
  const pendingScrollId = useChat((s) => s.pendingScrollId);
  const clearPendingScroll = useChat((s) => s.clearPendingScroll);

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
    const raf = requestAnimationFrame(() => {
      scrollToMessage(key, { align: "center" });
      onHighlight(key);
      clearPendingScroll();
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingScrollIndex, rows, clearPendingScroll, scrollToMessage, onHighlight]);

  useEffect(() => {
    if (pendingScrollId == null || rows.length === 0) return;
    const index = rows.findIndex(
      (r) => r.kind === "msg" && r.m.id === pendingScrollId,
    );
    if (index < 0) {
      clearPendingScroll();
      return;
    }
    const key = rows[index].key;
    const raf = requestAnimationFrame(() => {
      scrollToMessage(key, { align: "center" });
      onHighlight(key);
      clearPendingScroll();
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingScrollId, rows, clearPendingScroll, scrollToMessage, onHighlight]);

  return null;
}

function RowView({
  row,
  highlight,
  animate,
  sources,
  showSources,
}: {
  row: Row;
  highlight?: boolean;
  animate?: boolean;
  sources?: SearchSource[];
  showSources?: boolean;
}): React.JSX.Element {
  const inner =
    row.kind === "group" ? (
      <ToolGroup tools={row.tools} />
    ) : row.kind === "tool" ? (
      <SingleTool m={row.m} />
    ) : (
      <MessageRow m={row.m} sources={sources} showSources={showSources} />
    );
  // `animate-message-in`: a one-shot slide-up + fade as the row enters (the
  // shared keyframe — transform + opacity only, so it never fights the scroller's
  // positioning). Set only on genuinely new rows; the class then persists, and a
  // CSS animation fires once per mount, so streamed re-renders can't restart or
  // cut it short. Transient ring after a search/timeline jump fades as
  // `highlight` flips back to false.
  return (
    <div
      className={cn(
        "transition-colors duration-700",
        animate && "animate-message-in",
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
    <div className="absolute inset-0 flex flex-col overflow-y-auto px-6 py-8">
      {/* Announcements pinned to the top, matching the composer's content width. */}
      <div className="mx-auto w-full max-w-3xl">
        <Announcements />
      </div>
      <div className="flex flex-1 items-center justify-center -mt-40">
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
    </div>
  );
}

function MessageRow({
  m,
  sources,
  showSources,
}: {
  m: UiMessage;
  sources?: SearchSource[];
  showSources?: boolean;
}): React.JSX.Element {
  if (m.role === "user") return <UserRow m={m} />;
  return <AssistantRow m={m} sources={sources} showSources={showSources} />;
}

/** User turn: a quiet, right-aligned chip. Restraint over a loud bubble. */
function UserRow({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-2.5">
      <Message
        align="end"
        // Steered-while-running: queued until pi injects it at the next turn
        // boundary; dim the whole bubble so it doesn't read as already delivered.
        className={cn("transition-opacity", m.queued && "opacity-60")}
      >
        <MessageContent className="items-end gap-1.5">
          {m.images && m.images.length > 0 && (
            <AttachmentGroup className="max-w-[80%]">
              {m.images.map((img, i) => (
                <Attachment key={i} orientation="vertical" className="w-28">
                  <AttachmentMedia variant="image" className="w-full">
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt=""
                    />
                  </AttachmentMedia>
                  <AttachmentTrigger
                    onClick={() => void window.api.openImageViewer(img)}
                    title={t("chat.openImage")}
                    aria-label={t("chat.openImage")}
                  />
                </Attachment>
              ))}
            </AttachmentGroup>
          )}
          {m.imagesIgnored && (
            <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
              <CircleAlert className="size-3" />
              {t("chat.imagesIgnored")}
            </span>
          )}
          {m.text && (
            <div className="max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5 text-sm leading-relaxed text-secondary-foreground">
              {m.text}
            </div>
          )}
          {m.queued && (
            <span className="px-1 text-xs text-muted-foreground">
              {t("chat.queued")}
            </span>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}

/** Agent turn: full-width prose, no frame. The words carry it. */
function AssistantRow({
  m,
  sources,
  showSources,
}: {
  m: UiMessage;
  sources?: SearchSource[];
  showSources?: boolean;
}): React.JSX.Element {
  const hasText = Boolean(m.text.trim());
  const cites = sources ?? [];
  // CitationChip resolves its [n] against `cites` via context at render time. In
  // practice a turn's searches complete before the model writes the answer, so the
  // sources are present by the time this bubble streams and the chips resolve. (We
  // deliberately do NOT bump remarkPlugins to force re-resolution of a late source:
  // an unstable plugin reference crashes Streamdown with React #185 — see the note
  // on STREAMDOWN_REMARK_PLUGINS.)
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-0.5">
      <Message align="start">
        <MessageContent className="gap-2">
          {m.thinking?.trim() && (
            <ReasoningBlock
              text={m.thinking}
              streaming={m.streaming && !hasText}
              answered={hasText}
            />
          )}
          {hasText && (
            <CitationsProvider sources={cites}>
              <Streamdown
                isAnimating={Boolean(m.streaming)}
                caret="circle"
                plugins={STREAMDOWN_PLUGINS}
                remarkPlugins={STREAMDOWN_REMARK_PLUGINS}
                components={STREAMDOWN_COMPONENTS}
                className="space-y-3 text-sm leading-relaxed [&_:where(h1,h2,h3,h4)]:tracking-tight [&_code]:font-mono pt-1"
              >
                {m.text}
              </Streamdown>
              {/* Sources footer: only on the turn's final answer, after the turn
                  ends (showSources) — never under an intermediate answer that
                  still has tool calls to follow. */}
              {showSources && !m.streaming && cites.length > 0 && (
                <SourcesList sources={cites} />
              )}
            </CitationsProvider>
          )}
        </MessageContent>
      </Message>
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
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
        />
        <Sparkle
          className={cn("size-3.5 shrink-0", streaming && "animate-pulse")}
        />
        <span className={cn("text-xs font-medium", streaming && "shimmer")}>
          {streaming ? t("chat.reasoningLive") : t("chat.reasoning")}
        </span>
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
 * One tool call: a low-intrusion single line built on {@link Marker} (a status /
 * system-note row) — tool name + a status icon, collapsed by default; click to
 * reveal the raw output. The presentational unit shared by a standalone call
 * (`SingleTool`) and the members of a `ToolGroup`, so a lone call and a grouped
 * one read identically. The Marker is rendered as the disclosure `<button>`.
 */
function ToolEntry({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const StatusIcon = m.isError ? CircleAlert : SquareTerminal;
  return (
    <div className="py-0.5">
      <Marker
        render={
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} />
        }
        className="cursor-pointer rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
          strokeWidth={2}
        />
        <StatusIcon
          className={cn(
            "size-3.5 shrink-0",
            m.isError ? "text-destructive" : "text-muted-foreground",
          )}
          strokeWidth={2}
        />
        <MarkerContent className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              m.isError ? "text-destructive" : "text-muted-foreground",
              // Shimmer the label while the call is in flight.
              m.running && "shimmer",
            )}
          >
            {m.isError && !m.toolName
              ? t("chat.error")
              : t(toolDisplayKey(m.toolName))}
          </span>
          {m.toolArg && (
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground/60"
              title={m.toolArg}
            >
              {m.toolArg}
            </span>
          )}
        </MarkerContent>
      </Marker>
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
 * collapsed into one quiet {@link Marker} line so the agent's work doesn't bury
 * the conversation. Collapsed it shows a plain-language summary; expanded it
 * reveals each call along a hairline rail. The right-hand status mirrors a single
 * tool's, so the two states share one visual language.
 */
function ToolGroup({ tools }: { tools: UiMessage[] }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anyRunning = tools.some((m) => m.running);
  const anyError = tools.some((m) => m.isError);
  const doneCount = tools.filter((m) => !m.running).length;
  const StatusIcon = anyError ? CircleAlert : SquareTerminal;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-0.5">
      <Marker
        render={
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} />
        }
        className="cursor-pointer rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
          strokeWidth={2}
        />
        <StatusIcon
          className={cn(
            "size-3.5 shrink-0",
            anyError ? "text-destructive" : "text-muted-foreground",
          )}
          strokeWidth={2}
        />
        <MarkerContent className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs font-medium",
              anyError ? "text-destructive" : "text-muted-foreground",
              // Shimmer the "working…" summary while the batch is still running.
              anyRunning && "shimmer",
            )}
          >
            {anyRunning ? t("chat.working") : summarizeTools(tools, t)}
          </span>
          {anyRunning && doneCount > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground/60">
              · {doneCount}
            </span>
          )}
        </MarkerContent>
      </Marker>
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
