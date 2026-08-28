import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import type { EpicTreeIndex } from "@/lib/epic-selectors";

/**
 * What to call a SET of owners.
 *
 * `ownerKind` is not always `chat` - a PR can be derived entirely from terminal
 * agents, and calling those "chats" in a list's accessible name announces the
 * wrong thing to a screen reader. A uniform set gets its own noun; a mixed one
 * has no single true noun, so it falls back to the kind-neutral word rather
 * than picking a side.
 *
 * Lives beside the tree helpers rather than in `pr-owner-label.tsx` because
 * both owner surfaces (the `+N` popover and the row's hover card) need it, and
 * a component module that also exports a plain function breaks fast refresh.
 */
export function prOwnerCollectionNouns(owners: readonly PrOwnerRef[]): {
  readonly plural: string;
  readonly capitalized: string;
} {
  const kinds = new Set(owners.map((owner) => owner.ownerKind));
  if (kinds.size === 1) {
    if (kinds.has("chat")) return { plural: "chats", capitalized: "Chats" };
    return { plural: "terminal agents", capitalized: "Terminal agents" };
  }
  return { plural: "owners", capitalized: "Owners" };
}

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
  // An owner's IDENTITY is the pair, matching how the host dedupes its own
  // owner set and how the caller keys the chips. Collapsing on `ownerId` alone
  // would be a narrower key than the producer's, so two owners the host
  // considers distinct could lose a row here while the `+N` on the trigger -
  // counted from the undeduplicated array - still promised it.
  const present = new Map<string, PrOwnerRef>();
  for (const owner of owners) {
    const key = prOwnerKey(owner);
    if (!present.has(key)) present.set(key, owner);
  }
  // Parent links are between NODES, so the ancestor walk needs a second index
  // keyed by node id alone. First owner wins, which only matters in the case
  // the identity key exists to allow: one node id under two kinds.
  const ownerByNodeId = new Map<string, PrOwnerRef>();
  for (const owner of present.values()) {
    if (!ownerByNodeId.has(owner.ownerId)) {
      ownerByNodeId.set(owner.ownerId, owner);
    }
  }

  const childrenOf = new Map<string, PrOwnerRef[]>();
  const roots: PrOwnerRef[] = [];
  for (const owner of present.values()) {
    const parentId = nearestOwnerAncestor(owner.ownerId, ownerByNodeId, tree);
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
    emitted.add(prOwnerKey(owner));
    const children = childrenOf.get(owner.ownerId) ?? [];
    return {
      owner,
      children: children
        .filter((child) => !emitted.has(prOwnerKey(child)))
        .map(build),
    };
  };

  const forest: PrOwnerTreeNode[] = roots.map(build);
  // Re-checked as the loop runs, not filtered up front: building one cycle
  // member emits the rest of its ring, and a snapshot taken before the loop
  // would still hold them and emit each a second time.
  for (const owner of present.values()) {
    if (emitted.has(prOwnerKey(owner))) continue;
    forest.push(build(owner));
  }
  return forest;
}

/**
 * The owner's identity - the same `ownerKind:ownerId` pair the host dedupes its
 * owner set on, and the same one the chips and rows use as their React key.
 */
export function prOwnerKey(owner: PrOwnerRef): string {
  return `${owner.ownerKind}:${owner.ownerId}`;
}

/**
 * The closest ancestor of `ownerId` that is itself an owner, or `null` when the
 * chain leaves the set (or leaves the tree - a deleted node has no entry).
 */
function nearestOwnerAncestor(
  ownerId: string,
  ownerByNodeId: ReadonlyMap<string, PrOwnerRef>,
  tree: EpicTreeIndex,
): string | null {
  if (!Object.hasOwn(tree.nodeById, ownerId)) return null;
  const walked = new Set<string>([ownerId]);
  let current: string | null = tree.nodeById[ownerId].parentId;
  while (current !== null && !walked.has(current)) {
    if (ownerByNodeId.has(current)) return current;
    walked.add(current);
    if (!Object.hasOwn(tree.nodeById, current)) return null;
    current = tree.nodeById[current].parentId;
  }
  return null;
}
