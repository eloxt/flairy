import {
  memo,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Streamdown } from "streamdown";
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import remarkGfm from "remark-gfm";
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
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { toolBucket, toolDisplayKey } from "@/lib/tool-display";
import { imageSrc } from "@/lib/image-src";
import { useChat } from "@/store/chat-store";
import type { UiMessage } from "@/store/chat-store";
import type { SearchSource } from "@shared/web-search";
import {
  CitationChip,
  CitationImage,
  CitationsProvider,
  remarkCitations,
  SourcesList,
} from "./Citations";
import { cardRenderers } from "./cards/renderers";
import { ToolDetail } from "./ToolDetail";
import { AgentDispatchCard } from "./AgentDispatchCard";
import { SystemEventRow } from "./SystemEventRow";
import { ConversationNav, type NavRow } from "./ConversationNav";
import { MessageActions } from "./MessageActions";
import { Onboarding } from "./Onboarding";
import { Announcements } from "./Announcements";
import "streamdown/styles.css";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";

// Stable references for <Streamdown>. Passing fresh object/array literals on each
// render defeats Streamdown's internal memoization — its Block memo compares
// remarkPlugins/rehypePlugins by reference, and plugins/components feed useMemos —
// so every markdown block would re-render and re-run its parser effect on every
// streamed token. During streaming that churn compounds into a "maximum update
// depth exceeded" (React #185) crash. Hoisting these keeps the identities stable.
// These MUST stay module-level values — do NOT compute remarkPlugins per render
// (even via useMemo): an unstable reference resets Streamdown's stateful animation
// plugin every commit and re-triggers the parser's setState, reproducing #185.
// `renderers` maps ui:* code fences to structured cards (@shared/cards
// protocol, progressive streaming render).
//
// mermaid (+ its cytoscape/dagre payload) and math (katex) together are ~1.5MB
// of parsed JS the average chat never touches, so they are NOT imported
// eagerly: assistant markdown starts on the base plugin set and swaps ONCE to
// the full set when the async chunks land (both sets are module-level, so the
// identity-stability rule above still holds — one swap, not one per render).
type StreamdownPlugins = React.ComponentProps<typeof Streamdown>["plugins"];
const BASE_STREAMDOWN_PLUGINS: StreamdownPlugins = {
  code,
  cjk,
  renderers: cardRenderers,
};
let fullStreamdownPlugins: StreamdownPlugins | null = null;
let streamdownExtrasPromise: Promise<void> | null = null;

function loadStreamdownExtras(): Promise<void> {
  streamdownExtrasPromise ??= Promise.all([
    import("@streamdown/mermaid"),
    import("@streamdown/math"),
    import("katex/dist/katex.min.css"),
  ])
    .then(([{ mermaid }, { math }]) => {
      fullStreamdownPlugins = { ...BASE_STREAMDOWN_PLUGINS, mermaid, math };
    })
    .catch((err) => {
      // Mermaid/math blocks then render as plain code fences — acceptable.
      console.error("[markdown] failed to load mermaid/math plugins:", err);
    });
  return streamdownExtrasPromise;
}

/** The current plugin set; kicks off the extras load and re-renders once ready. */
function useStreamdownPlugins(): StreamdownPlugins {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!fullStreamdownPlugins) void loadStreamdownExtras().then(bump);
  }, []);
  return fullStreamdownPlugins ?? BASE_STREAMDOWN_PLUGINS;
}
// Passing remarkPlugins REPLACES Streamdown's default set (which bundles
// remark-gfm). Re-add gfm here or GFM tables/strikethrough/task-lists/autolinks
// stop parsing and render as plain text. gfm goes first to match the default order.
const STREAMDOWN_REMARK_PLUGINS = [remarkGfm, remarkCitations];
// `img` routes every markdown image through the search-image registry (see
// CitationImage) — registry-backed `#i<id>` refs render, anything else doesn't.
const STREAMDOWN_COMPONENTS = { sup: CitationChip, img: CitationImage };

/**
 * Disclosure chevron shared by ToolEntry / ToolGroup / TurnFold: invisible at
 * rest so process lines read as plain text, revealed when the row is hovered
 * (or keyboard-focused), and kept visible while expanded as the open indicator.
 * `group/marker` comes from the Marker root, which IS the trigger button here,
 * and base-ui stamps `data-panel-open` on that same element.
 */
const DISCLOSURE_CHEVRON_CLS =
  "size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-all " +
  "group-hover/marker:opacity-100 group-focus-visible/marker:opacity-100 " +
  "group-data-[panel-open]/marker:rotate-90 group-data-[panel-open]/marker:opacity-100";

