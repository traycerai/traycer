/**
 * Track geometry shared by every edge minimap rail (the chat transcript's turn
 * rail and the artifact editor's heading rail).
 *
 * Deliberately small. The rails share evenly spaced track math. Their item
 * models and measurement lifecycles stay local; their list card is shared by
 * `minimap-list-card.tsx`.
 *
 * Dependency-free (no DOM reads) so it stays unit-testable without a jsdom
 * harness.
 */

export const MINIMAP_TRACK_ITEM_SPACING = 8;
export const MINIMAP_TRACK_END_HIT_PADDING = 12;

/** The collapsed rail may use up to half of its tile's usable height. */
export function resolveMinimapVisibleItemCapacity(
  availableHeight: number,
): number {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return 2;
  const usableTrackHeight =
    availableHeight / 2 - MINIMAP_TRACK_END_HIT_PADDING * 2;
  return Math.max(
    2,
    Math.floor(usableTrackHeight / MINIMAP_TRACK_ITEM_SPACING) + 1,
  );
}

export interface MinimapWindow {
  readonly endIndex: number;
  readonly hasAfter: boolean;
  readonly hasBefore: boolean;
  readonly startIndex: number;
}

export function resolveMinimapWindow(input: {
  readonly currentIndex: number;
  readonly itemCount: number;
  readonly maxItems: number;
}): MinimapWindow {
  if (input.itemCount <= 0 || input.maxItems <= 0) {
    return { startIndex: 0, endIndex: 0, hasBefore: false, hasAfter: false };
  }
  const size = Math.min(input.itemCount, input.maxItems);
  const current = Math.max(
    0,
    Math.min(input.currentIndex, input.itemCount - 1),
  );
  const startIndex = Math.max(
    0,
    Math.min(current - Math.floor(size / 2), input.itemCount - size),
  );
  const endIndex = startIndex + size;
  return {
    startIndex,
    endIndex,
    hasBefore: startIndex > 0,
    hasAfter: endIndex < input.itemCount,
  };
}

export interface MinimapListRevealGeometry {
  /** Row top in scroll-content coordinates (`offsetTop` within the scroller). */
  readonly rowTop: number;
  readonly rowHeight: number;
  /** The scroller's own inline padding, revealed alongside an end row. */
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly scrollTop: number;
  /** The scroller's `clientHeight`. */
  readonly viewHeight: number;
  readonly scrollHeight: number;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Minimal scroll that reveals the active row, in **layout** coordinates — the
 * caller must not feed this `getBoundingClientRect()` values. The card mounts
 * mid `zoom-in-95` entry animation, and a scaled rect shrinks every measured
 * distance by 5%, which left a card opened deep in a long list short of the
 * row it was opening on.
 *
 * The scroller's padding counts as part of an end row, so the first row lands
 * at 0 and the last lands at the very end of the track rather than flush
 * against the card's edge.
 *
 * Returns `null` when the row is already revealed (no write).
 */
export function resolveMinimapListScrollTop(
  geometry: MinimapListRevealGeometry,
): number | null {
  const rowTop = finite(geometry.rowTop);
  const rowHeight = finite(geometry.rowHeight);
  const scrollTop = finite(geometry.scrollTop);
  const viewHeight = finite(geometry.viewHeight);
  const scrollHeight = finite(geometry.scrollHeight);
  if (
    rowTop === null ||
    rowHeight === null ||
    scrollTop === null ||
    viewHeight === null ||
    scrollHeight === null
  ) {
    return null;
  }

  const maxScroll = Math.max(0, scrollHeight - viewHeight);
  if (maxScroll === 0) return null;

  const revealTop = rowTop - Math.max(0, finite(geometry.paddingTop) ?? 0);
  const revealBottom =
    rowTop + rowHeight + Math.max(0, finite(geometry.paddingBottom) ?? 0);

  let next = scrollTop;
  if (revealTop < scrollTop) {
    next = revealTop;
  } else if (revealBottom > scrollTop + viewHeight) {
    next = revealBottom - viewHeight;
  }

  const clamped = Math.max(0, Math.min(next, maxScroll));
  return clamped === scrollTop ? null : clamped;
}

export interface MinimapTrackMetrics {
  readonly itemCount: number;
  /** Gap between adjacent markers on the visible track. */
  readonly itemSpacing: number;
  /** Invisible pointer room above the first marker and below the last. */
  readonly endHitPadding: number;
}

/**
 * Natural track height plus endpoint hit padding, clamped by caller-supplied
 * CSS caps (viewport, pane, …) in the order given.
 */
export function resolveMinimapTrackHeightStyle(
  metrics: MinimapTrackMetrics,
  maxHeights: ReadonlyArray<string>,
): string {
  const naturalTrackHeight = Math.max(
    1,
    (metrics.itemCount - 1) * metrics.itemSpacing,
  );
  const naturalHeight = naturalTrackHeight + metrics.endHitPadding * 2;
  return `min(${[`${naturalHeight}px`, ...maxHeights].join(", ")})`;
}

export function resolveMinimapTrackTopPercent(
  index: number,
  itemCount: number,
): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

/**
 * Keeps the visible markers on their original evenly spaced track while the
 * hit target extends beyond both ends to make the endpoints easier to hit.
 */
export function resolveMinimapTrackTopStyle(
  index: number,
  itemCount: number,
  endHitPadding: number,
): string {
  const percent = resolveMinimapTrackTopPercent(index, itemCount);
  const pixelOffset = endHitPadding * (1 - (percent * 2) / 100);
  if (pixelOffset === 0) return `${percent}%`;
  const operator = pixelOffset > 0 ? "+" : "-";
  return `calc(${percent}% ${operator} ${Math.abs(pixelOffset)}px)`;
}
