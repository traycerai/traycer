export type FocusDirection = "up" | "down" | "left" | "right";

export interface TileRect {
  readonly id: string;
  readonly rect: { x: number; y: number; width: number; height: number };
}

/** Edge-based spatial neighbor algorithm. */
const EDGE_SLOP = 1;

interface CandidateScore {
  readonly id: string;
  readonly hasOverlap: boolean;
  readonly primaryGap: number;
  readonly orthoGap: number;
  readonly overlapAmount: number;
}

interface Axes {
  readonly aFarEdge: number;
  readonly cNearEdge: number;
  readonly aOrthoStart: number;
  readonly aOrthoEnd: number;
  readonly cOrthoStart: number;
  readonly cOrthoEnd: number;
}

function axesFor(active: TileRect, cand: TileRect, dir: FocusDirection): Axes {
  const a = active.rect;
  const c = cand.rect;
  if (dir === "right" || dir === "left") {
    return {
      aFarEdge: dir === "right" ? a.x + a.width : a.x,
      cNearEdge: dir === "right" ? c.x : c.x + c.width,
      aOrthoStart: a.y,
      aOrthoEnd: a.y + a.height,
      cOrthoStart: c.y,
      cOrthoEnd: c.y + c.height,
    };
  }
  return {
    aFarEdge: dir === "down" ? a.y + a.height : a.y,
    cNearEdge: dir === "down" ? c.y : c.y + c.height,
    aOrthoStart: a.x,
    aOrthoEnd: a.x + a.width,
    cOrthoStart: c.x,
    cOrthoEnd: c.x + c.width,
  };
}

function scoreCandidate(
  active: TileRect,
  cand: TileRect,
  dir: FocusDirection,
): CandidateScore | null {
  const ax = axesFor(active, cand, dir);
  const forward = dir === "right" || dir === "down";

  // Candidate must start at or past the active tile's far edge.
  const primaryGap = forward
    ? ax.cNearEdge - ax.aFarEdge
    : ax.aFarEdge - ax.cNearEdge;
  if (primaryGap < -EDGE_SLOP) return null;

  const overlap = Math.max(
    0,
    Math.min(ax.aOrthoEnd, ax.cOrthoEnd) -
      Math.max(ax.aOrthoStart, ax.cOrthoStart),
  );
  const hasOverlap = overlap > EDGE_SLOP;
  const orthoGap = hasOverlap
    ? 0
    : Math.max(ax.aOrthoStart - ax.cOrthoEnd, ax.cOrthoStart - ax.aOrthoEnd, 0);

  return {
    id: cand.id,
    hasOverlap,
    primaryGap: Math.max(0, primaryGap),
    orthoGap,
    overlapAmount: overlap,
  };
}

function isBetter(next: CandidateScore, best: CandidateScore): boolean {
  if (next.hasOverlap !== best.hasOverlap) return next.hasOverlap;
  if (next.primaryGap !== best.primaryGap) {
    return next.primaryGap < best.primaryGap;
  }
  if (next.hasOverlap) {
    return next.overlapAmount > best.overlapAmount;
  }
  return next.orthoGap < best.orthoGap;
}

export function findNeighbor(
  active: TileRect,
  candidates: ReadonlyArray<TileRect>,
  dir: FocusDirection,
): string | null {
  let best: CandidateScore | null = null;
  for (const cand of candidates) {
    if (cand.id === active.id) continue;
    const score = scoreCandidate(active, cand, dir);
    if (score === null) continue;
    if (best === null || isBetter(score, best)) best = score;
  }
  return best === null ? null : best.id;
}

/**
 * Read the current tab-group layout from the DOM.
 * Panes are rendered with `data-group-id` by `tab-group-view.tsx`; we query globally within `root`.
 */
export function readTileRects(root: ParentNode): Array<TileRect> {
  const nodes = root.querySelectorAll<HTMLElement>("[data-group-id]");
  const byId = new Map<string, TileRect>();
  nodes.forEach((node) => {
    const id = node.getAttribute("data-group-id");
    if (id === null || id.length === 0) return;
    const r = node.getBoundingClientRect();
    const next = {
      id,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
    const current = byId.get(id);
    if (current === undefined || rectArea(next) > rectArea(current)) {
      byId.set(id, next);
    }
  });
  return Array.from(byId.values());
}

function rectArea(tileRect: TileRect): number {
  return tileRect.rect.width * tileRect.rect.height;
}
