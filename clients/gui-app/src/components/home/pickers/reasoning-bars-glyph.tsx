import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ReasoningBarsGlyphProps {
  /** One bar per thinking level the model exposes, in catalog order. */
  readonly count: number;
  /**
   * Bars filled from the left - the current level's 1-based position, or 0
   * when the current level is not one of the bars (a no-thinking level, or a
   * value the model does not expose).
   */
  readonly filled: number;
  /** Accessible name, e.g. `Thinking: High (3 of 4)`. */
  readonly label: string;
  readonly className: string | undefined;
}

/** The glyph's height in user units; `h-3.5` scales the whole box to it. */
const HEIGHT = 16;
/** A bar and the gap after it. Constant, so bars never thin out as N grows. */
const SLOT = 4;
/** A bar's share of its slot; the remainder is the gap to the next bar. */
const BAR_SHARE = 0.65;
/** The shortest bar, so a one-of-seven level is still a visible mark. */
const MIN_BAR_HEIGHT = 5;

/**
 * A network-signal glyph for the thinking effort: `count` bars of increasing
 * height, the first `filled` drawn solid. The slot per bar is FIXED and the
 * box grows sideways with the count (`h-3.5 w-auto`), because harnesses
 * advertise anywhere from two levels to seven - dividing a fixed width by the
 * count would shave a seven-level glyph down to hairlines while a two-level
 * one drew slabs. Severity-neutral by design - a higher level is not a
 * warning - so the fill is the foreground and the rest a faded muted
 * foreground.
 */
export function ReasoningBarsGlyph(props: ReasoningBarsGlyphProps): ReactNode {
  const { count, filled, label, className } = props;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${count * SLOT} ${HEIGHT}`}
      className={cn("h-3.5 w-auto shrink-0", className)}
    >
      {Array.from({ length: count }, (_, index) => {
        // A lone bar is the tallest of its (one-element) ladder, not a
        // mid-height stub: `count - 1` would divide by zero.
        const height =
          count === 1
            ? HEIGHT
            : MIN_BAR_HEIGHT +
              ((HEIGHT - MIN_BAR_HEIGHT) * index) / (count - 1);
        const isFilled = index < filled;
        return (
          <rect
            key={index}
            x={index * SLOT}
            y={HEIGHT - height}
            width={SLOT * BAR_SHARE}
            height={height}
            rx={1}
            data-filled={isFilled ? "true" : "false"}
            className={
              isFilled ? "fill-foreground" : "fill-muted-foreground/40"
            }
          />
        );
      })}
    </svg>
  );
}
