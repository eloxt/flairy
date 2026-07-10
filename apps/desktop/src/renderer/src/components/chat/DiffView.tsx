import { useEffect, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { cn } from "@/lib/utils";

/**
 * Track the app's light/dark appearance reactively. `lib/theme.ts`
 * (followSystemTheme) is the single source of truth — it toggles the `.dark`
 * class on the document root — and @pierre/diffs needs an explicit `themeType`
 * to pick the matching Shiki variant, so we observe that class rather than
 * subscribing to the media query a second time.
 */
function useRootDark(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setDark(root.classList.contains("dark")),
    );
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * Renders a unified (stacked) diff from a patch string using @pierre/diffs.
 * Used by the `edit` / `write` tool rows. The worker pool is disabled so Shiki
 * tokenization runs on the main thread — chat tool diffs are small (capped at
 * the source, see write.ts), and this avoids worker-URL resolution pitfalls
 * inside the Electron renderer bundle.
 */
export function DiffView({
  patch,
  className,
}: {
  patch: string;
  className?: string;
}): React.JSX.Element {
  const dark = useRootDark();
  return (
    <div
      className={cn(
        "mt-1 max-h-96 overflow-auto rounded-md border border-border",
        className,
      )}
    >
      <PatchDiff
        patch={patch}
        disableWorkerPool
        options={{
          diffStyle: "unified",
          themeType: dark ? "dark" : "light",
          overflow: "wrap",
        }}
      />
    </div>
  );
}
