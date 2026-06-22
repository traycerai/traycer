/**
 * Sidebar sort model shared by the chat and artifact panels.
 *
 * Sort is a presentation concern: the projector emits one canonical order
 * (most-recent-activity-first, see `compareNodes` in
 * `projection-helpers.ts`, which reuses `DEFAULT_SORT_MODE` here), and the
 * sidebars re-sort the already-filtered ids when the user picks a different
 * mode. The comparator is defined once, over a structural `SortableNode`,
 * so it drives roots and nested children for both panels without coupling
 * to the store's `TreeNode` shape.
 */

export const SORT_FIELD = {
  Updated: "updated",
  Created: "created",
  Name: "name",
} as const;
export type SortField = (typeof SORT_FIELD)[keyof typeof SORT_FIELD];

export const SORT_DIRECTION = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type SortDirection =
  (typeof SORT_DIRECTION)[keyof typeof SORT_DIRECTION];

export interface SortMode {
  readonly field: SortField;
  readonly direction: SortDirection;
}

// Most recent activity on top. Mirrored by the projector's `compareNodes`
// default so the no-op (default) case needs no re-sort downstream.
export const DEFAULT_SORT_MODE: SortMode = Object.freeze({
  field: SORT_FIELD.Updated,
  direction: SORT_DIRECTION.Desc,
});

export const CHAT_SORT_FIELDS: ReadonlyArray<SortField> = [
  SORT_FIELD.Updated,
  SORT_FIELD.Created,
  SORT_FIELD.Name,
];
export const ARTIFACT_SORT_FIELDS: ReadonlyArray<SortField> = CHAT_SORT_FIELDS;

export const SORT_FIELD_LABELS: Readonly<Record<SortField, string>> = {
  [SORT_FIELD.Updated]: "Last updated",
  [SORT_FIELD.Created]: "Date created",
  [SORT_FIELD.Name]: "Name",
};

export function isSortField(value: unknown): value is SortField {
  return (
    value === SORT_FIELD.Updated ||
    value === SORT_FIELD.Created ||
    value === SORT_FIELD.Name
  );
}

export function isSortDirection(value: unknown): value is SortDirection {
  return value === SORT_DIRECTION.Asc || value === SORT_DIRECTION.Desc;
}

export function isDefaultSort(mode: SortMode): boolean {
  return (
    mode.field === DEFAULT_SORT_MODE.field &&
    mode.direction === DEFAULT_SORT_MODE.direction
  );
}

/** Minimal shape `makeNodeComparator` reads; `TreeNode` satisfies it. */
export interface SortableNode {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type NodeComparator = (a: SortableNode, b: SortableNode) => number;

function compareByField(
  a: SortableNode,
  b: SortableNode,
  field: SortField,
): number {
  switch (field) {
    case SORT_FIELD.Updated:
      return a.updatedAt - b.updatedAt;
    case SORT_FIELD.Created:
      return a.createdAt - b.createdAt;
    case SORT_FIELD.Name:
      return a.title.localeCompare(b.title);
  }
}

/**
 * Comparator for `mode`. Direction flips the primary key; the `id`
 * tie-break stays ascending regardless so equal-key ordering is stable and
 * deterministic across renders.
 */
export function makeNodeComparator(mode: SortMode): NodeComparator {
  const sign = mode.direction === SORT_DIRECTION.Asc ? 1 : -1;
  return (a, b) => {
    const primary = compareByField(a, b, mode.field);
    if (primary !== 0) return sign * primary;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };
}

/**
 * Reorder `ids` by `comparator`, resolving each id through `nodeById`. A
 * `null` comparator (the default-sort case) returns the input array
 * unchanged so memoized callers keep referential identity and the
 * projector's own ordering stands.
 */
export function sortNodeIds(
  ids: readonly string[],
  nodeById: Readonly<Record<string, SortableNode>>,
  comparator: NodeComparator | null,
): readonly string[] {
  // Callers pass ids drawn from the same tree as `nodeById` (root ids /
  // filtered child ids), so every id resolves to a node.
  if (comparator === null || ids.length < 2) return ids;
  return [...ids].sort((a, b) => comparator(nodeById[a], nodeById[b]));
}
