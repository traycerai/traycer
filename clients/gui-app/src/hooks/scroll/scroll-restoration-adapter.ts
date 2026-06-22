import type { TileScrollAnchor } from "@/stores/epics/canvas/tile-scroll-anchor-store";

export type { TileScrollAnchor };

/**
 * Outcome of an `applyAnchor` attempt, which drives the orchestrator's rAF
 * retry loop:
 * - `"applied"` - position restored; stop.
 * - `"retry"` - content not laid out yet (async load pending); re-attempt on a
 *   later frame.
 * - `"defend"` - position applied, but an external mechanism (e.g. Virtuoso's
 *   stick-to-bottom autoscroll on a 0 -> full resize) may overwrite it on a
 *   later frame; keep re-asserting across the bounded retry window.
 * - `"gave-up"` - abandon restoration for this anchor.
 *
 * `"retry"` and `"defend"` both continue the loop; they differ only in intent
 * (not-ready-yet vs applied-but-contested), so the meaning stays legible.
 */
export type ApplyAnchorResult = "applied" | "retry" | "defend" | "gave-up";

/**
 * A tile-kind-specific bridge between the generic `useScrollRestoration`
 * orchestrator and a concrete scroll surface. Both methods run only inside
 * layout effects / event handlers - never during render.
 *
 * `captureAnchor` must read from a ref the tile keeps fresh on every scroll,
 * NOT from a live DOM read at call time: the orchestrator commits on the
 * `visible -> hidden` transition, by which point the container is already
 * `display:none` and reads a zeroed `scrollTop`.
 */
export interface ScrollRestorationAdapter {
  /**
   * Snapshot the surface's current scroll position into a storable anchor, or
   * `null` when there is nothing worth saving yet (never scrolled, or the
   * surface is concealed and reads a zero-size box).
   */
  readonly captureAnchor: () => TileScrollAnchor | null;
  /**
   * Apply a previously saved anchor. `"retry"` means the content is not laid
   * out yet (async load still pending) and the caller should re-attempt on a
   * later frame; `"gave-up"` abandons restoration for this anchor.
   */
  readonly applyAnchor: (anchor: TileScrollAnchor) => ApplyAnchorResult;
}
