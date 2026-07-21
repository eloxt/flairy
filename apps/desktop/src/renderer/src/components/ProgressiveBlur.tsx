import { cn } from "@/lib/utils";

/**
 * Progressive (gradient) backdrop blur, ported from motion-primitives'
 * ProgressiveBlur (https://motion-primitives.com/docs/progressive-blur) with
 * the `motion` dependency dropped — we only need the static effect.
 *
 * A single masked backdrop-blur can only FADE one fixed blur strength in and
 * out, which reads as a milky band with a visible edge. The real effect stacks
 * several backdrop-filter layers whose blur radii increase layer by layer,
 * each masked to a narrow overlapping band — together they read as blur that
 * gradually ramps up toward `direction`.
 */
const GRADIENT_ANGLES = {
  top: 0,
  right: 90,
  bottom: 180,
  left: 270,
} as const;

export function ProgressiveBlur({
  direction = "bottom",
  blurLayers = 8,
  blurIntensity = 0.25,
  className,
}: {
  /** Side where the blur is strongest. */
  direction?: keyof typeof GRADIENT_ANGLES;
  /** Number of stacked backdrop-filter layers (min 2). */
  blurLayers?: number;
  /** Per-layer blur increment in px; max blur ≈ layers × intensity. */
  blurIntensity?: number;
  className?: string;
}): React.JSX.Element {
  const layers = Math.max(blurLayers, 2);
  const segmentSize = 1 / (layers + 1);

  return (
    <div aria-hidden className={cn("relative", className)}>
      {Array.from({ length: layers }).map((_, index) => {
        const angle = GRADIENT_ANGLES[direction];
        const gradientStops = [
          index * segmentSize,
          (index + 1) * segmentSize,
          (index + 2) * segmentSize,
          (index + 3) * segmentSize,
        ].map(
          (pos, posIndex) =>
            `rgba(255, 255, 255, ${posIndex === 1 || posIndex === 2 ? 1 : 0}) ${pos * 100}%`,
        );
        const gradient = `linear-gradient(${angle}deg, ${gradientStops.join(", ")})`;
        return (
          <div
            key={index}
            className="pointer-events-none absolute inset-0 rounded-[inherit]"
            style={{
              maskImage: gradient,
              WebkitMaskImage: gradient,
              backdropFilter: `blur(${index * blurIntensity}px)`,
              WebkitBackdropFilter: `blur(${index * blurIntensity}px)`,
            }}
          />
        );
      })}
    </div>
  );
}
