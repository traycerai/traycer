/**
 * Content-agnostic N-ary split tree for the epic canvas.
 *
 * The tree knows NOTHING about tile refs - panes hold opaque tab
 * `instanceId` strings; the payloads live in `EpicCanvasState.tilesByInstanceId`
 * (see `types.ts`). Group sizes are likewise decoupled into a
 * `sizesByGroupId` map (normalized fractions per group, summing to ~1) so a
 * ratio drag never produces a new tree object.
 *
 * Every op is pure and structurally shared: only the nodes on the path from
 * the root to the touched node are copied; untouched sibling subtrees keep
 * reference identity. Renderers rely on this for render short-circuiting,
 * and tests assert it.
 */
import { MAX_TREE_DEPTH, MIN_SPLIT_SIZE } from "./tile-tree-constants";

export type SplitDirection = "horizontal" | "vertical";

/** Edge drop positions; "center" routes to move-into-pane, not split. */
export type EdgeDropPosition = "left" | "right" | "top" | "bottom";

/**
 * Leaf of the split tree - a VS Code-style tab group. `tabInstanceIds` are
 * per-tab identities (NOT content ids); `activeTabId` / `previewTabId`
 * reference entries of `tabInstanceIds`. An empty pane is valid only at the
 * root, where it acts as a drop zone.
 */
export interface TilePane {
  readonly kind: "pane";
  readonly id: string;
  readonly tabInstanceIds: ReadonlyArray<string>;
  readonly activeTabId: string | null;
  readonly previewTabId: string | null;
  readonly activationHistory: ReadonlyArray<string>;
}

/**
 * N-ary split container. `direction: "horizontal"` lays children out in a
 * row (left→right); `"vertical"` in a column (top→bottom). Children count
 * is always >= 2 after normalization - a single-child group is promoted.
 * Sizes are NOT stored here; see `sizesByGroupId`.
 */
export interface TileGroup {
  readonly kind: "group";
  readonly id: string;
  readonly direction: SplitDirection;
  readonly children: ReadonlyArray<TileLayoutNode>;
}

export type TileLayoutNode = TilePane | TileGroup;

/**
 * Normalized child fractions per group id. Kept out of the tree on purpose.
 * Values are `| undefined` per the codebase convention for Records with
 * missing keys (no `noUncheckedIndexedAccess`).
 */
export type SizesByGroupId = Readonly<
  Record<string, ReadonlyArray<number> | undefined>
>;

export type NodePath = ReadonlyArray<number>;

export interface TileTreeState {
  readonly root: TileLayoutNode;
  readonly sizesByGroupId: SizesByGroupId;
}

// ---------------------------------------------------------------------------
// Sizes math (ported from the reference implementation)
// ---------------------------------------------------------------------------

/**
 * Coerce `sizes` to exactly `count` positive fractions summing to 1. Invalid
 * or missing entries weight as 1 before normalization.
 */
export function normalizeSizes(
  sizes: ReadonlyArray<number>,
  count: number,
): ReadonlyArray<number> {
  if (count <= 0) return [];
  const raw = sizes.slice(0, count);
  while (raw.length < count) raw.push(1);
  const sanitized = raw.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 1,
  );
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return Array.from({ length: count }, () => 1 / count);
  }
  return sanitized.map((value) => value / total);
}

/**
 * Normalize and then enforce {@link MIN_SPLIT_SIZE} per entry, redistributing
 * the locked remainder proportionally across the entries still above the
 * floor. Falls back to even sizes when the floor cannot be satisfied.
 */
export function clampNormalizedSizes(
  sizes: ReadonlyArray<number>,
): ReadonlyArray<number> {
  if (sizes.length === 0) return [];
  const normalized = normalizeSizes(sizes, sizes.length);
  if (sizes.length === 1) return [1];
  if (sizes.length * MIN_SPLIT_SIZE > 1) {
    return Array.from({ length: sizes.length }, () => 1 / sizes.length);
  }

  const nextSizes = Array.from({ length: sizes.length }, () => 0);
  const unlocked = new Set(normalized.map((_, index) => index));
  let remainingTotal = 1;

  while (unlocked.size > 0) {
    let unlockedWeight = 0;
    for (const index of unlocked) {
      unlockedWeight += normalized[index] ?? 0;
    }

    if (unlockedWeight <= 0) {
      const evenShare = remainingTotal / unlocked.size;
      for (const index of unlocked) {
        nextSizes[index] = evenShare;
      }
      break;
    }

    const nextLocked = [...unlocked].filter(
      (index) =>
        ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal <
        MIN_SPLIT_SIZE,
    );

    if (nextLocked.length === 0) {
      for (const index of unlocked) {
        nextSizes[index] =
          ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal;
      }
      break;
    }

    for (const index of nextLocked) {
      nextSizes[index] = MIN_SPLIT_SIZE;
      unlocked.delete(index);
      remainingTotal -= MIN_SPLIT_SIZE;
    }
  }

  return normalizeSizes(nextSizes, nextSizes.length);
}

