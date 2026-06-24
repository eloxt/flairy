import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder, ShieldCheck } from "lucide-react";

/** Where the "first run is over" flag lives. Per-install, never sensitive. */
const SEEN_KEY = "flairy.onboarding.seen";

/** Whether the first-run guide has already been dismissed on this machine. */
function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode / disabled storage: treat as unseen, just never persist.
    return false;
  }
}

/**
 * First-run guide, shown beneath the empty-state invitation: two quiet hints
 * that point a newcomer to the working-directory and permission controls living
 * in the composer below. Dismissed once (persisted in localStorage) it never
 * returns; sending a first message also retires the empty state for good.
 */
export function Onboarding(): React.JSX.Element | null {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(hasSeenOnboarding);
  if (dismissed) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Best-effort persistence; dismissing for this view still works.
    }
    setDismissed(true);
  };

  return (
    <div
      className="animate-rise-in mt-8 space-y-3 text-left"
      style={{ animationDelay: "180ms" }}
    >
      <Hint
        icon={<Folder className="size-4" strokeWidth={1.75} />}
        title={t("onboarding.cwdTitle")}
        body={t("onboarding.cwdBody")}
      />
      <Hint
        icon={<ShieldCheck className="size-4" strokeWidth={1.75} />}
        title={t("onboarding.permTitle")}
        body={t("onboarding.permBody")}
      />
      <div className="text-center">
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {t("onboarding.dismiss")}
        </button>
      </div>
    </div>
  );
}

/** One guide row: a bordered icon tile beside a title and a plain-words note. */
function Hint({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-medium tracking-tight text-foreground">
          {title}
        </h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
    </div>
  );
}
