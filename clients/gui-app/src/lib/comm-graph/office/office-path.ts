/**
 * Walking routes across the office floor.
 *
 * Breadth-first over 4-neighbours, which on a grid of uniform-cost tiles is
 * already shortest-path - there is nothing for A* to improve on at this size,
 * and BFS has no heuristic to get wrong.
 *
 * THE GOAL TILE IS ALWAYS ENTERABLE, even though `walkable` says otherwise.
 * That is the whole reason chairs are marked blocked: a chair belongs to one
 * agent, so it must repel everyone routing PAST it while still being reachable
 * by the one agent routing TO it. Encoding the exception here rather than
 * handing the layout a per-agent grid keeps the floor plan a single shared
 * value.
 */
import type {
  OfficeLayout,
  OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";

/** Deterministic expansion order, so two runs return the identical route. */
const NEIGHBOUR_OFFSETS: ReadonlyArray<OfficeTilePos> = [
  { col: 0, row: -1 },
  { col: 0, row: 1 },
  { col: -1, row: 0 },
  { col: 1, row: 0 },
];

/**
 * The search's two working grids, kept between calls.
 *
 * A search used to allocate an `Int32Array` and a `Uint8Array` the size of the
 * whole floor EVERY TIME it ran, and a sync of a thousand-agent office runs
 * dozens of them: at the review's largest plan that is two arrays of 103,896
 * cells per walk, handed straight to the collector. They are grown to the
 * largest grid ever searched and reused, which costs one allocation per office
 * that is bigger than every office before it.
 *
 * Safe to share because a search is synchronous and calls nothing that could
 * re-enter it, and because each one resets what it reads: `seen` is cleared
 * over the cells this grid uses, and `cameFrom` is only ever read at cells
 * this search wrote (the walk back from the goal follows the links it laid).
 */
let scratchCameFrom = new Int32Array(0);
let scratchSeen = new Uint8Array(0);
let scratchGrowths = 0;

/** What the scratch holds and how often it has had to grow. For the budgets. */
export interface OfficePathScratchStats {
  readonly capacity: number;
  readonly growths: number;
}

export function officePathScratch(): OfficePathScratchStats {
  return { capacity: scratchCameFrom.length, growths: scratchGrowths };
}

/**
 * The scratch, big enough for this grid and cleared where this grid reads it.
 *
 * Growth is to the exact cell count rather than a doubling: an office's grid
 * is the same size for as long as its plan is, so the sequence of sizes a tab
 * sees is a handful of plans, not a stream.
 */
function takeScratch(cellCount: number): void {
  if (scratchCameFrom.length < cellCount) {
    scratchCameFrom = new Int32Array(cellCount);
    scratchSeen = new Uint8Array(cellCount);
    scratchGrowths += 1;
    return;
  }
  scratchSeen.fill(0, 0, cellCount);
}

function inBounds(layout: OfficeLayout, tile: OfficeTilePos): boolean {
  return (
    Number.isInteger(tile.col) &&
    Number.isInteger(tile.row) &&
    tile.col >= 0 &&
    tile.row >= 0 &&
    tile.col < layout.cols &&
    tile.row < layout.rows
  );
}

/**
 * The tiles to step through, `from` EXCLUSIVE and `to` INCLUSIVE, or `null`
 * when no route exists. An empty array means the walker is already there.
 *
 * `from` is not required to be walkable: a character standing on its own chair
 * is the normal case for leaving one.
 */
export function findOfficePath(
  layout: OfficeLayout,
  from: OfficeTilePos,
  to: OfficeTilePos,
): ReadonlyArray<OfficeTilePos> | null {
  if (!inBounds(layout, from) || !inBounds(layout, to)) return null;
  if (from.col === to.col && from.row === to.row) return [];

  const cellCount = layout.cols * layout.rows;
  const startIndex = from.row * layout.cols + from.col;
  const goalIndex = to.row * layout.cols + to.col;
  takeScratch(cellCount);
  const cameFrom = scratchCameFrom;
  const seen = scratchSeen;
  seen[startIndex] = 1;

  const queue: number[] = [startIndex];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const col = current % layout.cols;
    const row = (current - col) / layout.cols;
    for (const offset of NEIGHBOUR_OFFSETS) {
      const nextCol = col + offset.col;
      const nextRow = row + offset.row;
      if (nextCol < 0 || nextRow < 0) continue;
      if (nextCol >= layout.cols || nextRow >= layout.rows) continue;
      const next = nextRow * layout.cols + nextCol;
      if (seen[next] === 1) continue;
      if (next !== goalIndex && !layout.walkable[nextRow][nextCol]) continue;
      seen[next] = 1;
      cameFrom[next] = current;
      if (next === goalIndex) {
        return reconstruct(layout, cameFrom, startIndex, goalIndex);
      }
      queue.push(next);
    }
  }
  return null;
}

function reconstruct(
  layout: OfficeLayout,
  cameFrom: Int32Array,
  startIndex: number,
  goalIndex: number,
): ReadonlyArray<OfficeTilePos> {
  const reversed: OfficeTilePos[] = [];
  let cursor = goalIndex;
  while (cursor !== startIndex && cursor !== -1) {
    const col = cursor % layout.cols;
    reversed.push({ col, row: (cursor - col) / layout.cols });
    cursor = cameFrom[cursor];
  }
  reversed.reverse();
  return reversed;
}
