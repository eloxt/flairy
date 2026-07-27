import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertCircle,
  IconArrowUpCircle,
  IconRefresh,
} from "@tabler/icons-react";
import type { UpdateState } from "@shared/ipc";
import { cn } from "@/lib/utils";

/**
 * Header badge that appears only when the main process knows about a newer
 * release. On mount it reads the current state (catching up on any broadcast
 * this window missed), then subscribes for live ones.
 *
 * Two behaviours, decided by main via `canInstall`:
 * - Windows: click downloads the update in place (ring shows progress), then
 *   click again to restart into it.
 * - Everywhere else: click opens the release page in the OS browser.
 */

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function UpdateBadge(): React.JSX.Element | null {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    void window.api.getUpdateState().then(setState);
    return window.api.onUpdateState(setState);
  }, []);

  if (!state || state.stage === "idle" || !state.info) return null;

  const version = state.info.version;
  const percent = Math.min(100, Math.max(0, state.progress?.percent ?? 0));
  const downloading = state.stage === "downloading";

  const label = ((): string => {
    switch (state.stage) {
      case "downloading":
        return t("update.downloading", {
          version,
          percent: Math.floor(percent),
        });
      case "ready":
        return t("update.ready", { version });
      case "error":
        return t("update.failed");
      default:
        return state.canInstall
          ? t("update.download", { version })
          : t("update.tooltip", { version });
    }
  })();

  const handleClick = (): void => {
    switch (state.stage) {
      case "available":
        void (state.canInstall
          ? window.api.downloadUpdate()
          : window.api.openReleasePage());
        break;
      case "ready":
        void window.api.installUpdate();
        break;
      case "error":
        // Escape hatch: the self-install failed, so send them to the download page.
        void window.api.openReleasePage();
        break;
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={downloading}
      title={label}
      aria-label={label}
      className={cn(
        "app-no-drag relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        "transition-colors hover:bg-accent disabled:hover:bg-transparent",
        state.stage === "error" ? "text-destructive" : "text-primary",
      )}
    >
      {downloading ? (
        <svg
          viewBox="0 0 20 20"
          className="h-[1.05rem] w-[1.05rem] -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-primary/25"
          />
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
            className="stroke-primary transition-[stroke-dashoffset] duration-300"
          />
        </svg>
      ) : state.stage === "ready" ? (
        <IconRefresh className="h-[1.05rem] w-[1.05rem]" />
      ) : state.stage === "error" ? (
        <IconAlertCircle className="h-[1.05rem] w-[1.05rem]" />
      ) : (
        <IconArrowUpCircle className="h-[1.05rem] w-[1.05rem]" />
      )}
      {/* Once the installer is on disk the only thing left is a restart, so draw the eye. */}
      {state.stage === "ready" && (
        <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      )}
    </button>
  );
}
