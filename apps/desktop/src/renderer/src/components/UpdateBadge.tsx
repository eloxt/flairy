import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle } from "lucide-react";
import type { UpdateInfo } from "@shared/ipc";
import { cn } from "@/lib/utils";

/**
 * Header badge that appears only when the main process has found a newer release.
 * On mount it reads any already-known update (a broadcast this window may have
 * missed), then subscribes for live ones. Clicking opens the release page in the
 * OS browser (handled in main via shell.openExternal).
 */
export function UpdateBadge(): React.JSX.Element | null {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    void window.api.getUpdateStatus().then((info) => {
      if (info) setUpdate(info);
    });
    return window.api.onUpdateAvailable((info) => setUpdate(info));
  }, []);

  if (!update) return null;

  return (
    <button
      type="button"
      onClick={() => void window.api.openReleasePage()}
      title={t("update.tooltip", { version: update.version })}
      aria-label={t("update.available")}
      className={cn(
        "app-no-drag relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        "text-primary transition-colors hover:bg-accent",
      )}
    >
      <ArrowUpCircle className="h-[1.05rem] w-[1.05rem]" />
      {/* Pulsing dot to draw the eye to the new-version hint. */}
    </button>
  );
}
