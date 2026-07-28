import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPhoto as ImageIcon } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import {
  useMessageScroller,
  useMessageScrollerVisibility,
} from "@/components/ui/message-scroller";
import type { UiMessage } from "@/store/chat-store";

/**
 * A conversation "section" = one user prompt plus everything that follows it.
 * Its id is the user row's key (which is also the MessageScroller anchor id),
 * so clicking a tick scrolls straight to that turn.
 */
interface NavSection {
  /** Anchor row key (the key scrollToMessage / currentAnchorId speak). */
  id: string;
  /** Tick title: what the user said this turn. */
  title: string;
  /** Overview: preview of this turn's answer text (concatenated, clamped). */
  preview: string;
  /** Image attachments on the user message (annotated on the preview card). */
  imageCount: number;
}

/** The row shape ConversationNav needs — a projection of MessageList's Row. */
export interface NavRow {
  key: string;
  /** The single message this row renders, when it's a plain `msg` row. */
  message?: UiMessage;
}

/** Drop ui:* card fences (and any code fence) from answer previews — the
 * preview is prose; raw fenced JSON/code would read as noise. */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Slice the row sequence into "user prompt → following answers" sections, plus
 * a `row key → owning section id` map: viewport visibility reports row keys,
 * and this folds them back into sections so every turn currently on screen
 * lights up (tool/group/fold rows count toward their turn too).
 */
function toSections(
  rows: NavRow[],
  imageOnlyLabel: string,
): {
  sections: NavSection[];
  memberOf: Map<string, string>;
} {
  const sections: NavSection[] = [];
  const memberOf = new Map<string, string>();
  for (const row of rows) {
    const m = row.message;
    if (m?.role === "user") {
      sections.push({
        id: row.key,
        title: m.text.trim() || imageOnlyLabel,
        preview: "",
        imageCount: m.images?.length ?? 0,
      });
      memberOf.set(row.key, row.key);
      continue;
    }
    const current = sections[sections.length - 1];
    if (!current) continue;
    memberOf.set(row.key, current.id);
    if (m?.role !== "assistant") continue;
    // The card shows ~3 clamped lines, so only the head of the answer matters.
    // Bounding both the regex input and the accumulated preview keeps this
    // whole pass O(sections), not O(total conversation text) — it reruns on
    // streamed updates.
    if (current.preview.length >= PREVIEW_MAX_CHARS) continue;
    const text = stripFences(m.text.slice(0, PREVIEW_SCAN_CHARS));
    if (!text) continue;
    current.preview = current.preview ? `${current.preview}\n${text}` : text;
  }
  return { sections, memberOf };
}

/** Enough source text to fill the clamped preview lines. */
const PREVIEW_SCAN_CHARS = 600;
/** Stop accumulating once the preview already overfills the clamp. */
const PREVIEW_MAX_CHARS = 300;

/** Resting tick length (uniform). */
const BASE_W = 8;
/** Peak tick length, directly under the cursor. */
const PEAK_W = 34;
/** Magnification radius (px): past this distance a tick rests at BASE_W. */
const RADIUS = 46;

/**
 * Fisheye magnification: cursor-to-tick-center distance → length. Peaks at the
 * cursor and falls off in a smooth cosine bell to either side — macOS-Dock
 * style "whatever you point at grows".
 */
function magnifiedWidth(dist: number): number {
  if (dist >= RADIUS) return BASE_W;
  const f = 0.5 * (1 + Math.cos((Math.PI * dist) / RADIUS));
  return Math.round(BASE_W + (PEAK_W - BASE_W) * f);
}

/**
 * Conversation navigation rail: a floating column of horizontal ticks on the
 * left edge of the message column, one tick per user prompt. At rest all ticks
 * are equal-length and low-contrast; the current reading position is bold like
 * a playhead. Hovering the rail applies cursor-tracked fisheye magnification —
 * the pointed-at tick grows longest, neighbours fall off smoothly — and slides
 * out a preview card for that turn. Clicking a tick scrolls to the turn.
 *
 * Must render inside MessageScrollerProvider (it consumes the scroller's
 * visibility and scrolling context).
 */
