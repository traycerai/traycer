import type { EpicTreeRecord } from "@/lib/epic-selectors";

export interface SwitcherTreeRow {
  readonly record: EpicTreeRecord;
  readonly depth: number;
}

const NO_ROWS: ReadonlyArray<SwitcherTreeRow> = Object.freeze([]);

/**
 * Re-arranges an already-ordered record slice into parent-before-child order,
 * each row carrying the depth it is indented at.
 *
 * Depth is measured over the records PRESENT in the slice, not over the epic's
 * full tree. A record whose parent the facet filters removed is promoted to
 * depth 0 rather than indented under a row that is not on screen, which is what
 * lets this surface keep narrowing by plain membership - no ancestor expansion
 * - now that it draws nesting: a match is still shown, and shown at a depth
 * that describes the list the user is actually looking at.
 *
 * Sibling order is the slice's own order, so whatever the epic's sort decided
 * still decides. Nesting regroups; it never re-sorts.
 *
 * Every input record is emitted exactly once. A record reachable from no root -
 * a parent cycle in a malformed tree - is emitted at depth 0 after the walk
 * rather than dropped, because a row the user cannot see at all is worse than
 * one that lost its indentation.
 */
export function buildSwitcherTreeRows(
  records: ReadonlyArray<EpicTreeRecord>,
): ReadonlyArray<SwitcherTreeRow> {
  if (records.length === 0) return NO_ROWS;
  const present = new Set(records.map((record) => record.id));
  const roots: EpicTreeRecord[] = [];
  const childrenByParent = new Map<string, EpicTreeRecord[]>();
  for (const record of records) {
    const parentId = record.parentId;
    if (parentId === null || parentId === record.id || !present.has(parentId)) {
      roots.push(record);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [record]);
    else siblings.push(record);
  }

  const rows: SwitcherTreeRow[] = [];
  const emitted = new Set<string>();
  function visit(record: EpicTreeRecord, depth: number): void {
    if (emitted.has(record.id)) return;
    emitted.add(record.id);
    rows.push({ record, depth });
    const children = childrenByParent.get(record.id);
    if (children === undefined) return;
    for (const child of children) visit(child, depth + 1);
  }
  for (const root of roots) visit(root, 0);
  for (const record of records) {
    if (emitted.has(record.id)) continue;
    emitted.add(record.id);
    rows.push({ record, depth: 0 });
  }
  return rows;
}
