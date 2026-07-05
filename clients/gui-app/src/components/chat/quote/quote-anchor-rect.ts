/**
 * The first client rect of a range is its first selected line; the whole-
 * selection bounding box is the fallback when the range exposes no line rects.
 * Used only when no transcript viewport is available to clip against.
 */
export function firstLineRect(range: Range): DOMRect {
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[0] : range.getBoundingClientRect();
}

/**
 * The first selected line that is still visible inside `viewport` (the
 * transcript scroll container's rect), or `null` when the whole selection has
 * scrolled out of view. When the selection start scrolls off the top, this
 * becomes the topmost still-visible line, so the popover "rides" the visible
 * portion instead of floating detached over app chrome.
 */
export function firstVisibleLineRect(
  range: Range,
  viewport: DOMRect,
): DOMRect | null {
  return (
    Array.from(range.getClientRects()).find((rect) =>
      rectsIntersect(rect, viewport),
    ) ?? null
  );
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}