/**
 * Collapsible panel with an animated height. base-ui measures the content into
 * `--collapsible-panel-height` for the open/close transition and resets it to
 * `auto` once settled, so content that keeps streaming while expanded can still
 * grow freely. No padding here — under border-box a padded element can't reach
 * height 0, which would leave a visible sliver when collapsed.
 */
const DISCLOSURE_PANEL_CLS =
  "h-[var(--collapsible-panel-height)] overflow-hidden " +
  "transition-[height] duration-200 ease-out " +
  "data-[starting-style]:h-0 data-[ending-style]:h-0";

/**
 * A render unit for the thread. We fold the store's flat message list into rows
 * at render time (the store stays one-message-per-tool-call, so hydration and
 * sync are untouched): adjacent tool calls with no visible text between them
 * collapse into one `group`; a lone call stays a `tool` line; everything else is
 * a `msg`.
 */
type Row =
  | { kind: "msg"; key: string; m: UiMessage }
  | { kind: "tool"; key: string; m: UiMessage }
  | { kind: "group"; key: string; tools: UiMessage[] }
  /**
   * A dispatch_task / dispatch_review call: rendered as a standing agent card
   * (live run status, click → Runs tab) rather than a collapsible tool row,
   * and never folded away — the running worker is the thing the user wants to
   * keep seeing.
   */
  | { kind: "dispatch"; key: string; m: UiMessage }
  /**
   * A machine-injected user turn (worker report / GitHub event, see
   * `UiMessage.injectedEvent`): rendered as a quiet system note instead of a
   * user bubble, and treated as a turn boundary by `foldTurns` — the
   * orchestrator's reaction that follows is a new turn, same as after a
   * genuine prompt.
   */
  | { kind: "event"; key: string; m: UiMessage }
  /**
   * A finished turn's working process — the tool rows/groups between the user
   * prompt and the final answer — folded behind one summary line by
   * `foldTurns` once the run has ended. Only PURE tool work folds: an
   * intermediate assistant note keeps the process expanded, so a fold never
   * contains `msg` rows.
   */
  | { kind: "fold"; key: string; rows: Row[] };

const isDispatchTool = (m: UiMessage): boolean =>
  m.toolName === "dispatch_task" || m.toolName === "dispatch_review";

/** Group adjacent tool calls until a visible non-tool message breaks the run. */
function toRows(messages: UiMessage[]): Row[] {
  const rows: Row[] = [];
  let run: UiMessage[] = [];
  const flush = (): void => {
    // A group keys off its FIRST call's id — the same key the run had while it
    // was still a lone `tool` row. The tool→group upgrade then reuses one
    // MessageScrollerItem instead of remounting, so the scroller's content
    // never sees an equal-count childList swap (its "new anchor appeared"
    // heuristic misreads those and yanks the viewport to a historical anchor).
    if (run.length === 1)
      rows.push({ kind: "tool", key: run[0].id, m: run[0] });
    else if (run.length > 1)
      rows.push({ kind: "group", key: run[0].id, tools: run });
    run = [];
  };
  const hasFollowingVisibleWork = (from: number): boolean => {
    for (let i = from + 1; i < messages.length; i++) {
      const next = messages[i];
      if (next.role === "tool" || next.role === "user") return true;
      if (next.text.trim() || next.thinking?.trim()) return true;
    }
    return false;
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      // Dispatch calls break out of the tool run as their own card row. The
      // groups on either side still key off their own first call's id, so
      // keys stay stable as the run grows.
      if (isDispatchTool(m)) {
        flush();
        rows.push({ kind: "dispatch", key: m.id, m });
        continue;
      }
      run.push(m);
      continue;
    }
    // A tools-only turn leaves an empty assistant bubble in the live store (the
    // stream opens the message before its tool calls); replay drops it. Skip it
    // so the two paths render identically and it adds no blank row. Reasoning is
    // only a live status indicator, not persisted transcript content.
    if (
      m.role === "assistant" &&
      !m.text.trim() &&
      (!m.streaming ||
        !m.thinking?.trim() ||
        hasFollowingVisibleWork(i))
    )
      continue;
    flush();
    if (m.role === "user" && m.injectedEvent)
      rows.push({ kind: "event", key: m.id, m });
    else rows.push({ kind: "msg", key: m.id, m });
  }
  flush();
  return rows;
}

/**
 * Second pass over the row list: for each finished turn whose working process
 * is pure tool work, collapse the tool rows between the user prompt and the
 * final answer into a single `fold` row; a process containing any assistant
 * text stays fully expanded. The active turn (the last segment while a run is
 * in flight) never folds and collapses only when the run ends. The fold
 * reuses its FIRST process row's key so folding re-renders an existing
 * MessageScrollerItem instead of swapping DOM nodes — see the equal-count
 * childList note in `toRows`.
 */
