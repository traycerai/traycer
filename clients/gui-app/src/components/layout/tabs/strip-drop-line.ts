/** Where a strip drop's insertion line is drawn. */
export type StripDropLine =
  | {
      /** On a row's own edge: inside its block when the row is in one. */
      readonly kind: "row";
      readonly index: number;
      readonly side: "before" | "after";
    }
  | {
      /**
       * On a group's outer edge, outside its block: `index` is the group's row
       * the edge belongs to, for a strip with no block to draw it on.
       */
      readonly kind: "block";
      readonly groupId: string;
      readonly index: number;
      readonly edge: "top" | "bottom";
    };

/**
 * Where the insertion line of a drop at `dropIndex` (before the drawn row at
 * that index, or after the last) is drawn, given each drawn row's group in
 * order, the group the drop lands in and the row being dragged, which leaves
 * its own slot: the drop sits between the rows on either side of it, not
 * against the dragged row. The line is inside a group's block exactly when the
 * drop joins that group, so what the line shows is what the drop does: between
 * two rows of one group it sits between them; at a group's edge it sits on the
 * group's side of the edge when the drop joins it and on the other side when it
 * does not, which at the strip's end or between two blocks is the block's own
 * outer edge. Null when no row can carry it.
 */
export function stripDropLine(
  groupIds: ReadonlyArray<string | null>,
  dropIndex: number | null,
  dropGroupId: string | null,
  sourceIndex: number | null,
): StripDropLine | null {
  if (dropIndex === null) return null;
  const at = (index: number): Beside | null =>
    index >= 0 && index < groupIds.length
      ? { index, groupId: groupIds[index] }
      : null;
  const before = at(
    dropIndex - 1 === sourceIndex ? dropIndex - 2 : dropIndex - 1,
  );
  const after = at(dropIndex === sourceIndex ? dropIndex + 1 : dropIndex);
  if (after === null) {
    return before === null ? null : edgeLine(before, "after", dropGroupId);
  }
  if (before === null || before.groupId === after.groupId) {
    return edgeLine(after, "before", dropGroupId);
  }
  return lineBetween(before, after, dropGroupId);
}

/** A drawn row beside a drop: its index and the group it is in. */
interface Beside {
  readonly index: number;
  readonly groupId: string | null;
}

/**
 * The line against the row beside the drop, at the strip's end or between two
 * rows of one group or of none: on the row's own edge, unless the drop leaves a
 * group that ends there, in which case it is outside that group's block.
 */
function edgeLine(
  beside: Beside,
  side: "before" | "after",
  dropGroupId: string | null,
): StripDropLine {
  if (beside.groupId !== null && beside.groupId !== dropGroupId) {
    return {
      kind: "block",
      groupId: beside.groupId,
      index: beside.index,
      edge: side === "before" ? "top" : "bottom",
    };
  }
  return { kind: "row", index: beside.index, side };
}

/** The line between two rows of different groups, or of a group and none. */
function lineBetween(
  before: Beside,
  after: Beside,
  dropGroupId: string | null,
): StripDropLine | null {
  if (dropGroupId === before.groupId)
    return edgeLine(before, "after", dropGroupId);
  if (dropGroupId === after.groupId)
    return edgeLine(after, "before", dropGroupId);
  return dropGroupId === null ? edgeLine(before, "after", dropGroupId) : null;
}

/** The line's side on the row at `index`, null when it is drawn elsewhere. */
export function rowDropSide(
  line: StripDropLine | null,
  index: number,
): "before" | "after" | null {
  return line?.kind === "row" && line.index === index ? line.side : null;
}

/**
 * `rowDropSide` for a strip with no blocks to carry an outer edge (the top
 * bar): a group's outer edge is the edge of its end tab.
 */
export function tabDropSide(
  line: StripDropLine | null,
  index: number,
): "before" | "after" | null {
  if (line === null || line.index !== index) return null;
  if (line.kind === "row") return line.side;
  return line.edge === "top" ? "before" : "after";
}

/** The outer edge of group `groupId`'s block that carries the line, if any. */
export function blockDropEdge(
  line: StripDropLine | null,
  groupId: string,
): "top" | "bottom" | null {
  return line?.kind === "block" && line.groupId === groupId ? line.edge : null;
}
