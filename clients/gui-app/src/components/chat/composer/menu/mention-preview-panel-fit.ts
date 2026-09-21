// Below this, the panel would render unreadably small - hide it instead.
const PANEL_MIN_WIDTH_PX = 160;
const PANEL_MIN_HEIGHT_PX = 48;

/**
 * Given the space the `size` middleware measured, decide whether the panel
 * shows at all, and cap it to that space below its CSS-declared
 * `w-[min(90vw,22rem)]` ceiling so it never renders past the viewport edge.
 *
 * What that space is differs by axis, because the panel's `shift` clamps it
 * horizontally but not vertically:
 * - Width: with a horizontal shift enabled, `size` reports the whole
 *   boundary's width less padding, NOT the room beside the anchor row. The
 *   width check therefore only hides the panel on a viewport too narrow for
 *   it; a panel with no room on either side of the menu is slid back on
 *   screen, over the list, and still shows.
 * - Height: measured from the anchor row's top to the bottom of the usable
 *   area - the viewport less the padding and the strip a software keyboard
 *   covers - so a row too close to that edge hides the panel.
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
