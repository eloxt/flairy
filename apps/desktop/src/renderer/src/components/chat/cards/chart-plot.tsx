import * as React from "react";
import type { ChartBlock } from "@shared/cards";
import { cn } from "@/lib/utils";

/**
 * The actual plot layer for ui:chart, hand-rolled on divs/SVG (no charting
 * dep). Split into its own file so ChartCard can React.lazy it — the chunk
 * loads only when a chart card actually appears in a message.
 *
 * Single series → no legend (the card title names it); marks use the neutral
 * `--chart-1` token so light/dark both resolve from the theme. Values live in
 * the hover tooltip + an accessible per-mark title, not printed on every mark.
 * No entry animation: points stream in one by one and a replaying animation
 * would flicker.
 */

/** Display format: thousands separators, at most two decimals. */
function fmt(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export default function ChartPlot({ data }: { data: ChartBlock }) {
  const [active, setActive] = React.useState<number | null>(null);
  const points = data.points;
  const n = points.length;

  // Zero-anchored domain: bars must grow from a 0 baseline; negative values
  // extend the domain downward instead of clipping.
  const values = points.map((p) => p.value);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max = 1; // all-zero series: keep a flat baseline renderable
  const span = max - min;
  /** Fraction of the plot height from the bottom, for a value. */
  const frac = (v: number) => (v - min) / span;
  const zero = frac(0);

  return (
    <div>
      <div
        className="relative h-32"
        onMouseLeave={() => setActive(null)}
      >
        {/* Recessive grid: three quarter lines, plus a slightly stronger zero
            baseline (only visibly distinct when negatives shift it off 0%). */}
        {[0.25, 0.5, 0.75].map((f) => (
          <div
            key={f}
            className="absolute inset-x-0 border-t border-border/40"
            style={{ bottom: `${f * 100}%` }}
          />
        ))}
        <div
          className="absolute inset-x-0 border-t border-border"
          style={{ bottom: `${zero * 100}%` }}
        />

        {data.type === "bar" ? (
          <div className="absolute inset-0 flex">
            {points.map((p, i) => {
              const top = Math.max(frac(p.value), zero);
              const bottom = Math.min(frac(p.value), zero);
              return (
                <div
                  key={i}
                  className="relative h-full flex-1"
                  onMouseEnter={() => setActive(i)}
                >
                  <div
                    className={cn(
                      "absolute inset-x-0 mx-auto w-3/5 max-w-8 bg-(--chart-1) transition-opacity",
                      // Rounded data-end anchored to the baseline: top corners
                      // for positive bars, bottom corners for negative ones.
                      p.value >= 0 ? "rounded-t-[4px]" : "rounded-b-[4px]",
                      active !== null && active !== i && "opacity-50",
                    )}
                    style={{
                      bottom: `${bottom * 100}%`,
                      height: `${Math.max((top - bottom) * 100, 0.75)}%`,
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <svg
              className="absolute inset-0 size-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polyline
                points={points
                  .map(
                    (p, i) =>
                      `${((i + 0.5) / n) * 100},${(1 - frac(p.value)) * 100}`,
                  )
                  .join(" ")}
                fill="none"
                stroke="var(--chart-1)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {/* Hover targets are full columns (bigger than the mark); the dot
                itself only shows for the active point. */}
            <div className="absolute inset-0 flex">
              {points.map((p, i) => (
                <div
                  key={i}
                  className="relative h-full flex-1"
                  onMouseEnter={() => setActive(i)}
                >
                  <div
                    className={cn(
                      "absolute left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-background bg-(--chart-1)",
                      active === i ? "opacity-100" : "opacity-0",
                    )}
                    style={{ bottom: `${frac(p.value) * 100}%` }}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {/* Tooltip: label + formatted value (+ unit) above the active column. */}
        {active !== null && points[active] ? (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-sm"
            style={{ left: `${((active + 0.5) / n) * 100}%` }}
          >
            <span className="text-muted-foreground">
              {points[active].label}
            </span>
            <span className="ml-2 font-medium tabular-nums text-popover-foreground">
              {fmt(points[active].value)}
              {data.unit ? (
                <span className="ml-0.5 font-normal text-muted-foreground">
                  {data.unit}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>

      {/* X labels: one centered per column, truncated; muted so they recede. */}
      <div
        className="mt-1 grid"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {points.map((p, i) => (
          <span
            key={i}
            title={`${p.label}: ${fmt(p.value)}${data.unit ?? ""}`}
            className="truncate px-0.5 text-center text-[10px] text-muted-foreground"
          >
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}
