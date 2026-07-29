import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconChevronRight, IconRobot } from "@tabler/icons-react";
import type { WorkerRun, WorkerRunStatus } from "@shared/ipc";
import { cn } from "@/lib/utils";
import { useChat, type UiMessage } from "@/store/chat-store";
import { useUi } from "@/store/ui-store";

/**
 * A dispatch_task / dispatch_review call rendered as a standing agent card in
 * the thread — not a collapsed tool row: the dispatch IS the visible artifact
 * of the turn (a worker is now running somewhere), so it stays in view with its
 * LIVE status, and clicking it navigates to the details panel's Runs tab where
 * the streaming tail / transcript / abort live.
 *
 * The run id is parsed from the tool's confirmation text ("… (run <uuid>)");
 * status arrives via the initial run list plus WorkerRunChanged pushes.
 */
export function AgentDispatchCard({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation();
  const sessionId = useChat((s) => s.sessionId);
  const requestRightPanelTab = useUi((s) => s.requestRightPanelTab);
  const [run, setRun] = useState<WorkerRun | null>(null);

  const isReview = m.toolName === "dispatch_review";
  const args = parseArgs(m.toolArgs);
  const runId = /run ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
    m.text,
  )?.[1];

  useEffect(() => {
    if (!runId || !sessionId) return;
    let alive = true;
    void window.api.listWorkerRuns(sessionId).then((rs) => {
      if (!alive) return;
      const found = rs.find((r) => r.id === runId);
      if (found) setRun(found);
    });
    const off = window.api.onWorkerRunChanged((r) => {
      if (r.id === runId) setRun(r);
    });
    return () => {
      alive = false;
      off();
    };
  }, [runId, sessionId]);

  const target =
    args?.issueNumber != null
      ? `#${args.issueNumber}`
      : args?.prNumber != null
        ? `PR #${args.prNumber}`
        : (m.toolArg ?? "");
  const backend = run?.backend ?? argStr(args, "backend");

  // The tool call itself failed (backend disabled, no repo…): a quiet error
  // card — there is no run to navigate to.
  if (m.isError) {
    return (
      <div className="mx-auto w-full max-w-(--chat-width) px-6 py-1">
        <div className="flex max-w-md items-start gap-2.5 rounded-[10px] border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 text-[13px] leading-relaxed">
            <div className="font-medium text-destructive">
              {t(isReview ? "chat.dispatchReviewFailed" : "chat.dispatchTaskFailed")}
            </div>
            {m.text.trim() && (
              <div className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground select-text">
                {m.text.trim()}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const status: WorkerRunStatus | undefined = run?.status;
  const live = !status || ["preparing", "running", "pushing"].includes(status);

  return (
    <div className="mx-auto w-full max-w-(--chat-width) px-6 py-1">
      <button
        type="button"
        onClick={() => requestRightPanelTab("runs")}
        className="group/dispatch flex w-full max-w-md items-center gap-3 rounded-[10px] border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
      >
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-[8px]",
            live
              ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
              : status === "pr_opened" || status === "reviewed"
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive",
          )}
        >
          <IconRobot className="size-4.5" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">
            {target}
            {backend && <span className="font-normal text-muted-foreground"> → {backend}</span>}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {t(isReview ? "chat.dispatchReview" : "chat.dispatchTask")}
          </span>
        </span>
        {status ? (
          <StatusChip status={status} />
        ) : (
          m.running && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t("chat.dispatching")}
              <span className="ml-0.5 inline-block animate-pulse">·</span>
            </span>
          )
        )}
        <IconChevronRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover/dispatch:translate-x-0.5" />
      </button>
    </div>
  );
}

function StatusChip({ status }: { status: WorkerRunStatus }): React.JSX.Element {
  const { t } = useTranslation();
  const styles: Record<WorkerRunStatus, string> = {
    preparing: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    pushing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    pr_opened: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    reviewed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    failed: "bg-destructive/15 text-destructive",
    cancelled: "bg-foreground/10 text-muted-foreground",
    timeout: "bg-destructive/15 text-destructive",
  };
  const live = status === "preparing" || status === "running" || status === "pushing";
  return (
    <span
      className={cn("shrink-0 rounded-full px-2 py-px text-[10px] font-medium", styles[status])}
    >
      {t(`panel.runStatus.${status}`)}
      {live && <span className="ml-0.5 inline-block animate-pulse">·</span>}
    </span>
  );
}

function parseArgs(toolArgs: string | undefined): Record<string, unknown> | undefined {
  if (!toolArgs) return undefined;
  try {
    const v = JSON.parse(toolArgs) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function argStr(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = args?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
