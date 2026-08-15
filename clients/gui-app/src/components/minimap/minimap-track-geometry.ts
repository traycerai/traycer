/**
 * Track geometry shared by every edge minimap rail (the chat transcript's turn
 * rail and the artifact editor's heading rail).
 *
 * Deliberately small. The two rails share how an evenly spaced track is laid
 * out and how a pointer Y maps back to an item - and nothing else. Their item
 * models, card bodies, active-item semantics and measurement lifecycles differ,
 * so no behaviour lives here; see the reuse-boundary review in the epic's
 * `artifact-heading-minimap-review` artifact for why a common shell was
 * rejected.
 *
 * Dependency-free (no DOM reads) so it stays unit-testable without a jsdom
 * harness.
 */

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

export function resolveMinimapTrackIndexFromPointer(input: {
  readonly itemCount: number;
  readonly endHitPadding: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const endPadding = Math.min(
    input.endHitPadding,
    Math.max(0, (input.railHeight - 1) / 2),
  );
  const trackTop = input.railTop + endPadding;
  const trackHeight = input.railHeight - endPadding * 2;
  const progress = Math.max(
    0,
    Math.min(1, (input.pointerY - trackTop) / trackHeight),
  );
  return Math.max(
    0,
    Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))),
  );
}
