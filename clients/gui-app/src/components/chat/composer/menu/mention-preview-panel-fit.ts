// Below this, the panel would render unreadably small (or entirely
// off-viewport, since main-axis shift is disabled) - hide it instead.
const PANEL_MIN_WIDTH_PX = 160;
const PANEL_MIN_HEIGHT_PX = 48;

/**
 * Given the space the `size` middleware measured on the chosen (post-flip)
 * side, decide whether the panel shows at all, and how far to shrink it
 * below its CSS-declared `w-[min(90vw,22rem)]` ceiling so it never renders
 * past the viewport edge - `shift`'s main axis is disabled, so nothing else
 * pulls it back on screen once the requested width no longer fits.
 *
 * `availableWidth`/`availableHeight` can go negative (the reference itself
 * already overflows the boundary before this middleware runs); clamp to 0
 * since a negative CSS length is invalid and gets silently dropped, which
 * would leave the panel unconstrained instead of hidden.
 */
export function panelFitFor(
  availableWidth: number,
  availableHeight: number,
): {
  readonly fits: boolean;
  readonly maxWidthPx: number;
  readonly maxHeightPx: number;
} {
  return {
    fits:
      availableWidth >= PANEL_MIN_WIDTH_PX &&
      availableHeight >= PANEL_MIN_HEIGHT_PX,
    maxWidthPx: Math.max(0, availableWidth),
    maxHeightPx: Math.max(0, availableHeight),
  };
}
