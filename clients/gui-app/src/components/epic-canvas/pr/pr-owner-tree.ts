import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import type { EpicTreeIndex } from "@/lib/epic-selectors";

/**
 * One owner in the overflow popover, with the owners nested UNDER it.
 *
 * A PR's owner set is flat on the wire, but the nodes in it are not: a chat
 * that spawns sub-agents (`agent.create` sets the child's `parentId` to its
 * sender) contributes itself AND its children, and those children usually
 * carry the parent's title. Rendered flat that reads as the same chat repeated
 * five times - the reported bug. Nesting says which one produced which.
 */
export interface PrOwnerTreeNode {
  readonly owner: PrOwnerRef;
  readonly children: readonly PrOwnerTreeNode[];
}

/**
 * The owner set as a forest, nested by the epic tree's own parent links.
 *
 * Only owners are rows: an ancestor that is NOT in the set is skipped rather
 * than rendered as context, so every row in the popover is still a chat this PR
 * actually came from. An owner whose whole ancestor chain is outside the set
 * (or whose node has been deleted) is a root.
 *
 * Sibling order is the caller's order, so the popover still lists owners in the
 * order the PR reports them - just re-parented, never re-sorted.
 */
export function buildPrOwnerTree(
  owners: readonly PrOwnerRef[],
  tree: EpicTreeIndex,
): readonly PrOwnerTreeNode[] {
  const present = new Map<string, PrOwnerRef>();
  for (const owner of owners) {
    if (!present.has(owner.ownerId)) present.set(owner.ownerId, owner);
  }

  const childrenOf = new Map<string, PrOwnerRef[]>();
  const roots: PrOwnerRef[] = [];
  for (const owner of present.values()) {
    const parentId = nearestOwnerAncestor(owner.ownerId, present, tree);
    if (parentId === null) {
      roots.push(owner);
      continue;
    }
    const bucket = childrenOf.get(parentId);
    if (bucket === undefined) childrenOf.set(parentId, [owner]);
    else bucket.push(owner);
  }

  // Guards a `parentId` cycle - possible in a CRDT tree where two peers reparent
  // concurrently. Without it a cycle recurses forever, and its members are
  // reachable from no root at all, so the post-pass below is what keeps them
  // from silently vanishing out of a list whose whole job is completeness.
  const emitted = new Set<string>();
  const build = (owner: PrOwnerRef): PrOwnerTreeNode => {
    emitted.add(owner.ownerId);
    const children = childrenOf.get(owner.ownerId) ?? [];
    return {
      owner,
      children: children
        .filter((child) => !emitted.has(child.ownerId))
        .map(build),
    };
  };

  const forest: PrOwnerTreeNode[] = roots.map(build);
  // Re-checked as the loop runs, not filtered up front: building one cycle
  // member emits the rest of its ring, and a snapshot taken before the loop
  // would still hold them and emit each a second time.
  for (const owner of present.values()) {
    if (emitted.has(owner.ownerId)) continue;
    forest.push(build(owner));
  }
  return forest;
}

/**
 * The closest ancestor of `ownerId` that is itself an owner, or `null` when the
 * chain leaves the set (or leaves the tree - a deleted node has no entry).
 */
function nearestOwnerAncestor(
  ownerId: string,
  present: ReadonlyMap<string, PrOwnerRef>,
  tree: EpicTreeIndex,
): string | null {
  if (!Object.hasOwn(tree.nodeById, ownerId)) return null;
  const walked = new Set<string>([ownerId]);
  let current: string | null = tree.nodeById[ownerId].parentId;
  while (current !== null && !walked.has(current)) {
    if (present.has(current)) return current;
    walked.add(current);
    if (!Object.hasOwn(tree.nodeById, current)) return null;
    current = tree.nodeById[current].parentId;
  }
  return null;
}
