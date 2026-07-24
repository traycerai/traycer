import { describe, expect, it } from "vitest";
import { buildArtifactPathIndex } from "@/lib/commands/sources/open/artifact-path-resolver";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  TreeNode,
  TreeSlice,
} from "@/stores/epics/open-epic/types";

interface Node {
  readonly id: string;
  readonly parentId: string | null;
  readonly folderName: string;
  readonly kind: ArtifactProjection["kind"];
  readonly title: string;
}

function treeNode(node: Node): TreeNode {
  return {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    type: node.kind,
    status: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function artifactProjection(node: Node): ArtifactProjection {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    folderName: node.folderName,
    parentId: node.parentId,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
  };
}

function slices(nodes: readonly Node[]): {
  tree: TreeSlice;
  artifacts: ArtifactsSlice;
} {
  return {
    tree: {
      rootIds: nodes.filter((n) => n.parentId === null).map((n) => n.id),
      childrenByParent: {},
      nodeById: Object.fromEntries(nodes.map((n) => [n.id, treeNode(n)])),
    },
    artifacts: {
      byId: Object.fromEntries(nodes.map((n) => [n.id, artifactProjection(n)])),
      allIds: nodes.map((n) => n.id),
    },
  };
}

describe("buildArtifactPathIndex", () => {
  it("maps each artifact's logical folder-chain path to its identity", () => {
    const { tree, artifacts } = slices([
      { id: "a", parentId: null, folderName: "tickets", kind: "story", title: "Tickets" },
      { id: "b", parentId: "a", folderName: "my-ticket", kind: "ticket", title: "My Ticket" },
    ]);
    const index = buildArtifactPathIndex(tree, artifacts);
    expect(index.get("tickets")).toEqual({
      id: "a",
      kind: "story",
      title: "Tickets",
    });
    // A nested artifact keys on its full root-to-leaf chain (the host projects
    // the mirror `tickets/my-ticket/index.md` to exactly this logical path).
    expect(index.get("tickets/my-ticket")).toEqual({
      id: "b",
      kind: "ticket",
      title: "My Ticket",
    });
  });

  it("returns null-equivalent (no entry) for an unknown logical path", () => {
    const { tree, artifacts } = slices([
      { id: "a", parentId: null, folderName: "specs", kind: "spec", title: "Specs" },
    ]);
    const index = buildArtifactPathIndex(tree, artifacts);
    expect(index.get("tickets/gone")).toBeUndefined();
  });

  it("skips an artifact whose chain cannot resolve (empty folder name)", () => {
    const { tree, artifacts } = slices([
      { id: "a", parentId: null, folderName: "", kind: "spec", title: "Legacy" },
      { id: "b", parentId: null, folderName: "reviews", kind: "review", title: "Reviews" },
    ]);
    const index = buildArtifactPathIndex(tree, artifacts);
    // The malformed (empty folder) entry contributes no path; the valid one does.
    expect(index.has("")).toBe(false);
    expect(index.get("reviews")?.id).toBe("b");
    expect(index.size).toBe(1);
  });

  it("returns an empty index when slices are absent", () => {
    expect(buildArtifactPathIndex(null, null).size).toBe(0);
  });

  it("fails closed (no entry) when two live artifacts share a logical path", () => {
    // Two distinct artifacts both projecting to `dupes/clash` is ambiguous.
    const collide: readonly Node[] = [
      { id: "p", parentId: null, folderName: "dupes", kind: "story", title: "Dupes" },
      { id: "a", parentId: "p", folderName: "clash", kind: "ticket", title: "A" },
      { id: "b", parentId: "p", folderName: "clash", kind: "ticket", title: "B" },
    ];
    // Same outcome regardless of iteration order - no first/last wins.
    for (const order of [collide, [...collide].reverse()]) {
      const { tree, artifacts } = slices(order);
      const index = buildArtifactPathIndex(tree, artifacts);
      expect(index.get("dupes/clash")).toBeUndefined();
      // The unambiguous parent path is unaffected.
      expect(index.get("dupes")?.id).toBe("p");
    }
  });

  it("keeps a colliding path closed even with a third claimant", () => {
    const { tree, artifacts } = slices([
      { id: "a", parentId: null, folderName: "clash", kind: "ticket", title: "A" },
      { id: "b", parentId: null, folderName: "clash", kind: "ticket", title: "B" },
      { id: "c", parentId: null, folderName: "clash", kind: "ticket", title: "C" },
    ]);
    expect(buildArtifactPathIndex(tree, artifacts).get("clash")).toBeUndefined();
  });
});
