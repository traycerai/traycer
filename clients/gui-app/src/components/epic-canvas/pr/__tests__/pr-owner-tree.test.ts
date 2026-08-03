import { describe, it, expect } from "vitest";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import type { EpicTreeIndex, EpicTreeNode } from "@/lib/epic-selectors";
import {
  buildPrOwnerTree,
  prOwnerKey,
  type PrOwnerTreeNode,
} from "@/components/epic-canvas/pr/pr-owner-tree";

function treeIndex(
  parentByNodeId: Readonly<Record<string, string | null>>,
): EpicTreeIndex {
  const nodeById: Record<string, EpicTreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const [id, parentId] of Object.entries(parentByNodeId)) {
    nodeById[id] = {
      id,
      parentId,
      title: id,
      type: "chat",
      status: null,
      createdAt: 0,
      updatedAt: 0,
    };
    if (parentId === null) {
      rootIds.push(id);
      continue;
    }
    if (Object.hasOwn(childrenByParent, parentId)) {
      childrenByParent[parentId].push(id);
    } else {
      childrenByParent[parentId] = [id];
    }
  }
  return { rootIds, childrenByParent, nodeById };
}

function flatten(forest: readonly PrOwnerTreeNode[]): readonly string[] {
  return forest.flatMap((node) => [
    prOwnerKey(node.owner),
    ...flatten(node.children),
  ]);
}

const chat = (id: string): PrOwnerRef => ({
  ownerId: id,
  ownerKind: "chat",
});
const agent = (id: string): PrOwnerRef => ({
  ownerId: id,
  ownerKind: "terminal-agent",
});

describe("buildPrOwnerTree identity", () => {
  it("collapses a repeated owner reference to a single row", () => {
    const forest = buildPrOwnerTree(
      [chat("n-1"), chat("n-1"), chat("n-2")],
      treeIndex({ "n-1": null, "n-2": null }),
    );

    expect(flatten(forest)).toEqual(["chat:n-1", "chat:n-2"]);
  });

  /**
   * The caller counts `+N` and slices its visible chips off the array it was
   * handed, keyed on `ownerKind:ownerId` - the same identity the host dedupes
   * its own owner set on. Collapsing on `ownerId` alone would be a NARROWER
   * key than the producer's, so a row would vanish from the popover while the
   * trigger still promised it.
   */
  it("keeps two owners that share a node id under different kinds", () => {
    const forest = buildPrOwnerTree(
      [chat("n-1"), agent("n-1")],
      treeIndex({ "n-1": null }),
    );

    expect(flatten(forest)).toEqual(["chat:n-1", "terminal-agent:n-1"]);
  });

  it("emits a shared descendant once even when two owners claim its parent id", () => {
    const forest = buildPrOwnerTree(
      [chat("n-1"), agent("n-1"), chat("n-2")],
      treeIndex({ "n-1": null, "n-2": "n-1" }),
    );

    // n-2 nests under the first claimant and is not repeated under the second.
    expect(flatten(forest)).toEqual([
      "chat:n-1",
      "chat:n-2",
      "terminal-agent:n-1",
    ]);
  });
});
