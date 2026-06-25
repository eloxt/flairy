import { useTranslation } from "react-i18next";
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AnnouncementConfig, AnnouncementKind } from "@flairy/shared";
import { cn } from "@/lib/utils";
import { useAnnouncements } from "@/hooks/use-announcements";

/** Per-kind icon + tone classes. Soft tinted card so banners read as ambient. */
const KIND_STYLE: Record<
  AnnouncementKind,
  { icon: LucideIcon; container: string; icon_: string }
> = {
  info: {
    icon: Info,
    container:
      "border-sky-500/25 bg-sky-500/5 text-sky-900 dark:text-sky-100",
    icon_: "text-sky-600 dark:text-sky-400",
  },
  success: {
    icon: CircleCheck,
    container:
      "border-emerald-500/25 bg-emerald-500/5 text-emerald-900 dark:text-emerald-100",
    icon_: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    icon: TriangleAlert,
    container:
      "border-amber-500/25 bg-amber-500/5 text-amber-900 dark:text-amber-100",
    icon_: "text-amber-600 dark:text-amber-400",
  },
  error: {
    icon: CircleAlert,
    container:
      "border-red-500/25 bg-red-500/5 text-red-900 dark:text-red-100",
    icon_: "text-red-600 dark:text-red-400",
  },
};

/**
 * Server-pushed system announcements, shown atop the empty chat screen. Each is a
 * soft tinted banner with a type icon, title, and body; the user can dismiss one
 * (remembered locally via {@link useAnnouncements}, never synced to the server).
 * Renders nothing when there's nothing enabled and undismissed.
 */
export function Announcements(): React.JSX.Element | null {
  const { announcements, dismiss } = useAnnouncements();
  if (announcements.length === 0) return null;

  return (
    <div className="animate-rise-in mb-8 space-y-2.5 text-left">
      {announcements.map((a) => (
        <AnnouncementBanner key={a.id} announcement={a} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function AnnouncementBanner({
  announcement,
  onDismiss,
}: {
  announcement: AnnouncementConfig;
  onDismiss: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { icon: Icon, container, icon_ } = KIND_STYLE[announcement.kind];

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3",
        container,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", icon_)} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium tracking-tight">
          {announcement.title}
        </h3>
        {announcement.content && (
          <p className="mt-0.5 text-xs leading-relaxed opacity-80 whitespace-pre-wrap">
            {announcement.content}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(announcement.id)}
        aria-label={t("chat.dismissAnnouncement")}
        title={t("chat.dismissAnnouncement")}
        className="-mr-1 -mt-0.5 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
