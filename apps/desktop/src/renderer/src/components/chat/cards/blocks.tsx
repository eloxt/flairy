import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  CircleCheck,
  Circle,
  Info,
  LoaderCircle,
  OctagonAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  ChartBlock,
  CompareBlock,
  KvListBlock,
  NoteBlock,
  ProgressBlock,
  StatBlock,
  SuggestionsBlock,
  TableBlock,
  TimelineBlock,
} from "@shared/cards";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useChat } from "@/store/chat-store";

/**
 * Presentation components for inline cards. The data has already been cleaned
 * and validated by the @shared/cards parse layer, so these only lay it out;
 * semantic color is reserved for status (emerald=positive / amber=warning /
 * destructive=negative), everything else stays on neutral theme tokens.
 */

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

function CardShell({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "my-2 rounded-xl border border-border bg-card px-4 py-3",
        className,
      )}
    >
      {title ? (
        <div className="-mx-4 -mt-3 mb-3 border-b border-border/70 px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground">
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Placeholder while the fence is streaming in and nothing parses yet. */
export function CardSkeleton() {
  return (
    <CardShell>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:compare
// ---------------------------------------------------------------------------

const ATTR_TONE_CLS = {
  good: "font-medium text-emerald-700 dark:text-emerald-400",
  bad: "font-medium text-destructive",
} as const;

export function CompareCard({ data }: { data: CompareBlock }) {
  const { t } = useTranslation();
  return (
    <CardShell title={data.title}>
      <div>
        {data.rows.map((row, i) => (
          <div
            key={i}
            className={cn(
              "py-2 first:pt-0 last:pb-0",
              i > 0 && "border-t border-border/60",
            )}
          >
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="font-medium">{row.name}</span>
              {row.pick ? (
                <span className="rounded-full bg-primary px-2 py-px text-[11px] font-medium text-primary-foreground">
                  {t("chat.cardRecommended")}
                </span>
              ) : null}
            </div>
            {row.attrs?.length ? (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                {row.attrs.map((attr, j) => (
                  <span key={j} className="inline-flex items-baseline gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {attr.label}
                    </span>
                    <span
                      className={cn(
                        "tabular-nums text-foreground/90",
                        attr.tone && ATTR_TONE_CLS[attr.tone],
                      )}
                    >
                      {attr.value}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
            {row.note ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {row.note}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:kv_list
// ---------------------------------------------------------------------------

export function KvListCard({ data }: { data: KvListBlock }) {
  return (
    <CardShell title={data.title}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
        {data.items.map((item, i) => (
          <React.Fragment key={i}>
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd
              className={cn(
                "min-w-0",
                item.emphasis === "good" &&
                  "font-medium text-emerald-700 dark:text-emerald-400",
                item.emphasis === "bad" && "font-medium text-destructive",
              )}
            >
              {item.value}
              {item.hint ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {item.hint}
                </span>
              ) : null}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:timeline
// ---------------------------------------------------------------------------

function TimelineMarker({
  status,
}: {
  status: "done" | "active" | "pending" | "failed";
}) {
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "done":
      return (
        <CircleCheck
          className={cn(cls, "text-emerald-600 dark:text-emerald-400")}
        />
      );
    case "active":
      return (
        <LoaderCircle className={cn(cls, "animate-spin text-foreground")} />
      );
    case "failed":
      return <X className={cn(cls, "text-destructive")} />;
    default:
      return <Circle className={cn(cls, "text-muted-foreground/40")} />;
  }
}

export function TimelineCard({ data }: { data: TimelineBlock }) {
  return (
    <CardShell title={data.title}>
      <ol>
        {data.steps.map((step, i) => {
          const last = i === data.steps.length - 1;
          return (
            <li key={i} className="flex gap-2.5">
              <div className="flex flex-col items-center pt-1">
                <TimelineMarker status={step.status} />
                {!last ? <div className="w-px flex-1 bg-border" /> : null}
              </div>
              <div className={cn("min-w-0", !last && "pb-3")}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={cn(
                      step.status === "pending" && "text-muted-foreground",
                      step.status === "active" && "font-medium",
                      step.status === "failed" && "text-destructive",
                    )}
                  >
                    {step.label}
                  </span>
                  {step.time ? (
                    <span className="text-xs text-muted-foreground">
                      {step.time}
                    </span>
                  ) : null}
                </div>
                {step.note ? (
                  <div className="text-xs text-muted-foreground">
                    {step.note}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:note
// ---------------------------------------------------------------------------

const NOTE_STYLE = {
  info: {
    box: "border-border bg-muted/40 text-muted-foreground",
    icon: Info,
  },
  warning: {
    box: "border-amber-300/60 bg-amber-500/5 text-amber-600 dark:border-amber-400/20 dark:text-amber-400",
    icon: TriangleAlert,
  },
  danger: {
    box: "border-destructive/30 bg-destructive/5 text-destructive",
    icon: OctagonAlert,
  },
  success: {
    box: "border-emerald-300/60 bg-emerald-500/5 text-emerald-600 dark:border-emerald-400/20 dark:text-emerald-400",
    icon: CircleCheck,
  },
} as const;

export function NoteCard({ data }: { data: NoteBlock }) {
  const style = NOTE_STYLE[data.tone];
  const Icon = style.icon;
  return (
    <div
      role="note"
      className={cn(
        "my-2 flex gap-2.5 rounded-xl border px-3.5 py-2.5",
        style.box,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        {data.title ? (
          <div className="font-medium text-foreground">{data.title}</div>
        ) : null}
        <div className="leading-relaxed text-foreground/90">{data.text}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ui:suggestions
// ---------------------------------------------------------------------------

export function SuggestionsCard({ data }: { data: SuggestionsBlock }) {
  // A button IS the user's next utterance: clicking routes straight through
  // the store's send (steering the run if one is still active), identical to
  // typing the text into the composer.
  const send = useChat((s) => s.send);
  return (
    <div className="my-2 flex flex-wrap gap-2">
      {data.items.map((item, i) => (
        <Button
          key={i}
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-3 text-xs font-normal"
          onClick={() => void send(item.userText?.trim() || item.label)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ui:stat
// ---------------------------------------------------------------------------

const TREND_CLS = {
  good: "text-emerald-700 dark:text-emerald-400",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
} as const;

export function StatCard({ data }: { data: StatBlock }) {
  return (
    <CardShell title={data.title}>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(8rem,1fr))]">
        {data.items.map((item, i) => (
          <div key={i} className="min-w-0">
            <div className="text-xs text-muted-foreground">{item.label}</div>
            <div className="text-2xl font-semibold tabular-nums tracking-tight">
              {item.value}
              {item.unit ? (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  {item.unit}
                </span>
              ) : null}
            </div>
            {item.trendText ? (
              <div
                className={cn("text-xs", TREND_CLS[item.trendTone ?? "neutral"])}
              >
                {item.trendText}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:table
// ---------------------------------------------------------------------------

const ROW_TONE_CLS = {
  good: "text-emerald-700 dark:text-emerald-400",
  bad: "text-destructive",
  muted: "text-muted-foreground",
} as const;

export function TableCard({ data }: { data: TableBlock }) {
  return (
    <CardShell title={data.title}>
      <div className="overflow-x-auto">
        <table className="w-full caption-bottom text-sm">
          <thead>
            <tr className="border-b border-border/70">
              {data.columns.map((col, i) => (
                <th
                  key={i}
                  className="h-9 px-2 text-left align-middle text-xs font-medium text-muted-foreground first:pl-0 last:pr-0"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr
                key={i}
                className={cn(
                  "border-b border-border/40 last:border-0",
                  row.tone && ROW_TONE_CLS[row.tone],
                  data.emphasizeRowIndex === i && "bg-accent/60",
                )}
              >
                {data.columns.map((_, j) => (
                  <td
                    key={j}
                    className="px-2 py-2 align-middle tabular-nums first:pl-0 last:pr-0"
                  >
                    {row.cells[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:progress
// ---------------------------------------------------------------------------

const PROGRESS_TONE_CLS = {
  info: "[&_[data-slot=progress-indicator]]:bg-primary",
  warning: "[&_[data-slot=progress-indicator]]:bg-amber-500",
  danger: "[&_[data-slot=progress-indicator]]:bg-destructive",
  success: "[&_[data-slot=progress-indicator]]:bg-emerald-500",
} as const;

export function ProgressCard({ data }: { data: ProgressBlock }) {
  const value = Math.min(100, Math.max(0, data.value));
  return (
    <CardShell>
      <div className="mb-1.5 flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground">{data.label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {data.valueText ?? `${Math.round(value)}%`}
        </span>
      </div>
      <Progress
        value={value}
        aria-label={data.label}
        className={PROGRESS_TONE_CLS[data.tone ?? "info"]}
      />
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:chart
// ---------------------------------------------------------------------------

// The plot layer is split into its own chunk: charts are rare in a chat, so
// the code only loads when a message actually contains one.
const ChartPlot = React.lazy(() => import("./chart-plot"));

export function ChartCard({ data }: { data: ChartBlock }) {
  return (
    <CardShell title={data.title}>
      {data.points.length === 0 ? (
        // Placeholder while streaming, before the first complete data point
        <Skeleton className="h-36 w-full" />
      ) : (
        <React.Suspense fallback={<Skeleton className="h-36 w-full" />}>
          <ChartPlot data={data} />
        </React.Suspense>
      )}
    </CardShell>
  );
}
