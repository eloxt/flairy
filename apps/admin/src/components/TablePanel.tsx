import { cn } from "@/lib/utils";

/**
 * A hairline-bordered surface that holds a `<Table>` flush to its edge.
 *
 * Replaces the heavier `Card` + `CardContent p-0` wrapper that used to box
 * every data table: a `Card` adds a ring, an `xl` radius, and vertical
 * `py-4` spacing, which leaves a full-bleed table floating inside an
 * over-padded box. This is just the structure a list needs — a single
 * hairline, square-to-the-edge rows — and it restyles the table it wraps so
 * every admin table reads the same:
 *   · a quiet, uppercase eyebrow header bar (matches `.eyebrow`)
 *   · edge padding so cell content clears the border
 *   · comfortable row height
 */
export function TablePanel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        // Header bar: muted, short, uppercase eyebrow lettering.
        "[&_thead_th]:h-9 [&_thead_th]:bg-muted/40 [&_thead_th]:text-[0.625rem] [&_thead_th]:font-semibold [&_thead_th]:tracking-[0.12em] [&_thead_th]:text-muted-foreground [&_thead_th]:uppercase",
        // Edge padding so the first/last columns clear the hairline.
        "[&_th:first-child]:pl-4 [&_td:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4",
        // Roomier rows than the default compact table.
        "[&_tbody_td]:py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Centered muted message for an empty table surface. */
export function TableEmpty({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="px-4 py-12 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
