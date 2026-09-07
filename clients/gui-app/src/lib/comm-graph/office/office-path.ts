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
  const cameFrom = new Int32Array(cellCount).fill(-1);
  const seen = new Uint8Array(cellCount);
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
