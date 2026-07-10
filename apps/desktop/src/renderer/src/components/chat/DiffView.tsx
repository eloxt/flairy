import { PatchDiff } from "@pierre/diffs/react";
import { cn } from "@/lib/utils";
import { useRootDark } from "@/hooks/use-root-dark";

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
