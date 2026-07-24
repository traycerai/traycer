import { describe, expect, it } from "vitest";
import {
  EMPTY_PROJECTED_SLICES,
  type ArtifactProjection,
  type ArtifactsSlice,
  type TreeNode,
  type TreeSlice,
} from "@/stores/epics/open-epic/types";
import {
  buildArtifactDisplayPathIndex,
  normalizeArtifactLogicalPath,
} from "@/lib/commands/sources/open/artifact-display-index";

interface Spec {
  readonly id: string;
  readonly folderName: string;
  readonly title: string;
  readonly parentId: string | null;
}

function slices(specs: ReadonlyArray<Spec>): {
  tree: TreeSlice;
  artifacts: ArtifactsSlice;
} {
  const byId: Record<string, ArtifactProjection> = {};
  const nodeById: Record<string, TreeNode> = {};
  for (const spec of specs) {
    byId[spec.id] = {
      id: spec.id,
      kind: "spec",
      title: spec.title,
      folderName: spec.folderName,
      parentId: spec.parentId,
      artifactRoomId: null,
      createdAt: 0,
      updatedAt: 0,
      status: null,
      createdManually: false,
    };
    nodeById[spec.id] = {
      id: spec.id,
      parentId: spec.parentId,
      title: spec.title,
      type: "spec",
      status: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  return {
    tree: { ...EMPTY_PROJECTED_SLICES.tree, nodeById },
    artifacts: { allIds: specs.map((s) => s.id), byId },
  };
}

describe("buildArtifactDisplayPathIndex", () => {
  it("indexes unique paths with display title + ancestor-title path", () => {
    const { tree, artifacts } = slices([
      { id: "p", folderName: "tickets", title: "Tickets", parentId: null },
      { id: "c", folderName: "one", title: "First", parentId: "p" },
    ]);
    const index = buildArtifactDisplayPathIndex(tree, artifacts);
    expect(index.get("tickets/one")).toMatchObject({
      id: "c",
      title: "First",
      titlePath: "Tickets / First",
    });
  });

  it("fails closed on a two-way collision - the shared path resolves to nothing", () => {
    const { tree, artifacts } = slices([
      { id: "a", folderName: "dup", title: "A", parentId: null },
      { id: "b", folderName: "dup", title: "B", parentId: null },
    ]);
    const index = buildArtifactDisplayPathIndex(tree, artifacts);
    expect(index.has("dup")).toBe(false);
  });

  it("is order-independent: a reversed allIds order still fails closed", () => {
    const forward = slices([
      { id: "a", folderName: "dup", title: "A", parentId: null },
      { id: "b", folderName: "dup", title: "B", parentId: null },
    ]);
    const reversed = slices([
      { id: "b", folderName: "dup", title: "B", parentId: null },
      { id: "a", folderName: "dup", title: "A", parentId: null },
    ]);
    expect(buildArtifactDisplayPathIndex(forward.tree, forward.artifacts).has("dup")).toBe(false);
    expect(buildArtifactDisplayPathIndex(reversed.tree, reversed.artifacts).has("dup")).toBe(false);
  });

  it("keeps a third claimant from re-adding an ambiguous path", () => {
    const { tree, artifacts } = slices([
      { id: "a", folderName: "dup", title: "A", parentId: null },
      { id: "b", folderName: "dup", title: "B", parentId: null },
      { id: "c", folderName: "dup", title: "C", parentId: null },
    ]);
    const index = buildArtifactDisplayPathIndex(tree, artifacts);
    expect(index.has("dup")).toBe(false);
  });

  it("does not let a collision poison unique sibling/parent paths", () => {
    const { tree, artifacts } = slices([
      { id: "a", folderName: "dup", title: "A", parentId: null },
      { id: "b", folderName: "dup", title: "B", parentId: null },
      { id: "u", folderName: "unique", title: "Unique", parentId: null },
      { id: "p", folderName: "parent", title: "Parent", parentId: null },
      { id: "k", folderName: "kid", title: "Kid", parentId: "p" },
    ]);
    const index = buildArtifactDisplayPathIndex(tree, artifacts);
    expect(index.has("dup")).toBe(false);
    expect(index.get("unique")?.id).toBe("u");
    expect(index.get("parent/kid")?.id).toBe("k");
  });
});

describe("normalizeArtifactLogicalPath", () => {
  it("strips leading and trailing slashes", () => {
    expect(normalizeArtifactLogicalPath("/tickets/one/")).toBe("tickets/one");
    expect(normalizeArtifactLogicalPath("one")).toBe("one");
  });
});