function foldTurns(rows: Row[], running: boolean): Row[] {
  const out: Row[] = [];
  let i = 0;
  while (i < rows.length) {
    // Copy the user prompt that opens the segment (the first segment of a
    // thread may start without one). An injected event row opens a segment
    // the same way — the reaction that follows is its own turn.
    const head = rows[i];
    if ((head.kind === "msg" && head.m.role === "user") || head.kind === "event") {
      out.push(head);
      i++;
    }
    // Collect the segment: everything up to (not including) the next user row.
    const seg: Row[] = [];
    while (i < rows.length) {
      const r = rows[i];
      if ((r.kind === "msg" && r.m.role === "user") || r.kind === "event") break;
      seg.push(r);
      i++;
    }
    // The in-flight turn never folds; it collapses when the run ends.
    if (running && i >= rows.length) {
      out.push(...seg);
      break;
    }
    // The segment's latest answer; everything before it is foldable process.
    let lastText = -1;
    for (let j = seg.length - 1; j >= 0; j--) {
      const r = seg[j];
      if (r.kind === "msg" && r.m.role === "assistant" && r.m.text.trim()) {
        lastText = j;
        break;
      }
    }
    const process = lastText > 0 ? seg.slice(0, lastText) : [];
    const pure = (r: Row): boolean =>
      (r.kind === "tool" && !r.m.running) ||
      (r.kind === "group" && r.tools.every((m) => !m.running));
    if (process.length > 0) {
      // Dispatch cards never fold away — the running worker must stay in
      // view. Fold the pure tool SUBSEGMENTS around them instead; each fold
      // keys off its own first row (stable across re-renders). Within a
      // subsegment the original rules hold: an assistant note keeps it
      // expanded, and a lone row isn't wrapped (it's already one line).
      let sub: Row[] = [];
      const flushSub = (): void => {
        if (sub.length > 1 && sub.every(pure))
          out.push({ kind: "fold", key: sub[0].key, rows: sub });
        else out.push(...sub);
        sub = [];
      };
      for (const r of process) {
        if (r.kind === "dispatch") {
          flushSub();
          out.push(r);
        } else sub.push(r);
      }
      flushSub();
      out.push(...seg.slice(lastText));
    } else {
      out.push(...seg);
    }
  }
  return out;
}

/**
 * Whether `next` is `prev` with ONLY its last message replaced by a same-id
 * update — the shape every streaming delta flush produces. Prefix compared by
 * object identity (the store copies the array but reuses message objects).
 */
function sameExceptLast(prev: UiMessage[], next: UiMessage[]): boolean {
  if (prev.length !== next.length || next.length === 0) return false;
  for (let i = 0; i < next.length - 1; i++) if (prev[i] !== next[i]) return false;
  const a = prev[prev.length - 1];
  const b = next[next.length - 1];
  return a.id === b.id && a.role === b.role;
}

type RowsCache = { messages: UiMessage[]; running: boolean; rows: Row[] };

/**
 * Tail-incremental row computation. A streaming flush only replaces the last
 * message, so only the last row needs rebuilding — every other Row keeps its
 * identity, which is what lets the memoized RowView below bail out for the
 * whole history. Anything that isn't a pure last-message update (new message,
 * tool events, run end) falls back to the full toRows+foldTurns pass.
 */
function computeRows(
  cache: { current: RowsCache | null },
  messages: UiMessage[],
  running: boolean,
): Row[] {
  const prev = cache.current;
  if (prev && prev.running === running && sameExceptLast(prev.messages, messages)) {
    const last = messages[messages.length - 1];
    const lastRow = prev.rows[prev.rows.length - 1];
    if (lastRow?.kind === "msg" && lastRow.m.id === last.id) {
      const rows = [
        ...prev.rows.slice(0, -1),
        { kind: "msg", key: last.id, m: last } as Row,
      ];
      cache.current = { messages, running, rows };
      return rows;
    }
  }
  const rows = foldTurns(toRows(messages), running);
  cache.current = { messages, running, rows };
  return rows;
}

/** Cheap "has visible text" check that doesn't allocate a trimmed copy. */
function hasVisibleText(text: string): boolean {
  return text !== "" && /\S/.test(text);
}

/** Stable empty-sources fallback (see AssistantRow). */
const EMPTY_SOURCES: SearchSource[] = [];

