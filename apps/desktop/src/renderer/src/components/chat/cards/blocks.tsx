import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  IconCircleCheck,
  IconCircle,
  IconInfoCircle,
  IconLoader2,
  IconAlertOctagon,
  IconAlertTriangle,
  IconX,
} from "@tabler/icons-react";
import type {
  ArtifactBlock,
  ChartBlock,
  CompareBlock,
  KvListBlock,
  NoteBlock,
  ProgressBlock,
  StatBlock,
  SuggestionsBlock,
  TableBlock,
  TimelineBlock,
  TimelineStep,
} from "@shared/cards";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CardContext } from "./context";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ArtifactAccessResult } from "@shared/ipc";
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

export function CardShell({
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
        "my-2 min-w-0 rounded-xl border border-border bg-card px-4 py-3 text-sm leading-relaxed wrap-anywhere",
        className,
      )}
    >
      {title ? (
        <div className="mb-3 text-sm font-semibold text-foreground">
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function CardText({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  if (text.length <= 240)
    return <span className="whitespace-pre-wrap wrap-anywhere">{text}</span>;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {!open && (
        <span className="whitespace-pre-wrap wrap-anywhere">
          {text.slice(0, 240)}…
        </span>
      )}
      <CollapsibleContent className="whitespace-pre-wrap wrap-anywhere">
        {text}
      </CollapsibleContent>
      <CollapsibleTrigger render={<Button variant="link" size="xs" />}>
        {t(open ? "chat.showLess" : "chat.showMore")}
      </CollapsibleTrigger>
    </Collapsible>
  );
}

/** Placeholder while the fence is streaming in and nothing parses yet. */
export function CardSkeleton() {
  return (
    <CardShell>
      <div className="flex flex-col gap-2">
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
  good: "font-medium text-success",
  bad: "font-medium text-destructive",
} as const;

export function CompareCard({ data }: { data: CompareBlock }) {
  const { t } = useTranslation();
  const labels = Array.from(
    new Set(
      data.rows.flatMap((row) => row.attrs?.map((attr) => attr.label) ?? []),
    ),
  );

  return (
    <CardShell title={data.title}>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("chat.cardCompareHint")}
      </p>
      <ScrollArea className="w-full rounded-lg border border-border/70">
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-sm"
          style={{ minWidth: `${104 + data.rows.length * 160}px` }}
        >
          <thead>
            <tr>
              <th
                aria-hidden="true"
                className="sticky left-0 z-10 w-26 border-b border-r border-border/70 bg-muted/45 p-3"
              />
              {data.rows.map((row, i) => (
                <th
                  key={i}
                  scope="col"
                  className={cn(
                    "border-b border-r border-border/70 bg-muted/25 p-3 text-left align-top font-normal last:border-r-0",
                    row.pick && "bg-primary/[0.07]",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-foreground">
                      {row.name}
                    </span>
                    {row.pick ? (
                      <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold leading-none text-primary-foreground">
                        {t("chat.cardRecommended")}
                      </span>
                    ) : null}
                  </div>
                  {row.pick && row.pickReason && (
                    <div className="mt-2 text-sm text-foreground">
                      <CardText text={row.pickReason} />
                    </div>
                  )}
                  {row.note ? (
                    <div className="mt-1.5 text-sm font-normal leading-relaxed text-muted-foreground">
                      <CardText text={row.note} />
                    </div>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          {labels.length ? (
            <tbody>
              {labels.map((label) => (
                <tr key={label} className="group">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b border-r border-border/70 bg-card p-3 text-left text-sm font-medium text-muted-foreground group-last:border-b-0"
                  >
                    {label}
                  </th>
                  {data.rows.map((row, i) => {
                    const attr = row.attrs?.find(
                      (candidate) => candidate.label === label,
                    );

                    return (
                      <td
                        key={i}
                        className={cn(
                          "border-b border-r border-border/70 p-3 align-top last:border-r-0 group-last:border-b-0",
                          row.pick && "bg-primary/[0.035]",
                        )}
                      >
                        {attr ? (
                          <div
                            className={cn(
                              "tabular-nums leading-relaxed text-foreground/90",
                              attr.tone && ATTR_TONE_CLS[attr.tone],
                            )}
                          >
                            <CardText text={attr.value} />
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
        <ScrollBar orientation="horizontal" className="z-20" />
      </ScrollArea>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// ui:kv_list
// ---------------------------------------------------------------------------

export function KvListCard({ data }: { data: KvListBlock }) {
  return (
    <CardShell title={data.title}>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-6 gap-y-1.5">
        {data.items.map((item, i) => (
          <React.Fragment key={i}>
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd
              className={cn(
                "min-w-0",
                item.emphasis === "good" && "font-medium text-success",
                item.emphasis === "bad" && "font-medium text-destructive",
              )}
            >
              <CardText text={item.value} />
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
  live,
}: {
  live: boolean;
  status: TimelineStep["status"];
}) {
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "done":
      return <IconCircleCheck className={cn(cls, "text-success")} />;
    case "active":
      return (
        <IconLoader2
          className={cn(
            cls,
            "text-foreground",
            live && "motion-safe:animate-spin",
          )}
        />
      );
    case "failed":
      return <IconX className={cn(cls, "text-destructive")} />;
    default:
      return <IconCircle className={cn(cls, "text-muted-foreground/40")} />;
  }
}

export function TimelineCard({ data }: { data: TimelineBlock }) {
  const { streaming } = React.useContext(CardContext);
  const { t } = useTranslation();
  return (
    <CardShell title={data.title}>
      <ol>
        {data.steps.map((step, i) => {
          const last = i === data.steps.length - 1;
          return (
            <li key={i} className="flex gap-2.5">
              <div className="flex flex-col items-center pt-1">
                <TimelineMarker status={step.status} live={streaming} />
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
                    {step.status !== "event" && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t(`chat.cardStatus_${step.status}`)}
                      </span>
                    )}
                  </span>
                  {step.time ? (
                    <span className="text-xs text-muted-foreground">
                      {step.time}
                    </span>
                  ) : null}
                </div>
                {step.note ? (
                  <div className="text-sm text-muted-foreground">
                    <CardText text={step.note} />
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
    icon: IconInfoCircle,
  },
  warning: {
    box: "border-warning/30 bg-warning/5 text-warning",
    icon: IconAlertTriangle,
  },
  danger: {
    box: "border-destructive/30 bg-destructive/5 text-destructive",
    icon: IconAlertOctagon,
  },
  success: {
    box: "border-success/30 bg-success/5 text-success",
    icon: IconCircleCheck,
  },
} as const;

export function NoteCard({ data }: { data: NoteBlock }) {
  const style = NOTE_STYLE[data.tone];
  const Icon = style.icon;
  return (
    <div
      role="note"
      className={cn(
        "my-2 flex gap-2.5 rounded-xl border px-4 py-3 text-sm wrap-anywhere",
        style.box,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        {data.title ? (
          <div className="font-medium text-foreground">{data.title}</div>
        ) : null}
        <div className="leading-relaxed text-foreground/90">
          <CardText text={data.text} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ui:suggestions
// ---------------------------------------------------------------------------

export function SuggestionsCard({ data }: { data: SuggestionsBlock }) {
  const { t } = useTranslation();
  const { streaming, preview, sessionId } = React.useContext(CardContext);
  const send = useChat((s) => s.send);
  const [selected, setSelected] = React.useState<number | null>(null);
  const clicked = React.useRef(false);
  return (
    <div className="my-2 flex flex-wrap items-center gap-2">
      {data.items.map((item, i) => (
        <Button
          key={i}
          variant="outline"
          size="sm"
          disabled={streaming || selected !== null}
          onClick={() => {
            if (clicked.current) return;
            if (
              !preview &&
              (!sessionId || useChat.getState().sessionId !== sessionId)
            )
              return;
            clicked.current = true;
            setSelected(i);
            if (!preview) void send(item.userText?.trim() || item.label);
          }}
        >
          {item.label}
        </Button>
      ))}
      {selected !== null && (
        <span role="status" className="text-xs text-muted-foreground">
          {t(preview ? "chat.cardPreviewOnly" : "chat.cardSent")}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ui:stat
// ---------------------------------------------------------------------------

const TREND_CLS = {
  good: "text-success",
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
            {item.description && (
              <div className="mt-1 text-sm text-muted-foreground">
                <CardText text={item.description} />
              </div>
            )}
            {item.trendText ? (
              <div
                className={cn(
                  "text-xs",
                  TREND_CLS[item.trendTone ?? "neutral"],
                )}
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
  good: "text-success",
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
                    <CardText text={row.cells[j] ?? ""} />
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
  warning: "[&_[data-slot=progress-indicator]]:bg-warning",
  danger: "[&_[data-slot=progress-indicator]]:bg-destructive",
  success: "[&_[data-slot=progress-indicator]]:bg-success",
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
  const { streaming } = React.useContext(CardContext);
  const { t } = useTranslation();
  return (
    <CardShell title={data.title}>
      {data.points.length === 0 ? (
        // Placeholder while streaming, before the first complete data point
        streaming ? (
          <Skeleton className="h-36 w-full" />
        ) : (
          <p className="text-muted-foreground">{t("chat.cardEmpty")}</p>
        )
      ) : (
        <React.Suspense fallback={<Skeleton className="h-36 w-full" />}>
          <ChartPlot data={data} />
        </React.Suspense>
      )}
    </CardShell>
  );
}

export function ArtifactCard({ data }: { data: ArtifactBlock }) {
  const { t } = useTranslation();
  const { sessionId, preview } = React.useContext(CardContext);
  const [file, setFile] = React.useState<ArtifactAccessResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    setFile(null);
    if (preview) {
      setFile({
        kind: "file",
        name: "报告.txt",
        size: 42,
        content: "这是内部预览示例。真实成果由成功的文件写入记录确认。",
      });
    } else if (sessionId) {
      void window.api
        .accessArtifact({
          sessionId,
          artifactId: data.artifactId,
          action: "preview",
        })
        .then((result) => {
          if (!cancelled) setFile(result);
        })
        .catch(() => {
          if (!cancelled) setFile({ kind: "error" });
        });
    } else setFile({ kind: "error" });
    return () => {
      cancelled = true;
    };
  }, [sessionId, data.artifactId, preview]);
  return (
    <CardShell
      title={
        data.title ??
        (file?.kind === "file" ? file.name : t("chat.cardArtifact"))
      }
    >
      {data.description && <CardText text={data.description} />}
      {!file ? (
        <CardSkeleton />
      ) : file.kind !== "file" ? (
        <p className="text-muted-foreground">{t("chat.cardFileUnavailable")}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {file.name} · {Math.ceil(file.size / 1024)} KB
          </p>
          {file.content !== undefined && (
            <Collapsible>
              <CollapsibleTrigger
                render={<Button variant="outline" size="sm" />}
              >
                {t("chat.cardPreview")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-sm">
                  {file.content}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
          <div className="flex flex-wrap gap-2">
            {(["reveal", "save"] as const).map((action) => (
              <Button
                key={action}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (preview) {
                    setFeedback(t("chat.cardPreviewOnly"));
                    return;
                  }
                  if (!sessionId) return;
                  setBusy(true);
                  setFeedback("");
                  try {
                    const result = await window.api.accessArtifact({
                      sessionId,
                      artifactId: data.artifactId,
                      action,
                    });
                    if (result.kind === "error")
                      setFeedback(t("chat.cardFileUnavailable"));
                    else if (result.kind === "done")
                      setFeedback(t("chat.cardActionDone"));
                  } catch {
                    setFeedback(t("chat.cardFileUnavailable"));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t(action === "reveal" ? "chat.cardReveal" : "chat.cardSave")}
              </Button>
            ))}
          </div>
          {feedback && (
            <p role="status" className="text-xs text-muted-foreground">
              {feedback}
            </p>
          )}
        </div>
      )}
    </CardShell>
  );
}
