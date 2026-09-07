import type { TileScrollAnchor } from "@/hooks/scroll/scroll-anchor-types";
import type { ReadingPositionSurfaceKind } from "@/lib/reading-position";

export type { TileScrollAnchor };

/**
 * `applyAnchor` outcome: `"applied"` stop; `"retry"` not laid out yet; `"defend"` applied but may be overwritten; `"gave-up"` abandon.
 */
export type ApplyAnchorResult = "applied" | "retry" | "defend" | "gave-up";

/**
 * `captureAnchor` reads a scroll-fresh ref, not the DOM at call time. On `visible -> hidden` the container is already `display:none` and `scrollTop` is zero.
 */
export interface ScrollRestorationAdapter {
  readonly surfaceKind: ReadingPositionSurfaceKind;
  /** Snapshot the surface's current scroll position into a storable anchor, or `null` when there is nothing worth saving yet (never scrolled, or the surface is concealed and reads a zero-size box). */
  readonly captureAnchor: () => TileScrollAnchor | null;
  /** `"retry"` means the content is not laid out yet (async load still pending) and the caller should re-attempt on a later frame; `"gave-up"` abandons restoration for this anchor. */
  readonly applyAnchor: (anchor: TileScrollAnchor) => ApplyAnchorResult;
}