/**
 * Fingerprint of everything the citation-sources pass depends on. Pure text
 * growth on an already-texted assistant doesn't change it, so during streaming
 * the sources map / footer sets keep their identities (CitationsProvider values
 * and fold props stay stable) instead of being rebuilt per flush.
 */
function sourcesFingerprint(messages: UiMessage[], running: boolean): string {
  let key = running ? "r" : "f";
  for (const m of messages) {
    if (m.role === "user") key += "|u" + m.id;
    else if (m.role === "tool" && m.sources?.length)
      key += "|s" + m.id + ":" + m.sources.length;
    else if (m.role === "assistant")
      key += "|a" + m.id + (hasVisibleText(m.text) ? "t" : "");
  }
  return key;
}

interface SourcesInfo {
  sourcesByMessage: Map<string, SearchSource[]>;
  footerIds: Set<string>;
  footerCopyIds: Set<string>;
}

export function MessageList(): React.JSX.Element {
  // Own subscription (not a prop): this is the only component tree that needs
  // per-token re-renders, so the every-delta reference change stops here
  // instead of at a shared parent (see ChatView).
  const messages = useChat((s) => s.messages);
  const compressing = useChat((s) => s.compressing);
  const running = useChat((s) => s.running);
  const sessionId = useChat((s) => s.sessionId);
  const rowsCacheRef = useRef<RowsCache | null>(null);
  const rows = computeRows(rowsCacheRef, messages, running);
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
  //
  // `footerCopyIds` mirrors this for the copy action: a single user prompt may
  // fan out into several tool-call turns, each leaving its own assistant bubble,
  // but the copy affordance belongs on the turn's LAST answer only — not under
  // every intermediate answer. Same finalize-at-user-boundary / finalize-when-
  // done rules so the button never appears mid-turn.
  // Recomputed only when the fingerprint changes (a new message, a source-
  // bearing tool result, first text on an assistant, run end) — NOT on every
  // streamed flush. Keeping the map/set identities stable across flushes is
  // what keeps the memoized rows (and their CitationsProviders) from
  // re-rendering while an answer streams.
  const srcCacheRef = useRef<{ key: string; value: SourcesInfo } | null>(null);
  const srcKey = sourcesFingerprint(messages, running);
  if (srcCacheRef.current?.key !== srcKey) {
    const map = new Map<string, SearchSource[]>();
    const footers = new Set<string>();
    const copyFooters = new Set<string>();
    let acc: SearchSource[] = [];
    let seen = new Set<number>();
    let lastSourcedId: string | null = null;
    let lastAssistantTextId: string | null = null;
    const finalizeTurn = (): void => {
      if (lastSourcedId) footers.add(lastSourcedId);
      lastSourcedId = null;
      if (lastAssistantTextId) copyFooters.add(lastAssistantTextId);
      lastAssistantTextId = null;
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
      } else if (m.role === "assistant") {
        if (acc.length) {
          map.set(m.id, acc.slice());
          lastSourcedId = m.id;
        }
        if (m.text.trim()) lastAssistantTextId = m.id;
      }
    }
    // The last turn closes here — but only attach its footer once it's no longer
    // running, so a mid-turn answer doesn't show the list before the turn ends.
    if (!running) finalizeTurn();
    srcCacheRef.current = {
      key: srcKey,
      value: {
        sourcesByMessage: map,
        footerIds: footers,
        footerCopyIds: copyFooters,
      },
    };
  }
  const { sourcesByMessage, footerIds, footerCopyIds } = srcCacheRef.current.value;
  // The row key to flash after a search/timeline jump; cleared once it fades.
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  // Row keys already present, so only genuinely new rows play the slide-up
  // entrance — never the whole thread on open. Reset per session (below).
  const seenRef = useRef<{ sid: string | null; keys: Set<string> } | null>(
    null,
  );

  // Fade the highlight out after a short beat.
  useEffect(() => {
    if (!highlightKey) return;
    const id = setTimeout(() => setHighlightKey(null), 1600);
    return () => clearTimeout(id);
  }, [highlightKey]);

  // Approvals and questions live on the composer now, so only messages (or a
  // compression in flight) keep the list mounted.
  if (messages.length === 0 && !compressing) return <EmptyState />;

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
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={10} defaultScrollPosition="last-anchor">
      <MessageScroller className="absolute inset-0">
        <MessageScrollerViewport>
          {/* gap-0: rows carry their own vertical rhythm via per-row padding, so
              the container must not add the primitive's default gap between them.
              The head/tail clearances are the CONTENT'S OWN PADDING, never spacer
              children: the scroller finds a newly appended anchor by index
              (`children[oldCount…]`), so any child after the rows shifts that
              window past the new turn and the "pin the turn to the top" scroll
              never fires — the list just sticks to the bottom instead. Padding
              also participates in the primitive's own scroll math, so an anchored
              turn settles below the floating header (pt) and the last row clears
              the floating composer (pb, tracking its live height). */}
          <MessageScrollerContent
            className="gap-0 pt-16"
            style={{ paddingBottom: "var(--composer-h, 9rem)" }}
          >
            {rows.map((row, i) => (
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
                    row.kind === "msg"
                      ? sourcesByMessage.get(row.m.id)
                      : undefined
                  }
                  showSources={row.kind === "msg" && footerIds.has(row.m.id)}
                  showActions={
                    row.kind === "msg" && footerCopyIds.has(row.m.id)
                  }
                />
                {/* The transient tail rides INSIDE the last row's item rather
                    than as a sibling — see the childList note above. It also
                    keeps those rows above the scroller's own spacer, so the
                    thinking dots sit right under the last message instead of
                    below the blank space a pinned turn opens up. */}
                {i === rows.length - 1 && <ThreadFooter />}
              </MessageScrollerItem>
            ))}
            {/* No rows at all (a compression on an empty thread): nothing to
                nest into, and with zero items there is no index math to skew. */}
            {rows.length === 0 && <ThreadFooter />}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* Left-edge navigation rail: one tick per user turn, click to jump.
            Projects rows down to key + plain message so the rail stays decoupled
            from the fold/group row machinery. */}
        <ConversationNav
          rows={rows.map(
            (r): NavRow =>
              r.kind === "msg" || r.kind === "tool"
                ? { key: r.key, message: r.m }
                : { key: r.key },
          )}
        />
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
 * Consumes the store's queued scroll target and drives the scroller. Lives
 * INSIDE the provider so it can call `useMessageScroller`. Fed by
 * `pendingScrollIndex`: a full-text search hit, located by the persisted pi
 * message index (`sourceIndex`); falls back to the nearest preceding message
 * row, else the top. It resolves to a row `key` (which is the item's
 * `messageId`) and scrolls to it; a target folded inside a finished turn
 * resolves to its `fold` row.
 * Since every row is in the DOM, `scrollToMessage` always finds its target — no
 * layout/virtualization race — but we still defer to a rAF so the scroll runs
 * after the current commit, and clear the target INSIDE the frame so clearing it
 * doesn't re-run the effect and cancel the pending scroll before it fires.
 */
