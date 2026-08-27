/**
 * Pane-body drop resolution with a NEUTRAL CORRIDOR.
 *
 * Supersedes the nearest-edge fallback in `pane-drop-geometry.ts`, which
 * resolved every point inside a pane to one of five positions - so ~84% of a
 * pane's area committed a split on release and no region was neutral anywhere.
 * A tile crossing a pane to reach another group therefore travelled a corridor
 * that was positively split-armed the whole way.
 *
 * Here the pane has three kinds of region:
 *
 *   edge bands    a directional split, previewed
 *   centre box    move-into-pane, previewed
 *   corridor      INERT - no preview, no arm, no commit
 *
 * **Intentional shipped-gesture change** (planner-assented): a release in the
 * former fallback region no longer splits the pane; it cancels and returns the
 * tile to its origin.
 *
 * Targets are absolute with a proportional floor, deliberately mirroring the
 * header's `min(16, 0.25 * width)` merge band. Pure ratios were the first
 * proposal and they fail for a reason Sprint 01 already settled: a precision
 * gesture's demanded precision must not vary with the size of the thing it is
 * aimed at. Under ratios an edge band is 35.9px on the narrowest pane and 107px
 * on a wide one - the same gesture three times harder - and within a single pane
 * an aspect ratio makes "split left" a three-times harder target than "split
 * top". The clamp is inactive at the 239px pane floor, so the narrowest case is
 * unchanged, and above ~320px targets pin at a constant size while the corridor
 * absorbs all the growth. Slack belongs in the region that should be easy to sit
 * in, not in the target.
 */
import type { EdgeDropPosition } from "@/components/epic-canvas/dnd/dnd";

/** Widest an edge band may become, however large the pane. */
export const PANE_EDGE_BAND_MAX_PX = 48;

/** Share of a dimension an edge band takes before the clamp bites. */
export const PANE_EDGE_BAND_RATIO = 0.15;

/** Widest the centre box may become. */
export const PANE_CENTRE_BOX_MAX_PX = 140;

/** Share of a dimension the centre box takes before the clamp bites. */
export const PANE_CENTRE_BOX_RATIO = 0.28;

/**
 * Smallest pane the layout permits, measured rather than assumed: the divider
 * clamps here and widens again, so it is a real floor and not a failed drag.
 * At this size the clamp is inactive and the corridor is still ~50px per side.
 */
export const MIN_PANE_DIMENSION_PX = 239;

export type PaneCorridorPosition = EdgeDropPosition | "center" | "corridor";

export function paneEdgeBandPx(dimension: number): number {
  return Math.min(PANE_EDGE_BAND_MAX_PX, dimension * PANE_EDGE_BAND_RATIO);
}

export function paneCentreBoxPx(dimension: number): number {
  return Math.min(PANE_CENTRE_BOX_MAX_PX, dimension * PANE_CENTRE_BOX_RATIO);
}

export interface PaneRelativePoint {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

/**
 * How deeply the point sits inside an edge band, as a fraction of that band's
 * width: 0 at the band's inner boundary, 1 at the pane edge. Negative means
 * outside the band. Expressed as a fraction precisely so the corner rule can
 * compare a horizontal band against a vertical one that may be a different
 * size on a non-square pane.
 */
function bandPenetration(distanceFromEdge: number, bandPx: number): number {
  if (bandPx <= 0) return -1;
  return (bandPx - distanceFromEdge) / bandPx;
}

/**
 * Resolve a point inside a pane body.
 *
 * Returns `"corridor"` for the inert region. Callers must treat that as "no
 * target": no preview, no dwell arming, and a release that commits nothing.
 * Preview and commit must consult the same result, or the gesture can commit
 * something it never showed.
 */
export function resolvePaneCorridorPosition(
  point: PaneRelativePoint,
): PaneCorridorPosition {
  const { width, height, x, y } = point;
  if (width <= 0 || height <= 0) return "corridor";

  const horizontalBand = paneEdgeBandPx(width);
  const verticalBand = paneEdgeBandPx(height);
  const left = bandPenetration(x, horizontalBand);
  const right = bandPenetration(width - x, horizontalBand);
  const top = bandPenetration(y, verticalBand);
  const bottom = bandPenetration(height - y, verticalBand);

  // Corner rule: a point can sit inside a horizontal AND a vertical band at
  // once, and removing the nearest-edge fallback removed the resolution but not
  // the overlap. Deeper fractional penetration wins; an exact tie resolves
  // horizontal. Deterministic and previewable - lockstep needs exactly one
  // outcome, not whichever branch happens to run first.
  const candidates: ReadonlyArray<{
    readonly position: EdgeDropPosition;
    readonly depth: number;
    readonly horizontal: boolean;
  }> = [
    { position: "left", depth: left, horizontal: true },
    { position: "right", depth: right, horizontal: true },
    { position: "top", depth: top, horizontal: false },
    { position: "bottom", depth: bottom, horizontal: false },
  ];
  let best: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (candidate.depth < 0) continue;
    if (best === null || candidate.depth > best.depth) {
      best = candidate;
      continue;
    }
    if (
      candidate.depth === best.depth &&
      candidate.horizontal &&
      !best.horizontal
    ) {
      best = candidate;
    }
  }
  if (best !== null) return best.position;

  const centreWidth = paneCentreBoxPx(width);
  const centreHeight = paneCentreBoxPx(height);
  const insideCentre =
    Math.abs(x - width / 2) <= centreWidth / 2 &&
    Math.abs(y - height / 2) <= centreHeight / 2;
  return insideCentre ? "center" : "corridor";
}

/** Whether a resolved position restructures anything on release. */
export function paneCorridorCommits(position: PaneCorridorPosition): boolean {
  return position !== "corridor";
}
