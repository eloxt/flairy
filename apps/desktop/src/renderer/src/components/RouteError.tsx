import { useRouteError } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error screen. Replaces React Router's default dev error page —
 * which dumps a stack trace at our non-technical users — with a calm, plain
 * message and a one-click reload. The renderer runs over a hash router on
 * file://, so reloading the document is the cleanest way back to a good state.
 *
 * Wired as the root route's `errorElement`, so it also catches render errors
 * thrown anywhere in the child routes. Because it replaces the whole app shell
 * (the draggable header lives in there), it ships its own `app-drag` strip so
 * the frameless window stays movable and the macOS traffic lights keep clear.
 */
export function RouteError(): React.JSX.Element {
  const { t } = useTranslation();
  const error = useRouteError();

  // Prefer a full stack for troubleshooting; fall back to the message, then to
  // a stringified non-Error throw. Kept collapsed so users never see it unless
  // they go looking.
  const stack =
    error instanceof Error
      ? error.stack || error.message
      : error
        ? String(error)
        : "";

  return (
    <div className="relative flex h-screen w-screen flex-col bg-background">
      {/* Empty drag strip: the only way to move the frameless window now that the
          normal header is gone. Matches the h-12 title-bar height elsewhere. */}
      <div className="app-drag h-12 shrink-0" />

      <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-auto px-8 pb-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <AlertTriangle className="size-6" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">
            {t("error.title")}
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("error.body")}
          </p>
        </div>
        <Button onClick={() => window.location.reload()}>
          {t("error.reload")}
        </Button>
        {stack ? (
          <details className="app-no-drag mt-2 w-full max-w-lg text-left">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground/70 hover:text-muted-foreground">
              {t("error.details")}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground/80 select-text">
              {stack}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