/** Every conversation message a row stands for (folds flatten recursively). */
function rowMessages(row: Row): UiMessage[] {
  if (row.kind === "fold") return row.rows.flatMap(rowMessages);
  if (row.kind === "group") return row.tools;
  return [row.m];
}

function ScrollController({
  rows,
  onHighlight,
}: {
  rows: Row[];
  onHighlight: (key: string | null) => void;
}): null {
  const { scrollToMessage } = useMessageScroller();
  const pendingScrollIndex = useChat((s) => s.pendingScrollIndex);
  const clearPendingScroll = useChat((s) => s.clearPendingScroll);

  useEffect(() => {
    if (
      pendingScrollIndex == null ||
      pendingScrollIndex < 0 ||
      rows.length === 0
    )
      return;
    let index = rows.findIndex((r) =>
      rowMessages(r).some((m) => m.sourceIndex === pendingScrollIndex),
    );
    if (index < 0) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (
          rowMessages(rows[i]).some(
            (m) => m.sourceIndex != null && m.sourceIndex < pendingScrollIndex,
          )
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
  }, [
    pendingScrollIndex,
    rows,
    clearPendingScroll,
    scrollToMessage,
    onHighlight,
  ]);

  return null;
}

/**
 * Memoized: during streaming only the LAST row's `row` prop changes identity
 * (see computeRows) and the sources map/sets are fingerprint-cached, so every
 * historical row bails out here instead of re-rendering per flush.
 */
const RowView = memo(function RowView({
  row,
  highlight,
  animate,
  sources,
  showSources,
  showActions,
}: {
  row: Row;
  highlight?: boolean;
  animate?: boolean;
  sources?: SearchSource[];
  showSources?: boolean;
  showActions?: boolean;
}): React.JSX.Element {
  const inner =
    row.kind === "fold" ? (
      <TurnFold rows={row.rows} />
    ) : row.kind === "group" ? (
      <ToolGroup tools={row.tools} />
    ) : row.kind === "tool" ? (
      <SingleTool m={row.m} />
    ) : row.kind === "dispatch" ? (
      <AgentDispatchCard m={row.m} />
    ) : row.kind === "event" ? (
      <SystemEventRow m={row.m} />
    ) : (
      <MessageRow
        m={row.m}
        sources={sources}
        showSources={showSources}
        showActions={showActions}
      />
    );
  // A one-shot entrance as the row enters — transform + opacity only, so it
  // never fights the scroller's positioning (animating height/margin/padding
  // here would). A just-sent prompt gets the springy `animate-message-pop`, the
  // tactile "it left your hands" beat; everything the agent produces slides in
  // quietly with `animate-message-in` so a streaming answer doesn't bounce.
  // Set only on genuinely new rows; the class then persists, and a CSS animation
  // fires once per mount, so streamed re-renders can't restart or cut it short.
  // Transient ring after a search/timeline jump fades as `highlight` flips back
  // to false.
  const sent = row.kind === "msg" && row.m.role === "user";
  return (
    <div
      className={cn(
        "transition-colors duration-700",
        // The row is full-width but the sent bubble hugs its trailing edge, so
        // the pop scales from that corner — scaling about the row's center
        // would drag the bubble sideways as it settles.
        animate &&
          (sent
            ? "animate-message-pop origin-bottom-right"
            : "animate-message-in"),
        highlight && "bg-accent/40",
      )}
    >
      {inner}
    </div>
  );
});


/**
 * Transient status rows at the thread's tail (compression, retry, thinking).
 * The bottom clearance for the floating composer is NOT here — it is the
 * content element's padding, so it can't act as a trailing child (see the
 * childList note in {@link MessageList}).
 */
const ThreadFooter = (): React.JSX.Element => {
  // One PERSISTENT wrapper, deliberately not a fragment: the scroller watches
  // its content element's direct childList, and its "new anchor appeared"
  // heuristic misfires on equal-count swaps — a transient row (e.g. thinking
  // dots) vanishing in the same commit a message row appears would net out to
  // zero and jump the viewport to a historical anchor. Behind one constant
  // div — itself nested inside the last item, out of the observed childList —
  // these rows' churn is invisible to the observer.
  return (
    <div>
      <ToolSelectionRow />
      <CompressionRow />
      <RetryRow />
      <ThinkingRow />
    </div>
  );
};

/** Transient status row shown while the pre-turn tool-selection call runs. */
function ToolSelectionRow(): React.JSX.Element | null {
  const { t } = useTranslation();
  const show = useChat((s) => s.selectingTools);
  if (!show) return null;
  return (
    <div className="animate-message-in mx-auto w-full max-w-(--chat-width) px-6 py-2.5">
      <div className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
        <span className="shimmer text-sm font-medium">{t("chat.selectingTools")}</span>
      </div>
    </div>
  );
}

/** Transient, non-persisted status row shown while context compression runs. */
function CompressionRow(): React.JSX.Element | null {
  const { t } = useTranslation();
  const show = useChat((s) => s.compressing);
  if (!show) return null;
  return (
    <div className="animate-message-in mx-auto w-full max-w-(--chat-width) px-6 py-2.5">
      <div className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
        <span className="shimmer text-sm font-medium">{t("chat.compressingContext")}</span>
      </div>
    </div>
  );
}

/**
 * Transient status row shown while the main process auto-retries a failed
 * model request (the backoff wait + the re-issued request). User-facing copy
 * stays jargon-free: it reads as a connection hiccup, not an API error.
 */
function RetryRow(): React.JSX.Element | null {
  const { t } = useTranslation();
  const retrying = useChat((s) => s.retrying);
  if (!retrying) return null;
  return (
    <div className="animate-message-in mx-auto w-full max-w-(--chat-width) px-6 py-2.5">
      <div
        className="flex items-center gap-2 text-muted-foreground"
        aria-live="polite"
      >
        <span className="shimmer text-sm font-medium">
          {t("chat.retrying", {
            attempt: retrying.attempt,
            max: retrying.max,
          })}
        </span>
      </div>
    </div>
  );
}

/**
 * The pause between sending and the first token. Three dots breathing in place —
 * the only signal the agent is awake. Shown only in that gap: once text streams
 * the caret takes over, and once a tool runs its own row pulses instead.
 */
function ThinkingRow(): React.JSX.Element | null {
  const show = useChat((s) => {
    if (s.compressing) return false;
    // The tool-selection shimmer owns the gap while the pre-turn selector runs.
    if (s.selectingTools) return false;
    // The retry shimmer owns the gap while a failed request is being retried.
    if (s.retrying) return false;
    if (!s.running) return false;
    const last = s.messages[s.messages.length - 1];
    return last?.role === "user";
  });
  if (!show) return null;
  return (
    <div className="animate-message-in mx-auto w-full max-w-(--chat-width) px-6 py-2.5">
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
    <div className="absolute inset-0 flex flex-col overflow-y-auto px-6 pb-8 pt-16">
      {/* Announcements pinned to the top, matching the composer's content width. */}
      <div className="mx-auto w-full max-w-(--chat-width)">
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
  showActions,
}: {
  m: UiMessage;
  sources?: SearchSource[];
  showSources?: boolean;
  showActions?: boolean;
}): React.JSX.Element {
  if (m.role === "user") return <UserRow m={m} />;
  return (
    <AssistantRow
      m={m}
      sources={sources}
      showSources={showSources}
      showActions={showActions}
    />
  );
}

/** User turn: a quiet, right-aligned chip. Restraint over a loud bubble. */
function UserRow({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-(--chat-width) px-6 py-2.5">
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
                    <img src={imageSrc(img)} alt="" />
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
              <IconAlertCircle className="size-3" />
              {t("chat.imagesIgnored")}
            </span>
          )}
          {/* Sent text is plain (not markdown), so keep the author's own line
              breaks instead of letting HTML collapse them. */}
          {m.text && <UserText text={m.text} />}
          {m.queued && (
            <span className="px-1 text-xs text-muted-foreground">
              {t("chat.queued")}
            </span>
          )}
          {/* Copy the sent prompt + send time. Right-aligned to match the
              bubble; skipped while queued so it doesn't sit under the dim chip. */}
          {m.text && !m.queued && (
            <MessageActions text={m.text} timestamp={m.timestamp} />
          )}
        </MessageContent>
      </Message>
    </div>
  );
}

