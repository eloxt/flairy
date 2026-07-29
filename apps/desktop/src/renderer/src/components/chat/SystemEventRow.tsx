import { useTranslation } from "react-i18next";
import { IconChevronRight, IconClock, IconRobot } from "@tabler/icons-react";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import type { UiMessage } from "@/store/chat-store";

/**
 * A machine-injected user turn — a worker's completion report (see
 * `@shared/injected-events`) — rendered as a quiet system note in the thread
 * instead of a user bubble: the message wasn't typed by the user, it's the
 * dispatched worker talking to the orchestrator. Collapsed it reads as one
 * Marker line (icon + kind + first line of the report); expanding reveals the
 * full body, which the assistant's reaction below usually paraphrases anyway.
 */
export function SystemEventRow({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation();
  const firstLine = m.text.split("\n", 1)[0].trim();
  const schedule = m.injectedEvent === "schedule";
  const Icon = schedule ? IconClock : IconRobot;

  return (
    <div className="mx-auto w-full max-w-(--chat-width) px-6 py-0.5">
      <Collapsible className="py-0.5">
        <Marker render={<CollapsibleTrigger />} className="py-1">
          <MarkerContent className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
            <span className="shrink-0 text-sm font-medium text-muted-foreground">
              {t(schedule ? "chat.scheduledRun" : "chat.workerReport")}
            </span>
            {firstLine && (
              <span
                className="min-w-0 flex-1 truncate text-sm text-muted-foreground/60"
                title={firstLine}
              >
                {firstLine}
              </span>
            )}
            <IconChevronRight
              className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-all group-hover/marker:opacity-100 group-focus-visible/marker:opacity-100 group-data-[panel-open]/marker:rotate-90 group-data-[panel-open]/marker:opacity-100"
              strokeWidth={2}
            />
          </MarkerContent>
        </Marker>
        <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[starting-style]:h-0 data-[ending-style]:h-0">
          <div className="mb-1 ml-2 mt-1 border-l border-border pl-3">
            <div className="whitespace-pre-wrap break-words py-1 text-[13px] leading-relaxed text-muted-foreground">
              {m.text}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
