import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { MessageFooter } from "@/components/ui/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Wall-clock label for a message's timestamp; "" when it has none. Today's
 * messages show hour:minute only; older ones are prefixed with the date (and
 * the year once it differs) so threads spanning days stay unambiguous.
 */
function clockTime(ts: number | undefined): string {
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return date.toLocaleString(undefined, {
    ...(sameDay
      ? {}
      : {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
        }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The action row for a message — the send/receive time plus copy (and later
 * retry/feedback). Placed inside a {@link MessageFooter} per the shadcn Message
 * convention. Hidden until the message is hovered (or an action is focused for
 * keyboard users), so the prose stays uncluttered; `opacity` reveal keeps the
 * row's space reserved so the thread never shifts on hover.
 */
export function MessageActions({
  text,
  timestamp,
  className,
}: {
  text: string;
  timestamp?: number;
  className?: string;
}): React.JSX.Element {
  const time = clockTime(timestamp);
  return (
    <MessageFooter
      className={cn(
        "gap-1 px-0 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-within:opacity-100",
        className,
      )}
    >
      <CopyButton text={text} />
      {time && (
        <time
          dateTime={new Date(timestamp!).toISOString()}
          className="text-xs tabular-nums text-muted-foreground/70"
        >
          {time}
        </time>
      )}
    </MessageFooter>
  );
}

/**
 * Copies `text` to the clipboard and flips to a check for a beat as confirmation.
 * Built on the same bare {@link TooltipTrigger}-as-button pattern the composer
 * uses, so no TooltipProvider is required.
 */
export function CopyButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current ?? undefined);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject (e.g. denied permission); leave the icon unchanged.
    }
  };

  const label = copied ? t("chat.copied") : t("chat.copy");
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onCopy}
        aria-label={label}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {copied ? (
          <IconCheck className="size-3.5" />
        ) : (
          <IconCopy className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