/**
 * A long sent prompt would bury the conversation, so past a preview length
 * the bubble collapses. This is shadcn's bubble "show more" recipe verbatim
 * (Bubble + Collapsible, character-sliced preview, link-button trigger);
 * the preview length is scaled up from the demo's 180 for our wider bubble.
 */
const USER_TEXT_PREVIEW_LENGTH = 400;

function UserText({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isLong = text.length > USER_TEXT_PREVIEW_LENGTH;

  return (
    <Bubble variant="secondary">
      <BubbleContent className="px-4 py-2.5 whitespace-pre-wrap select-text">
        <Collapsible open={open} onOpenChange={setOpen}>
          <div>
            {open || !isLong ? text : `${text.slice(0, USER_TEXT_PREVIEW_LENGTH)}...`}
          </div>
          {isLong && (
            <CollapsibleTrigger
              render={
                <Button variant="link" className="gap-1 p-0 text-muted-foreground" />
              }
            >
              {open ? t("chat.showLess") : t("chat.showMore")}
              <IconChevronDown
                data-icon="inline-end"
                className="transition-transform group-data-panel-open/button:rotate-180"
              />
            </CollapsibleTrigger>
          )}
        </Collapsible>
      </BubbleContent>
    </Bubble>
  );
}

/** Agent turn: full-width prose, no frame. The words carry it. */
function AssistantRow({
  m,
  sources,
  showSources,
  showActions,
}: {
  m: UiMessage;
  sources?: SearchSource[];
  showSources?: boolean;
  showActions?: boolean;
}): React.JSX.Element {
  const hasText = Boolean(m.text.trim());
  // Module-level fallback so sourceless messages keep a STABLE (empty) context
  // value — a fresh [] every render would re-render all CitationChips under it.
  const cites = sources ?? EMPTY_SOURCES;
  const plugins = useStreamdownPlugins();
  // CitationChip resolves its [n] against `cites` via context at render time. In
  // practice a turn's searches complete before the model writes the answer, so the
  // sources are present by the time this bubble streams and the chips resolve. (We
  // deliberately do NOT bump remarkPlugins to force re-resolution of a late source:
  // an unstable plugin reference crashes Streamdown with React #185 — see the note
  // on STREAMDOWN_REMARK_PLUGINS.)
  return (
    <div className="mx-auto w-full max-w-(--chat-width) px-6 py-0.5">
      <Message align="start">
        <MessageContent className="gap-2">
          {m.streaming && !hasText && m.thinking?.trim() && (
            <ReasoningStatus />
          )}
          {hasText && (
            <CitationsProvider sources={cites}>
              <Streamdown
                animated
                isAnimating={Boolean(m.streaming)}
                linkSafety={{ enabled: false }}
                plugins={plugins}
                remarkPlugins={STREAMDOWN_REMARK_PLUGINS}
                components={STREAMDOWN_COMPONENTS}
                className="space-y-3 text-sm leading-relaxed [&_:where(h1,h2,h3,h4)]:tracking-tight [&_code]:font-mono pt-1 select-text"
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
          {/* Message actions (copy) + reply time: only on the turn's final
              answer, once it has fully streamed — a single user prompt can fan
              out into several tool-call turns, but the copy affordance belongs
              at the very end, not under every intermediate answer. */}
          {hasText && !m.streaming && showActions && (
            <MessageActions text={m.text} timestamp={m.timestamp} />
          )}
        </MessageContent>
      </Message>
    </div>
  );
}

/** Live reasoning state only; never reveals or persists the reasoning text. */
function ReasoningStatus(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 rounded-md py-1 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span className="shimmer text-sm font-medium">
        {t("chat.reasoningLive")}
      </span>
    </div>
  );
}

/**
 * One tool call: a low-intrusion single line built on {@link Marker} (a status /
 * system-note row) — tool name + a status icon, collapsed by default; click to
 * reveal the arguments and result. The presentational unit shared by a standalone
 * call (`SingleTool`) and the members of a `ToolGroup`, so a lone call and a
 * grouped one read identically. The Marker is rendered as the disclosure `<button>`.
 */
function ToolEntry({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation();
  // The plan tool gets a live progress summary instead of a raw argument.
  const arg = m.todos
    ? t("toolDetail.planProgress", {
        done: m.todos.filter((x) => x.status === "completed").length,
        total: m.todos.length,
      })
    : m.toolArg;
  return (
    <Collapsible className="py-0.5">
      <Marker render={<CollapsibleTrigger />} className="py-1">
        <MarkerContent className="flex items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-sm font-medium text-muted-foreground",
              // Shimmer the label while the call is in flight.
              m.running && "shimmer",
            )}
          >
            {m.isError && !m.toolName
              ? t("chat.error")
              : t(toolDisplayKey(m.toolName))}
          </span>
          {arg && (
            <span
              className="min-w-0 flex-1 truncate text-sm text-muted-foreground/60"
              title={arg}
            >
              {arg}
            </span>
          )}
          <IconChevronRight className={DISCLOSURE_CHEVRON_CLS} strokeWidth={2} />
        </MarkerContent>
      </Marker>
      <CollapsibleContent className={DISCLOSURE_PANEL_CLS}>
        {/* Hairline rail hangs the detail card off its row, mirroring the
            expanded ToolGroup's member rail. */}
        <div className="mb-1 ml-2 mt-1 border-l border-border pl-3">
          <ToolDetail m={m} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A lone tool call, in the standard message rhythm. */
function SingleTool({ m }: { m: UiMessage }): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-(--chat-width) px-6 py-0.5">
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
  const anyRunning = tools.some((m) => m.running);
  const doneCount = tools.filter((m) => !m.running).length;

  return (
    <Collapsible className="mx-auto w-full max-w-(--chat-width) px-6 py-0.5">
      <Marker render={<CollapsibleTrigger />} className="py-1">
        <MarkerContent className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm font-medium text-muted-foreground",
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
          <IconChevronRight className={DISCLOSURE_CHEVRON_CLS} strokeWidth={2} />
        </MarkerContent>
      </Marker>
      <CollapsibleContent className={DISCLOSURE_PANEL_CLS}>
        <div className="mt-0.5 border-l border-border pl-2.5">
          {tools.map((m) => (
            <ToolEntry key={m.id} m={m} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A turn's working process, folded behind one summary line the moment an
 * answer lands after pure tool work (see `foldTurns`) — and re-absorbing any
 * further rounds at each subsequent answer. Collapsed it reads like a
 * {@link ToolGroup} header — the same plain-language activity clause — so the
 * thread shows just prompt → one quiet line → answer. Expanded it replays the
 * tool rows/groups exactly as they looked live.
 */
function TurnFold({ rows }: { rows: Row[] }): React.JSX.Element {
  const { t } = useTranslation();
  const tools = rows.flatMap(rowMessages).filter((m) => m.role === "tool");

  return (
    <Collapsible>
      <div className="mx-auto w-full max-w-(--chat-width) px-6 py-0.5">
        <Marker render={<CollapsibleTrigger />} className="py-1">
          <MarkerContent className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">
              {summarizeTools(tools, t)}
            </span>
            <IconChevronRight className={DISCLOSURE_CHEVRON_CLS} strokeWidth={2} />
          </MarkerContent>
        </Marker>
      </div>
      <CollapsibleContent className={DISCLOSURE_PANEL_CLS}>
        {rows.map((r) =>
          r.kind === "group" ? (
            <ToolGroup key={r.key} tools={r.tools} />
          ) : r.kind === "tool" ? (
            <SingleTool key={r.key} m={r.m} />
          ) : null,
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
