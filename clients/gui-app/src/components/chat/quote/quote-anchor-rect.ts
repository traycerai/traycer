/**
 * The first client rect of a range is its first selected line; the whole-
 * selection bounding box is the fallback when the range exposes no line rects.
 * Used only when no transcript viewport is available to clip against.
 */
export function firstLineRect(range: Range): DOMRect {
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[0] : range.getBoundingClientRect();
}

/** The 4 edges `rectsIntersect` needs - real `DOMRect`s satisfy this
 *  structurally, as does a synthesized bottom-overlay-clamped viewport rect
 *  (see `chatBottomOverlayClampedRect`) that isn't a real `DOMRect` instance. */
export interface QuoteViewportEdges {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The first selected line that is still visible inside `viewport` (the
 * transcript scroll container's rect, clamped to exclude the composer/queue
 * dock overlaying its bottom), or `null` when the whole selection has
 * scrolled out of view. When the selection start scrolls off the top, this
 * becomes the topmost still-visible line, so the popover "rides" the visible
 * portion instead of floating detached over app chrome.
 */
export function firstVisibleLineRect(
  range: Range,
  viewport: QuoteViewportEdges,
): DOMRect | null {
  return (
    Array.from(range.getClientRects()).find((rect) =>
      rectsIntersect(rect, viewport),
    ) ?? null
  );
}

function rectsIntersect(a: DOMRect, b: QuoteViewportEdges): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}
