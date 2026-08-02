/**
 * Contract between the transcript scroll region (producer) and any overlay
 * that clips/clamps its geometry to it (consumer: the user-message minimap,
 * the quote-selection popover). The composer/queue dock overlays the BOTTOM
 * of the region (decision #3, #13) without shrinking the region's own box -
 * so a naive `getBoundingClientRect()` on the region reports a bottom edge
 * that extends behind the opaque dock. Consumers must clamp against the
 * CURRENT measured inset instead - passed explicitly as a value (a prop, not
 * a one-time DOM read), since the dock's height can change while a consumer
 * is already open without the region element's OWN box changing (it's
 * absolutely overlaid, not a sibling that pushes layout) - a DOM-attribute
 * read that only re-runs on the region's OWN ResizeObserver would go stale.
 */

export interface ChatClampedRegionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

/** `element`'s own rect with its bottom edge pulled up by `bottomOverlayInsetPx`
 *  - clamped so `bottom` never goes below `top` (an inset larger than the
 *  element's own height collapses the rect to zero height at its top edge,
 *  never a negative-height / bottom-above-top rect). */
export function chatBottomOverlayClampedRect(
  element: HTMLElement,
  bottomOverlayInsetPx: number,
): ChatClampedRegionRect {
  const rect = element.getBoundingClientRect();
  const bottom = Math.max(rect.top, rect.bottom - bottomOverlayInsetPx);
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: bottom - rect.top,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom,
  };
}