export function ConversationNav({ rows }: { rows: NavRow[] }) {
  const { t } = useTranslation();
  const { scrollToMessage } = useMessageScroller();
  const { currentAnchorId, visibleMessageIds } = useMessageScrollerVisibility();
  const ulRef = useRef<HTMLUListElement>(null);
  // Per-tick current length; null = at rest (all equal). Magnification only
  // applies while hovered / focused.
  const [widths, setWidths] = useState<number[] | null>(null);
  // Index of the tick under the cursor (or focus): drives peak + preview card.
  const [peak, setPeak] = useState<number | null>(null);

  const imageOnlyLabel = t("chat.navImageOnly");
  const { sections, memberOf } = useMemo(
    () => toSections(rows, imageOnlyLabel),
    [rows, imageOnlyLabel],
  );

  // Every turn currently in the viewport (visible rows folded back into their
  // sections) — all their ticks light up as one band.
  const visibleSectionIds = useMemo(() => {
    const set = new Set<string>();
    for (const id of visibleMessageIds) {
      const sec = memberOf.get(id);
      if (sec) set.add(sec);
    }
    return set;
  }, [visibleMessageIds, memberOf]);

  // Fewer than two turns has no navigation value; wide viewports only.
  if (sections.length < 2) return null;

  // The turn being read: follow the visible anchor, else the first turn.
  const currentId =
    sections.find((s) => s.id === currentAnchorId)?.id ?? sections[0].id;

  /** Cursor moving on the rail: recompute every tick's length from its center
   * distance, and find the pointed-at one. */
  function handleMove(e: React.MouseEvent): void {
    const ul = ulRef.current;
    if (!ul) return;
    const ticks = Array.from(ul.querySelectorAll<HTMLElement>("[data-tick]"));
    const y = e.clientY;
    let bestI = 0;
    let bestD = Infinity;
    const next = ticks.map((el, i) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(y - (r.top + r.height / 2));
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
      return magnifiedWidth(d);
    });
    setWidths(next);
    setPeak(bestI);
  }

  /** Keyboard focus on a tick: same fisheye with that index as the peak
   * (distance estimated from row pitch). */
  function handleFocus(index: number): void {
    setPeak(index);
    setWidths(sections.map((_, j) => magnifiedWidth(Math.abs(j - index) * 9)));
  }

  function reset(): void {
    setWidths(null);
    setPeak(null);
  }

  // Only transition lengths at rest: while hovering, ticks must track the
  // cursor instantly; on leave they settle back smoothly.
  const settling = widths === null;

  return (
    // The outer layer ignores pointer events so this transparent band never
    // blocks message scrolling/selection; the rail and card opt back in.
    <nav
      aria-label={t("chat.navLabel")}
      className="pointer-events-none absolute inset-y-0 left-1 z-20 hidden items-center lg:flex"
    >
      <ul
        ref={ulRef}
        onMouseMove={handleMove}
        onMouseLeave={reset}
        // gap-0 + short rows: ticks abut into one continuous clickable strip
        // (no dead zones), compact as a ruler.
        className="pointer-events-auto flex flex-col py-2"
      >
        {sections.map((s, i) => {
          const isCurrent = s.id === currentId;
          const isVisible = visibleSectionIds.has(s.id);
          const isPeak = i === peak;
          const w = widths ? widths[i] : BASE_W;
          return (
            <li key={s.id} className="relative flex items-center">
              <button
                data-tick
                type="button"
                aria-label={s.title}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() =>
                  scrollToMessage(s.id, { align: "start", behavior: "smooth" })
                }
                onFocus={() => handleFocus(i)}
                onBlur={reset}
                className="group/tick flex h-2.75 items-center outline-none"
              >
                {/* The tick itself: one horizontal line. Low-contrast and
                    equal-length at rest; current position bold; pointed-at
                    tick elongated and brightened (the peak). */}
                <span
                  style={{ width: w }}
                  className={cn(
                    "h-0.5 rounded-full",
                    // Track the cursor instantly while magnifying; only
                    // transition length on settle/rest.
                    settling
                      ? "transition-[width,height,background-color] duration-200 ease-out motion-reduce:transition-none"
                      : "transition-[height,background-color] duration-150 motion-reduce:transition-none",
                    // Color/weight encode visibility: the current anchor is
                    // solid+bold (viewport lead), other on-screen turns form a
                    // softer band, off-screen ticks brighten on point,
                    // otherwise stay low-contrast. Length (magnification) and
                    // color are independent axes.
                    isCurrent
                      ? "h-0.75 bg-primary"
                      : isVisible
                        ? "bg-primary/60"
                        : isPeak
                          ? "bg-muted-foreground/80"
                          : "bg-muted-foreground/35",
                    // The tick is too thin to show focus itself; ring the line.
                    "group-focus-visible/tick:ring-2 group-focus-visible/tick:ring-ring/50 group-focus-visible/tick:ring-offset-2 group-focus-visible/tick:ring-offset-background",
                  )}
                />
              </button>

              {/* Preview card for the pointed-at tick only. Mounted on demand
                  rather than one always-mounted (opacity-0) card per section:
                  each card is a real backdrop-blur DOM subtree, and a long
                  conversation would otherwise keep dozens of them in the
                  layout permanently. */}
              {isPeak && (
                <div
                  className={cn(
                    "pointer-events-none absolute left-full top-1/2 z-30 ml-3 w-72 max-w-[min(20rem,40vw)] -translate-y-1/2",
                    "rounded-lg border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur",
                    "origin-left",
                  )}
                >
                  <div className="line-clamp-2 text-sm font-medium leading-snug">
                    {s.title}
                  </div>
                  {s.preview ? (
                    <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {s.preview}
                    </p>
                  ) : null}
                  {s.imageCount > 0 ? (
                    <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground/80">
                      <ImageIcon className="size-3 shrink-0" />
                      <span>{t("chat.navImages", { count: s.imageCount })}</span>
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
