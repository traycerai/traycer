import { describe, expect, it } from "vitest";
import {
  expandNestedArtifactExport,
  hasNestedMarkdownArtifacts,
  type ArtifactExportTree,
} from "@/lib/artifacts/artifact-export-selection";
import type {
  ArtifactProjection,
  EpicTreeNodeType,
  TreeNode,
} from "@/stores/epics/open-epic/types";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";

interface Row {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly type: EpicTreeNodeType;
}

function artifact(
  id: string,
  parentId: string | null,
  title: string,
  kind: EpicArtifactKind,
): ArtifactProjection {
  return {
    id,
    kind,
    title,
    folderName: id,
    parentId,
    artifactRoomId: null,
    createdAt: 1,
    updatedAt: 1,
    status: null,
    createdManually: false,
  };
}

/**
 * spec
 * ├─ story
 * │  └─ ticket
 * ├─ page (html)
 * │  └─ page-note (review)
 * └─ chat (not an artifact)
 *    └─ chat-spec
 * other (leaf)
 */
function exportTree(): ArtifactExportTree {
  const rows: Row[] = [
    { id: "spec", parentId: null, title: "Spec", type: "spec" },
    { id: "story", parentId: "spec", title: "Story", type: "story" },
    { id: "ticket", parentId: "story", title: "", type: "ticket" },
    { id: "page", parentId: "spec", title: "Page", type: "html" },
    { id: "page-note", parentId: "page", title: "Note", type: "review" },
    { id: "chat", parentId: "spec", title: "Chat", type: "chat" },
    { id: "chat-spec", parentId: "chat", title: "Chat spec", type: "spec" },
    { id: "other", parentId: null, title: "Other", type: "spec" },
  ];
  const childrenByParent: Record<string, string[]> = {};
  const nodeById: Record<string, TreeNode> = {};
  const byId: Record<string, ArtifactProjection> = {};
  for (const row of rows) {
    nodeById[row.id] = { ...row, status: null, createdAt: 1, updatedAt: 1 };
    if (row.parentId !== null) {
      childrenByParent[row.parentId] = [
        ...(childrenByParent[row.parentId] ?? []),
        row.id,
      ];
    }
    if (row.type !== "chat" && row.type !== "terminal-agent") {
      byId[row.id] = artifact(row.id, row.parentId, row.title, row.type);
    }
  }
  return {
    artifacts: { byId, allIds: Object.keys(byId) },
    tree: {
      rootIds: rows.filter((row) => row.parentId === null).map((r) => r.id),
      childrenByParent,
      nodeById,
    },
  };
}

describe("expandNestedArtifactExport", () => {
  it("adds every Markdown descendant, linked to its nearest exported ancestor", () => {
    expect(
      expandNestedArtifactExport(exportTree(), [{ id: "spec", title: "Spec" }]),
    ).toEqual([
      { id: "spec", title: "Spec", parentId: null },
      { id: "story", title: "Story", parentId: "spec" },
      // An empty title gets the same fallback label the sidebar shows.
      { id: "ticket", title: "Untitled ticket", parentId: "story" },
      // The HTML page has no document body; its child attaches past it.
      { id: "page-note", title: "Note", parentId: "spec" },
    ]);
  });

  it("exports a pick nested under another pick once, in place", () => {
    expect(
      expandNestedArtifactExport(exportTree(), [
        { id: "ticket", title: "Ticket" },
        { id: "spec", title: "Spec" },
        { id: "other", title: "Other" },
      ]).map((entry) => [entry.id, entry.parentId]),
    ).toEqual([
      ["spec", null],
      ["story", "spec"],
      ["ticket", "story"],
      ["page-note", "spec"],
      ["other", null],
    ]);
  });

  it("keeps a pick its picked ancestor's walk cannot reach", () => {
    expect(
      expandNestedArtifactExport(exportTree(), [
        { id: "spec", title: "Spec" },
        { id: "chat-spec", title: "Chat spec" },
      ]).at(-1),
    ).toEqual({ id: "chat-spec", title: "Chat spec", parentId: null });
  });

  it("exports a pick the tree does not hold yet on its own", () => {
    expect(
      expandNestedArtifactExport(exportTree(), [
        { id: "unresolved", title: "Pending" },
      ]),
    ).toEqual([{ id: "unresolved", title: "Pending", parentId: null }]);
  });
});

describe("hasNestedMarkdownArtifacts", () => {
  it("looks through non-Markdown artifacts to find a document", () => {
    const tree = exportTree();
    expect(hasNestedMarkdownArtifacts(tree, "spec")).toBe(true);
    expect(hasNestedMarkdownArtifacts(tree, "page")).toBe(true);
    expect(hasNestedMarkdownArtifacts(tree, "ticket")).toBe(false);
    expect(hasNestedMarkdownArtifacts(tree, "other")).toBe(false);
  });
});
