/** Dependency-free (no DOM reads) so it stays unit-testable without a jsdom harness. */

export const MINIMAP_TRACK_ITEM_SPACING = 8;
export const MINIMAP_TRACK_END_HIT_PADDING = 12;

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

export interface MinimapTrackMetrics {
  readonly itemCount: number;
  readonly itemSpacing: number;
  readonly endHitPadding: number;
}

/** Natural track height plus endpoint hit padding, clamped by caller-supplied CSS caps (viewport, pane, …) in
 * the order given. */
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

/** Keeps the visible markers on their original evenly spaced track while the hit target extends beyond both
 * ends to make the endpoints easier to hit. */
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
