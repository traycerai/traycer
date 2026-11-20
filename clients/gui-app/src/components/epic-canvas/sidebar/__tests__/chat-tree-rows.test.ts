import { describe, expect, it } from "vitest";
import {
  flattenChatTreeRows,
  PENDING_ACKNOWLEDGED_ROOT_KEY,
  PENDING_LOCAL_ROOT_KEY,
  pendingCreateRowKey,
  pendingPreAckRowKey,
  stabilizeChatTreeRows,
  type ChatTreeRow,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";
import { DEFAULT_SORT_MODE, makeNodeComparator } from "@/lib/epic-sort";
import { localChatRowKey } from "@/lib/chats/unified-chat-list";
import {
  chatNode,
  cloudEntry,
  cloudSummary,
  flattenInput,
  localEntry,
  treeOf,
} from "./chat-tree-row-fixtures";

/**
 * The flat list of rows the chat tree draws: the same rows, in the same order
 * and shape, as the nested rendering it replaced.
 */

function keys(rows: readonly ChatTreeRow[]): string[] {
  return rows.map((row) => row.key);
}

function nodeIds(rows: readonly ChatTreeRow[]): (string | null)[] {
  return rows.map((row) => row.nodeId);
}

/** root -> a (newer), b; a -> a1; b -> b1. */
const NESTED = treeOf([
  chatNode("root", null, 100),
  chatNode("a", "root", 90),
  chatNode("b", "root", 80),
  chatNode("a1", "a", 70),
  chatNode("b1", "b", 60),
]);
const ROOT_ENTRY = [localEntry("root")];
const NEWEST_FIRST = makeNodeComparator(DEFAULT_SORT_MODE);

describe("flattenChatTreeRows", () => {
  it("draws each descendant of an expanded branch one level deeper, in sort order", () => {
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: ROOT_ENTRY,
        tree: NESTED,
        expandedIds: new Set(["root", "a", "b"]),
      }),
    );

    expect(nodeIds(rows)).toEqual(["root", "a", "a1", "b", "b1"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 2]);
  });

  it("orders children by the panel's sort even when the tree lists them the other way", () => {
    const tree = treeOf([
      chatNode("root", null, 100),
      chatNode("old", "root", 10),
      chatNode("new", "root", 20),
    ]);
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: ROOT_ENTRY,
        tree,
        expandedIds: new Set(["root"]),
        comparator: NEWEST_FIRST,
      }),
    );

    expect(nodeIds(rows)).toEqual(["root", "new", "old"]);
  });

  it("draws none of a collapsed branch's descendants, whatever its own children's expansion", () => {
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: ROOT_ENTRY,
        tree: NESTED,
        expandedIds: new Set(["a", "b"]),
      }),
    );

    expect(nodeIds(rows)).toEqual(["root"]);
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it("reports a leaf as having no children, expanded or not", () => {
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: ROOT_ENTRY,
        tree: NESTED,
        expandedIds: new Set(["root"]),
      }),
    );

    const b = rows.find((row) => row.nodeId === "b");
    expect(b).toMatchObject({ hasChildren: true, expanded: false });
    const leaf = flattenChatTreeRows(
      flattenInput({
        listEntries: [localEntry("a1")],
        tree: NESTED,
        expandedIds: new Set(["a1"]),
      }),
    )[0];
    expect(leaf).toMatchObject({ hasChildren: false, expanded: true });
  });

  it("drops a hidden child at every level and keeps the rest in place", () => {
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: ROOT_ENTRY,
        tree: NESTED,
        expandedIds: new Set(["root", "a", "b"]),
        visibleIds: new Set(["root", "a", "b", "b1"]),
      }),
    );

    expect(nodeIds(rows)).toEqual(["root", "a", "b", "b1"]);
    expect(rows.find((row) => row.nodeId === "a")).toMatchObject({
      hasChildren: false,
    });
  });

  it("draws only the kinds the panel's filter accepts", () => {
    const tree = treeOf([
      chatNode("root", null, 100),
      { id: "ticket", parentId: "root", updatedAt: 90, type: "ticket" },
      chatNode("chat", "root", 80),
    ]);
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: ROOT_ENTRY,
        tree,
        expandedIds: new Set(["root"]),
        treeFilter: (type) => type === "chat",
      }),
    );

    expect(nodeIds(rows)).toEqual(["root", "chat"]);
  });

  it("interleaves cloud rows with local roots in the list's order", () => {
    const tree = treeOf([chatNode("l1", null, 10), chatNode("l2", null, 5)]);
    const shared = cloudSummary("cloud-1", null, "Shared");
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: [
          localEntry("l1"),
          cloudEntry(shared, []),
          localEntry("l2"),
        ],
        tree,
      }),
    );

    expect(rows.map((row) => row.kind)).toEqual(["local", "cloud", "local"]);
    expect(nodeIds(rows)).toEqual(["l1", "cloud-1", "l2"]);
    expect(rows.map((row) => row.posInSet)).toEqual([1, 2, 3]);
  });

  it("draws a cloud row's subagents beneath it only while it is expanded", () => {
    const parent = cloudSummary("orchestrator", null, "Orchestrator");
    const entry = cloudEntry(parent, [
      cloudEntry(cloudSummary("sub-a", "orchestrator", "A"), []),
      cloudEntry(cloudSummary("sub-b", "orchestrator", "B"), []),
    ]);

    const collapsed = flattenChatTreeRows(
      flattenInput({ listEntries: [entry] }),
    );
    const expanded = flattenChatTreeRows(
      flattenInput({ listEntries: [entry], expandedIds: new Set([entry.key]) }),
    );

    expect(nodeIds(collapsed)).toEqual(["orchestrator"]);
    expect(collapsed[0]).toMatchObject({ hasChildren: true, expanded: false });
    expect(nodeIds(expanded)).toEqual(["orchestrator", "sub-a", "sub-b"]);
    expect(expanded.map((row) => row.depth)).toEqual([0, 1, 1]);
    expect(expanded[1].parentKey).toBe(entry.key);
  });

  it("draws the pending rows after every agent, in local, acknowledged, pre-ack, create order", () => {
    const tree = treeOf([chatNode("l1", null, 10)]);
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: [localEntry("l1")],
        tree,
        pendingRoots: [
          { key: PENDING_LOCAL_ROOT_KEY, name: "local" },
          { key: PENDING_ACKNOWLEDGED_ROOT_KEY, name: "ack" },
          { key: pendingPreAckRowKey("t1"), name: "pre" },
          { key: pendingCreateRowKey("c1"), name: "create" },
        ],
      }),
    );

    expect(keys(rows)).toEqual([
      localChatRowKey("l1"),
      PENDING_LOCAL_ROOT_KEY,
      PENDING_ACKNOWLEDGED_ROOT_KEY,
      pendingPreAckRowKey("t1"),
      pendingCreateRowKey("c1"),
    ]);
    expect(rows[1]).toMatchObject({
      kind: "pending",
      nodeId: null,
      name: "local",
      depth: 0,
      hasChildren: false,
      expanded: false,
    });
    expect(rows.map((row) => row.setSize)).toEqual([5, 5, 5, 5, 5]);
  });

  it("numbers each row within the group it sits in", () => {
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: ROOT_ENTRY,
        tree: NESTED,
        expandedIds: new Set(["root", "a", "b"]),
      }),
    );

    const place = (id: string) => {
      const row = rows.find((candidate) => candidate.nodeId === id);
      return [row?.posInSet, row?.setSize];
    };
    expect(place("root")).toEqual([1, 1]);
    expect(place("a")).toEqual([1, 2]);
    expect(place("b")).toEqual([2, 2]);
    expect(place("a1")).toEqual([1, 1]);
    expect(place("b1")).toEqual([1, 1]);
  });

  it("keys a child by its path, so a moved row is a new row and a re-sorted one is the same", () => {
    const expanded = new Set(["root", "other"]);
    const before = flattenChatTreeRows(
      flattenInput({
        listEntries: [localEntry("root"), localEntry("other")],
        tree: treeOf([
          chatNode("root", null, 100),
          chatNode("other", null, 90),
          chatNode("x", "root", 50),
          chatNode("y", "root", 40),
        ]),
        expandedIds: expanded,
        comparator: NEWEST_FIRST,
      }),
    );
    const resorted = flattenChatTreeRows(
      flattenInput({
        listEntries: [localEntry("root"), localEntry("other")],
        tree: treeOf([
          chatNode("root", null, 100),
          chatNode("other", null, 90),
          chatNode("x", "root", 30),
          chatNode("y", "root", 40),
        ]),
        expandedIds: expanded,
        comparator: NEWEST_FIRST,
      }),
    );
    const moved = flattenChatTreeRows(
      flattenInput({
        listEntries: [localEntry("root"), localEntry("other")],
        tree: treeOf([
          chatNode("root", null, 100),
          chatNode("other", null, 90),
          chatNode("x", "other", 50),
          chatNode("y", "root", 40),
        ]),
        expandedIds: expanded,
        comparator: NEWEST_FIRST,
      }),
    );

    const xKey = (rows: readonly ChatTreeRow[]) =>
      rows.find((row) => row.nodeId === "x")?.key;
    expect(xKey(before)).toBe(`${localChatRowKey("root")}/local:x`);
    expect(nodeIds(resorted)).toEqual(["root", "y", "x", "other"]);
    expect(xKey(resorted)).toBe(xKey(before));
    expect(xKey(moved)).toBe(`${localChatRowKey("other")}/local:x`);
  });

  it("draws nothing for a root the tree no longer holds or whose kind the panel does not draw", () => {
    const tree = treeOf([
      { id: "ticket", parentId: null, updatedAt: 1, type: "ticket" },
      chatNode("here", null, 2),
    ]);
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: [
          localEntry("gone"),
          localEntry("ticket"),
          localEntry("here"),
        ],
        tree,
        treeFilter: (type) => type === "chat",
      }),
    );

    expect(nodeIds(rows)).toEqual(["here"]);
    expect(rows[0]).toMatchObject({ posInSet: 1, setSize: 1 });
  });

  it("terminates on a parent cycle", () => {
    const tree = {
      rootIds: [],
      childrenByParent: { a: ["b"], b: ["a"] },
      nodeById: treeOf([chatNode("a", null, 2), chatNode("b", null, 1)])
        .nodeById,
    };
    const rows = flattenChatTreeRows(
      flattenInput({
        listEntries: [localEntry("a")],
        tree,
        expandedIds: new Set(["a", "b"]),
      }),
    );

    expect(nodeIds(rows)).toEqual(["a", "b", "a"]);
  });
});

describe("stabilizeChatTreeRows", () => {
  const entries = [localEntry("root")];
  const input = flattenInput({
    listEntries: entries,
    tree: NESTED,
    expandedIds: new Set(["root"]),
    pendingRoots: [{ key: pendingCreateRowKey("c1"), name: "first" }],
  });

  it("returns the previous list itself when nothing changed", () => {
    const previous = flattenChatTreeRows(input);

    const next = stabilizeChatTreeRows(previous, flattenChatTreeRows(input));

    expect(next).toBe(previous);
  });

  it("keeps every unchanged row as the same object and replaces only the one that changed", () => {
    const previous = flattenChatTreeRows(input);
    const renamed = flattenChatTreeRows({
      ...input,
      pendingRoots: [{ key: pendingCreateRowKey("c1"), name: "second" }],
    });

    const next = stabilizeChatTreeRows(previous, renamed);

    expect(next).not.toBe(previous);
    next.slice(0, -1).forEach((row, index) => {
      expect(row).toBe(previous[index]);
    });
    expect(next[next.length - 1]).toMatchObject({ name: "second" });
    expect(next[next.length - 1]).not.toBe(previous[previous.length - 1]);
  });
});
