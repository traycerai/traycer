/**
 * Pure ratios were the first proposal and they fail for a reason Sprint 01 already settled: a precision gesture's demanded precision must not vary with the size of the thing it is aimed at.
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
 * Smallest pane the layout permits, measured rather than assumed: the divider clamps here and widens again, so it is a real floor and not a failed drag.
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
 * How deeply the point sits inside an edge band, as a fraction of that band's width: 0 at the band's inner boundary, 1 at the pane edge.
 * Negative means outside the band.
 */
function bandPenetration(distanceFromEdge: number, bandPx: number): number {
  if (bandPx <= 0) return -1;
  return (bandPx - distanceFromEdge) / bandPx;
}

/**
 * Callers must treat that as "no target": no preview, no dwell arming, and a release that commits nothing.
 * Preview and commit must consult the same result, or the gesture can commit something it never showed.
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

  // Corner rule: a point can sit inside a horizontal AND a vertical band at once, and removing the nearest-edge fallback removed the resolution but not the overlap.
  // Deeper fractional penetration wins; an exact tie resolves horizontal.
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

export function paneCorridorCommits(position: PaneCorridorPosition): boolean {
  return position !== "corridor";
}
