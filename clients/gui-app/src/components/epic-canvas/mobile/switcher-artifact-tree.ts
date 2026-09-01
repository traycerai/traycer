import type { EpicTreeRecord } from "@/lib/epic-selectors";

export interface SwitcherTreeNode {
  readonly record: EpicTreeRecord;
  readonly children: ReadonlyArray<SwitcherTreeNode>;
}

const NO_NODES: ReadonlyArray<SwitcherTreeNode> = Object.freeze([]);

/**
 * Re-arranges an already-ordered record slice into the nested shape the list
 * renders, so depth is the structure itself rather than a number travelling
 * beside it - the same choice the desktop sidebar's tree makes, and what lets
 * both surfaces expose their nesting through `role="group"` rather than
 * asserting it with an attribute.
 *
 * Depth is measured over the records PRESENT in the slice, not over the epic's
 * full tree. A record whose parent the facet filters removed is returned as a
 * root rather than nested under a row that is not on screen, which is what lets
 * this surface keep narrowing by plain membership - no ancestor expansion -
 * now that it draws nesting: a match is still shown, and shown at a depth that
 * describes the list the user is actually looking at.
 *
 * Sibling order is the slice's own order, so whatever the epic's sort decided
 * still decides. Nesting regroups; it never re-sorts.
 *
 * Every input record appears exactly once. A record no root reaches - a parent
 * cycle in a malformed tree - is adopted as a root after the walk rather than
 * dropped, because a row the user cannot see at all is worse than one whose
 * position is arbitrary.
 */
export function buildSwitcherArtifactTree(
  records: ReadonlyArray<EpicTreeRecord>,
): ReadonlyArray<SwitcherTreeNode> {
  if (records.length === 0) return NO_NODES;
  const present = new Set(records.map((record) => record.id));
  const rootRecords: EpicTreeRecord[] = [];
  const childrenByParent = new Map<string, EpicTreeRecord[]>();
  for (const record of records) {
    const parentId = record.parentId;
    if (parentId === null || parentId === record.id || !present.has(parentId)) {
      rootRecords.push(record);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [record]);
    else siblings.push(record);
  }

  const emitted = new Set<string>();
  function build(record: EpicTreeRecord): SwitcherTreeNode {
    // Marked before the descent, so a cycle terminates at the record that
    // opened it instead of recurring through its own descendants forever.
    emitted.add(record.id);
    const children = childrenByParent.get(record.id);
    if (children === undefined) return { record, children: NO_NODES };
    return {
      record,
      children: children
        .filter((child) => !emitted.has(child.id))
        .map((child) => build(child)),
    };
  }

  const roots = rootRecords.map((record) => build(record));
  const stranded = records.flatMap((record) =>
    emitted.has(record.id) ? [] : [build(record)],
  );
  return stranded.length === 0 ? roots : [...roots, ...stranded];
}
