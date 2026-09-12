import { useEffect, useState, type RefObject } from "react";

/**
 * How much of itself the strip can afford to show.
 *
 * Measured from the BAR's own width rather than the viewport's, because the
 * strip is the thing that runs out of room: a window can be wide while the bar
 * is narrow (it is not, today, but the segments below it are laid out against
 * their container and nothing else). Container width is also what the same
 * thresholds mean in the design.
 *
 * Component state, never persisted. It is a fact about the current window, and
 * a persisted copy of it would be wrong the moment the window was resized on
 * another screen.
 */
export type StatusBarDensity = "full" | "compact" | "icon-only";

const COMPACT_MAX_WIDTH_PX = 900;
const ICON_ONLY_MAX_WIDTH_PX = 500;

export function statusBarDensityForWidth(widthPx: number): StatusBarDensity {
  if (widthPx < ICON_ONLY_MAX_WIDTH_PX) return "icon-only";
  if (widthPx < COMPACT_MAX_WIDTH_PX) return "compact";
  return "full";
}

/**
 * Starts at `full` and narrows on the first observation rather than measuring
 * during layout: a `ResizeObserver` fires synchronously after the first paint,
 * so the widest form is on screen for at most one frame — and the alternative,
 * reading `offsetWidth` in a layout effect, is a forced reflow on every mount
 * of the shell for a value the observer is about to deliver anyway.
 */
export function useStatusBarDensity(
  ref: RefObject<HTMLElement | null>,
): StatusBarDensity {
  const [density, setDensity] = useState<StatusBarDensity>("full");
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      // The LAST entry, not the first: a batch delivered after several resizes
      // in one frame carries them in order, and the first is already stale by
      // the time this runs.
      const width = entries.at(-1)?.contentRect.width;
      if (width === undefined) return;
      setDensity(statusBarDensityForWidth(width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return density;
}
