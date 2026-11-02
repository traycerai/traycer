import { describe, expect, it } from "vitest";
import {
  sidebarBulkDeleteIds,
  sidebarBulkDeleteSelectedRows,
  sidebarBulkDeleteSelectionOrder,
} from "../epic-sidebar-selection";
import type {
  EpicTreeNodeType,
  TreeNode,
  TreeSlice,
} from "@/stores/epics/open-epic/types";

function node(
  id: string,
  parentId: string | null,
  type: EpicTreeNodeType,
): TreeNode {
  return {
    id,
    parentId,
    title: id,
    type,
    status: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function treeOf(nodes: readonly TreeNode[]): TreeSlice {
  return {
    rootIds: nodes.filter((n) => n.parentId === null).map((n) => n.id),
    childrenByParent: {},
    nodeById: Object.fromEntries(nodes.map((n) => [n.id, n])),
  };
}

describe("sidebarBulkDeleteIds", () => {
  const tree = treeOf([
    node("chat-root", null, "chat"),
    node("chat-child", "chat-root", "chat"),
    node("chat-grandchild", "chat-child", "chat"),
    node("agent-root", null, "terminal-agent"),
    node("spec-root", null, "spec"),
    node("ticket-child", "spec-root", "ticket"),
    node("ticket-orphan-sibling", null, "ticket"),
  ]);
  const types = new Map(
    Object.values(tree.nodeById).map((n) => [n.id, n.type]),
  );
  const isAgentId = (id: string): boolean =>
    types.get(id) === "chat" || types.get(id) === "terminal-agent";

  it("keeps every selected agent, deepest first, since an agent delete removes only itself", () => {
    expect(
      sidebarBulkDeleteIds({
        ids: ["chat-root", "agent-root", "chat-grandchild", "chat-child"],
        tree,
        isAgentId,
      }),
    ).toEqual(["chat-grandchild", "chat-child", "chat-root", "agent-root"]);
  });

  it("drops a selected descendant of a selected artifact, which the parent's delete cascades to", () => {
    expect(
      sidebarBulkDeleteIds({
        ids: ["ticket-child", "spec-root", "ticket-orphan-sibling"],
        tree,
        isAgentId,
      }),
    ).toEqual(["spec-root", "ticket-orphan-sibling"]);
  });

  it("applies each rule to its own family in a mixed selection", () => {
    expect(
      sidebarBulkDeleteIds({
        ids: ["spec-root", "ticket-child", "chat-root", "chat-child"],
        tree,
        isAgentId,
      }),
    ).toEqual(["chat-child", "chat-root", "spec-root"]);
  });
});

describe("sidebarBulkDeleteSelectedRows", () => {
  const tree = treeOf([
    node("chat-root", null, "chat"),
    node("chat-child", "chat-root", "chat"),
    node("spec-root", null, "spec"),
    node("ticket-child", "spec-root", "ticket"),
    node("ticket-grandchild", "ticket-child", "ticket"),
    node("ticket-orphan-sibling", null, "ticket"),
  ]);
  const types = new Map(
    Object.values(tree.nodeById).map((n) => [n.id, n.type]),
  );
  const isAgentId = (id: string): boolean =>
    types.get(id) === "chat" || types.get(id) === "terminal-agent";

  // The notice counts what the user selected, so an artifact whose delete
  // cascades to selected descendants stands for every one of those rows
  // (traycerai/traycer#2546).
  it("counts each selected descendant against the topmost selected artifact its delete cascades from", () => {
    const rows = sidebarBulkDeleteSelectedRows({
      ids: [
        "ticket-grandchild",
        "spec-root",
        "ticket-child",
        "ticket-orphan-sibling",
      ],
      tree,
      isAgentId,
    });
    expect(Object.fromEntries(rows)).toEqual({
      "spec-root": 3,
      "ticket-orphan-sibling": 1,
    });
  });

  it("counts every selected agent as its own row, since an agent delete removes only itself", () => {
    const rows = sidebarBulkDeleteSelectedRows({
      ids: ["chat-root", "chat-child", "ticket-child"],
      tree,
      isAgentId,
    });
    expect(Object.fromEntries(rows)).toEqual({
      "chat-root": 1,
      "chat-child": 1,
      "ticket-child": 1,
    });
  });
});

// A batch notice lists refusal advice in the order it first appears in the
// selection, while deletes are dispatched agents deepest first and artifacts
// last (traycerai/traycer#2546).
describe("sidebarBulkDeleteSelectionOrder", () => {
  const tree = treeOf([
    node("chat-parent", null, "chat"),
    node("chat-child", "chat-parent", "chat"),
    node("spec-root", null, "spec"),
    node("ticket-child", "spec-root", "ticket"),
    node("ticket-orphan-sibling", null, "ticket"),
  ]);
  const types = new Map(
    Object.values(tree.nodeById).map((n) => [n.id, n.type]),
  );
  const isAgentId = (id: string): boolean =>
    types.get(id) === "chat" || types.get(id) === "terminal-agent";

  function bySelection(ids: readonly string[]): string[] {
    const order = sidebarBulkDeleteSelectionOrder({ ids, tree, isAgentId });
    return [...sidebarBulkDeleteIds({ ids, tree, isAgentId })].sort(
      (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
    );
  }

  it("puts a parent agent selected before its child first, though the child is deleted first", () => {
    const ids = ["chat-parent", "chat-child"];
    expect(sidebarBulkDeleteIds({ ids, tree, isAgentId })).toEqual([
      "chat-child",
      "chat-parent",
    ]);
    expect(bySelection(ids)).toEqual(["chat-parent", "chat-child"]);
  });

  it("puts an artifact selected before an agent first, though artifacts are deleted last", () => {
    expect(bySelection(["ticket-orphan-sibling", "chat-parent"])).toEqual([
      "ticket-orphan-sibling",
      "chat-parent",
    ]);
  });

  it("places a cascading artifact at its earliest selected row, a descendant included", () => {
    expect(bySelection(["ticket-child", "chat-parent", "spec-root"])).toEqual([
      "spec-root",
      "chat-parent",
    ]);
  });
});
