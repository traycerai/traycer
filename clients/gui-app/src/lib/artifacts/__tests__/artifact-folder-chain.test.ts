import { describe, expect, it } from "vitest";
import { artifactFolderChain } from "@/lib/artifacts/artifact-folder-chain";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  TreeNode,
  TreeSlice,
} from "@/stores/epics/open-epic/types";

function treeNode(id: string, parentId: string | null): TreeNode {
  return {
    id,
    parentId,
    title: id,
    type: "spec",
    status: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function artifact(id: string, folderName: string): ArtifactProjection {
  return {
    id,
    kind: "spec",
    title: id,
    folderName,
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
  };
}

function buildSlices(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly parentId: string | null;
    readonly folderName: string;
  }>,
): { tree: TreeSlice; artifacts: ArtifactsSlice } {
  const nodeById: Record<string, TreeNode> = {};
  const byId: Record<string, ArtifactProjection> = {};
  const rootIds: string[] = [];
  const childrenByParent: Record<string, string[]> = {};
  for (const entry of entries) {
    nodeById[entry.id] = treeNode(entry.id, entry.parentId);
    byId[entry.id] = artifact(entry.id, entry.folderName);
    if (entry.parentId === null) {
      rootIds.push(entry.id);
    } else {
      childrenByParent[entry.parentId] = [
        ...(childrenByParent[entry.parentId] ?? []),
        entry.id,
      ];
    }
  }
  return {
    tree: { rootIds, childrenByParent, nodeById },
    artifacts: { byId, allIds: entries.map((e) => e.id) },
  };
}

describe("artifactFolderChain", () => {
  it("returns a single-element chain for a top-level artifact", () => {
    const { tree, artifacts } = buildSlices([
      { id: "a", parentId: null, folderName: "ticket-breakdown" },
    ]);
    expect(artifactFolderChain(tree, artifacts, "a")).toEqual([
      "ticket-breakdown",
    ]);
  });

  it("walks parentId root-to-leaf for a nested artifact", () => {
    const { tree, artifacts } = buildSlices([
      { id: "a", parentId: null, folderName: "ticket-breakdown" },
      { id: "b", parentId: "a", folderName: "01-something" },
      { id: "c", parentId: "b", folderName: "sub-item" },
    ]);
    expect(artifactFolderChain(tree, artifacts, "c")).toEqual([
      "ticket-breakdown",
      "01-something",
      "sub-item",
    ]);
  });

  it("returns null for an unknown artifact id", () => {
    const { tree, artifacts } = buildSlices([
      { id: "a", parentId: null, folderName: "ticket-breakdown" },
    ]);
    expect(artifactFolderChain(tree, artifacts, "missing")).toBeNull();
  });

  it("returns null when an ancestor has no folder name (legacy/malformed entry)", () => {
    const { tree, artifacts } = buildSlices([
      { id: "a", parentId: null, folderName: "" },
      { id: "b", parentId: "a", folderName: "01-something" },
    ]);
    expect(artifactFolderChain(tree, artifacts, "b")).toBeNull();
  });

  it("returns null when an ancestor id is missing from the tree index", () => {
    const tree: TreeSlice = {
      rootIds: [],
      childrenByParent: {},
      nodeById: { b: treeNode("b", "a") },
    };
    const artifacts: ArtifactsSlice = {
      byId: { b: artifact("b", "01-something") },
      allIds: ["b"],
    };
    expect(artifactFolderChain(tree, artifacts, "b")).toBeNull();
  });

  it("returns null on a cyclic parentId chain instead of looping forever", () => {
    const tree: TreeSlice = {
      rootIds: [],
      childrenByParent: {},
      nodeById: {
        a: treeNode("a", "b"),
        b: treeNode("b", "a"),
      },
    };
    const artifacts: ArtifactsSlice = {
      byId: {
        a: artifact("a", "folder-a"),
        b: artifact("b", "folder-b"),
      },
      allIds: ["a", "b"],
    };
    expect(artifactFolderChain(tree, artifacts, "a")).toBeNull();
  });
});