/** Even fractions for `count` children (double-click-to-equalize, defaults). */
export function evenSizes(count: number): ReadonlyArray<number> {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

/** Sizes for `group`, falling back to even fractions when absent/mismatched. */
export function sizesForGroup(
  sizesByGroupId: SizesByGroupId,
  group: TileGroup,
): ReadonlyArray<number> {
  const stored = sizesByGroupId[group.id];
  if (stored !== undefined && stored.length === group.children.length) {
    return stored;
  }
  return evenSizes(group.children.length);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function findPanePath(
  node: TileLayoutNode,
  paneId: string,
): NodePath | null {
  if (node.kind === "pane") {
    return node.id === paneId ? [] : null;
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const childPath = findPanePath(node.children[index], paneId);
    if (childPath !== null) return [index, ...childPath];
  }
  return null;
}

export function findPaneById(
  root: TileLayoutNode | null,
  paneId: string,
): TilePane | null {
  if (root === null) return null;
  if (root.kind === "pane") {
    return root.id === paneId ? root : null;
  }
  for (const child of root.children) {
    const pane = findPaneById(child, paneId);
    if (pane !== null) return pane;
  }
  return null;
}

export function getNodeAtPath(
  root: TileLayoutNode,
  path: NodePath,
): TileLayoutNode {
  let current = root;
  for (const index of path) {
    if (current.kind !== "group") {
      throw new Error("Invalid tile-tree path: expected group.");
    }
    current = current.children[index];
  }
  return current;
}

export function collectPanes(
  root: TileLayoutNode | null,
): ReadonlyArray<TilePane> {
  if (root === null) return [];
  if (root.kind === "pane") return [root];
  return root.children.flatMap((child) => collectPanes(child));
}

export function firstPaneId(root: TileLayoutNode): string {
  if (root.kind === "pane") return root.id;
  return firstPaneId(root.children[0]);
}

/** Depth of the tree; a bare pane is depth 1. */
export function getTreeDepth(node: TileLayoutNode): number {
  if (node.kind === "pane") return 1;
  return 1 + Math.max(...node.children.map((child) => getTreeDepth(child)));
}

/** All group ids present in the tree (for sizes garbage collection). */
export function collectGroupIds(
  root: TileLayoutNode | null,
): ReadonlySet<string> {
  const out = new Set<string>();
  function walk(node: TileLayoutNode): void {
    if (node.kind !== "group") return;
    out.add(node.id);
    node.children.forEach(walk);
  }
  if (root !== null) walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Structural mutation
// ---------------------------------------------------------------------------

/**
 * Replace the node at `path` via `updater`. Returns the same root reference
 * when the updater returns the node unchanged - callers can identity-compare
 * for cheap no-op detection. Only the path to the touched node is copied.
 */
export function replaceNodeAtPath(
  root: TileLayoutNode,
  path: NodePath,
  updater: (node: TileLayoutNode) => TileLayoutNode,
): TileLayoutNode {
  if (path.length === 0) return updater(root);
  if (root.kind !== "group") {
    throw new Error("Invalid tile-tree path: expected group.");
  }
  const [index, ...rest] = path;
  const child = root.children[index];
  const nextChild = replaceNodeAtPath(child, rest, updater);
  if (nextChild === child) return root;
  return {
    ...root,
    children: root.children.map((entry, entryIndex) =>
      entryIndex === index ? nextChild : entry,
    ),
  };
}

/** Replace pane `paneId` via `updater`; same-reference no-op semantics. */
export function replacePane(
  root: TileLayoutNode,
  paneId: string,
  updater: (pane: TilePane) => TilePane,
): TileLayoutNode {
  const path = findPanePath(root, paneId);
  if (path === null) return root;
  return replaceNodeAtPath(root, path, (node) =>
    node.kind === "pane" ? updater(node) : node,
  );
}

/** Drop sizes entries whose group no longer exists in the tree. */
export function pruneSizes(
  root: TileLayoutNode | null,
  sizesByGroupId: SizesByGroupId,
): SizesByGroupId {
  const live = collectGroupIds(root);
  const entries = Object.entries(sizesByGroupId);
  if (entries.every(([groupId]) => live.has(groupId))) return sizesByGroupId;
  return Object.fromEntries(entries.filter(([groupId]) => live.has(groupId)));
}

export interface RemovePaneResult {
  readonly root: TileLayoutNode | null;
  readonly sizesByGroupId: SizesByGroupId;
}

/**
 * Remove pane `paneId` from the tree. The parent group's sizes entry shrinks
 * with it; a parent left with a single child is dissolved (the child is
 * promoted into its slot). Removing the root pane yields `root: null`.
 * Returns `null` when the pane does not exist.
 */
export function removePaneFromTree(
  state: TileTreeState,
  paneId: string,
): RemovePaneResult | null {
  const path = findPanePath(state.root, paneId);
  if (path === null) return null;

  if (path.length === 0) {
    return {
      root: null,
      sizesByGroupId: pruneSizes(null, state.sizesByGroupId),
    };
  }

  const parentPath = path.slice(0, -1);
  const removeIndex = path[path.length - 1];
  const parentNode = getNodeAtPath(state.root, parentPath);
  if (parentNode.kind !== "group") {
    throw new Error("Invalid tile-tree path: expected parent group.");
  }

  const remaining = parentNode.children.filter(
    (_, index) => index !== removeIndex,
  );
  const parentSizes = sizesForGroup(state.sizesByGroupId, parentNode);

  if (remaining.length === 1) {
    // Dissolve the parent group; the surviving child takes its slot.
    const nextRoot = replaceNodeAtPath(
      state.root,
      parentPath,
      () => remaining[0],
    );
    return {
      root: nextRoot,
      sizesByGroupId: pruneSizes(nextRoot, state.sizesByGroupId),
    };
  }

  const nextParent: TileGroup = { ...parentNode, children: remaining };
  const nextRoot = replaceNodeAtPath(state.root, parentPath, () => nextParent);
  const nextSizes = {
    ...state.sizesByGroupId,
    [parentNode.id]: normalizeSizes(
      parentSizes.filter((_, index) => index !== removeIndex),
      remaining.length,
    ),
  };
  return {
    root: nextRoot,
    sizesByGroupId: pruneSizes(nextRoot, nextSizes),
  };
}

export interface InsertPaneAtEdgeArgs {
  readonly state: TileTreeState;
  readonly targetPaneId: string;
  readonly newPane: TilePane;
  readonly position: EdgeDropPosition;
  readonly createGroupId: () => string;
}

export interface InsertPaneAtEdgeResult {
  readonly root: TileLayoutNode;
  readonly sizesByGroupId: SizesByGroupId;
}

/**
 * Insert `newPane` beside `targetPaneId` on the side given by `position`.
 *
 * When the target's parent group already runs in the drop direction, the new
 * pane is spliced into that group (the target's fraction is halved between
 * the two) - the tree stays flat and no nodes are recreated outside the
 * parent's path. Otherwise the target pane is wrapped in a fresh group of
 * two with even sizes.
 *
 * Returns `null` when the target is missing or when wrapping would exceed
 * {@link MAX_TREE_DEPTH} (merges never deepen the tree and are always
 * allowed).
 */
export function insertPaneAtEdge(
  args: InsertPaneAtEdgeArgs,
): InsertPaneAtEdgeResult | null {
  const { state, targetPaneId, newPane, position, createGroupId } = args;
  const direction: SplitDirection =
    position === "left" || position === "right" ? "horizontal" : "vertical";
  const insertAfter = position === "right" || position === "bottom";

  const targetPath = findPanePath(state.root, targetPaneId);
  if (targetPath === null) return null;

  const parentPath = targetPath.slice(0, -1);
  const targetIndex = targetPath[targetPath.length - 1] ?? 0;
  const parentNode =
    targetPath.length > 0 ? getNodeAtPath(state.root, parentPath) : null;

  if (
    parentNode !== null &&
    parentNode.kind === "group" &&
    parentNode.direction === direction
  ) {
    const parentSizes = sizesForGroup(state.sizesByGroupId, parentNode);
    const targetSize =
      parentSizes[targetIndex] ?? 1 / parentNode.children.length;
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
    const nextSizesList = [...parentSizes];
    nextSizesList.splice(insertIndex, 0, targetSize / 2);
    nextSizesList[targetIndex + (insertAfter ? 0 : 1)] = targetSize / 2;

    const nextChildren = [...parentNode.children];
    nextChildren.splice(insertIndex, 0, newPane);
    const nextParent: TileGroup = { ...parentNode, children: nextChildren };
    return {
      root: replaceNodeAtPath(state.root, parentPath, () => nextParent),
      sizesByGroupId: {
        ...state.sizesByGroupId,
        [parentNode.id]: normalizeSizes(nextSizesList, nextChildren.length),
      },
    };
  }

  // Wrapping deepens the target's subtree by one level. `targetPath.length`
  // counts ancestor groups, the wrap adds one, and the target subtree's own
  // depth sits below that.
  const targetNode = getNodeAtPath(state.root, targetPath);
  if (targetPath.length + 1 + getTreeDepth(targetNode) > MAX_TREE_DEPTH) {
    return null;
  }

  const newGroup: TileGroup = {
    kind: "group",
    id: createGroupId(),
    direction,
    children: insertAfter ? [targetNode, newPane] : [newPane, targetNode],
  };
  return {
    root: replaceNodeAtPath(state.root, targetPath, () => newGroup),
    sizesByGroupId: {
      ...state.sizesByGroupId,
      [newGroup.id]: [0.5, 0.5],
    },
  };
}
