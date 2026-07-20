import { describe, expect, it } from "vitest";
import {
  computeDescendantCounts,
  computeDescendantCountsFromTree,
  formatCascadeSummary,
  type DescendantCounts,
} from "@/lib/epic-tree-cascade";
import type { EpicTreeRecord } from "@/lib/epic-selectors";
import type { TreeNode, TreeSlice } from "@/stores/epics/open-epic/types";

function makeRecord(
  id: string,
  type: EpicTreeRecord["type"],
  parentId: string | null,
): EpicTreeRecord {
  return {
    id,
    type,
    name: id,
    parentId,
    status: null,
    hostId: "test-host",
  };
}

/** Build a `TreeSlice` from a flat record list so the two count functions can
 * be checked against the same fixtures (the tree is the records' parent/child
 * graph). */
function treeFromRecords(records: ReadonlyArray<EpicTreeRecord>): TreeSlice {
  const nodeById: Record<string, TreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  for (const r of records) {
    nodeById[r.id] = {
      id: r.id,
      parentId: r.parentId,
      title: r.name,
      type: r.type,
      status: r.status,
      createdAt: 0,
      updatedAt: 0,
    };
    if (r.parentId !== null) {
      (childrenByParent[r.parentId] ??= []).push(r.id);
    }
  }
  const rootIds = records.flatMap((r) => (r.parentId === null ? [r.id] : []));
  return { rootIds, childrenByParent, nodeById };
}

describe("computeDescendantCounts", () => {
  it("returns all zeros when root has no children", () => {
    const records = [makeRecord("root", "spec", null)];
    const counts = computeDescendantCounts(records, "root");
    expect(counts).toEqual({
      spec: 0,
      ticket: 0,
      story: 0,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    });
  });

  it("counts direct children by type", () => {
    const records = [
      makeRecord("root", "spec", null),
      makeRecord("t1", "ticket", "root"),
      makeRecord("t2", "ticket", "root"),
      makeRecord("c1", "chat", "root"),
    ];
    const counts = computeDescendantCounts(records, "root");
    expect(counts).toEqual({
      spec: 0,
      ticket: 2,
      story: 0,
      review: 0,
      chat: 1,
      "terminal-agent": 0,
    });
  });

  it("counts nested descendants recursively", () => {
    const records = [
      makeRecord("root", "spec", null),
      makeRecord("child-spec", "spec", "root"),
      makeRecord("grandchild-ticket", "ticket", "child-spec"),
      makeRecord("grandchild-story", "story", "child-spec"),
    ];
    const counts = computeDescendantCounts(records, "root");
    expect(counts).toEqual({
      spec: 1,
      ticket: 1,
      story: 1,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    });
  });

  it("does not count nodes outside the subtree", () => {
    const records = [
      makeRecord("root", "spec", null),
      makeRecord("other", "spec", null),
      makeRecord("child", "ticket", "root"),
      makeRecord("other-child", "ticket", "other"),
    ];
    const counts = computeDescendantCounts(records, "root");
    expect(counts).toEqual({
      spec: 0,
      ticket: 1,
      story: 0,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    });
  });
});

describe("computeDescendantCountsFromTree", () => {
  // Equivalence with the record-based version on the same fixtures: the tree is
  // the canonical parent/child graph, so both must agree.
  const fixtures: ReadonlyArray<{
    readonly name: string;
    readonly records: ReadonlyArray<EpicTreeRecord>;
    readonly root: string;
  }> = [
    {
      name: "no children",
      records: [makeRecord("root", "spec", null)],
      root: "root",
    },
    {
      name: "direct children by type",
      records: [
        makeRecord("root", "spec", null),
        makeRecord("t1", "ticket", "root"),
        makeRecord("t2", "ticket", "root"),
        makeRecord("c1", "chat", "root"),
      ],
      root: "root",
    },
    {
      name: "nested descendants",
      records: [
        makeRecord("root", "spec", null),
        makeRecord("child-spec", "spec", "root"),
        makeRecord("g-ticket", "ticket", "child-spec"),
        makeRecord("g-story", "story", "child-spec"),
      ],
      root: "root",
    },
    {
      name: "ignores other subtrees",
      records: [
        makeRecord("root", "spec", null),
        makeRecord("other", "spec", null),
        makeRecord("child", "ticket", "root"),
        makeRecord("other-child", "ticket", "other"),
      ],
      root: "root",
    },
  ];

  for (const { name, records, root } of fixtures) {
    it(`matches the record-based counts: ${name}`, () => {
      expect(
        computeDescendantCountsFromTree(treeFromRecords(records), root),
      ).toEqual(computeDescendantCounts(records, root));
    });
  }

  it("terminates on a cyclic childrenByParent instead of looping forever", () => {
    const node = (id: string, type: TreeNode["type"]): TreeNode => ({
      id,
      parentId: null,
      title: id,
      type,
      status: null,
      createdAt: 0,
      updatedAt: 0,
    });
    const tree: TreeSlice = {
      rootIds: ["a"],
      childrenByParent: { a: ["b"], b: ["a"] },
      nodeById: { a: node("a", "spec"), b: node("b", "ticket") },
    };
    expect(computeDescendantCountsFromTree(tree, "a")).toEqual({
      spec: 1,
      ticket: 1,
      story: 0,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    });
  });
});

describe("formatCascadeSummary", () => {
  it("returns null when all counts are zero", () => {
    const counts: DescendantCounts = {
      spec: 0,
      ticket: 0,
      story: 0,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    };
    expect(formatCascadeSummary(counts)).toBeNull();
  });

  it("returns a single type string without 'and'", () => {
    const counts: DescendantCounts = {
      spec: 3,
      ticket: 0,
      story: 0,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    };
    expect(formatCascadeSummary(counts)).toBe("3 specs");
  });

  it("uses singular form for count 1", () => {
    const counts: DescendantCounts = {
      spec: 1,
      ticket: 0,
      story: 1,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    };
    expect(formatCascadeSummary(counts)).toBe("1 spec and 1 story");
  });

  it("joins two types with 'and'", () => {
    const counts: DescendantCounts = {
      spec: 2,
      ticket: 0,
      story: 0,
      review: 0,
      chat: 1,
      "terminal-agent": 0,
    };
    expect(formatCascadeSummary(counts)).toBe("2 specs and 1 agent");
  });

  it("joins three or more types with Oxford comma", () => {
    const counts: DescendantCounts = {
      spec: 1,
      ticket: 2,
      story: 0,
      review: 1,
      chat: 3,
      "terminal-agent": 0,
    };
    expect(formatCascadeSummary(counts)).toBe(
      "1 spec, 2 tickets, 1 review, and 3 agents",
    );
  });

  it("summarizes a mixed Chat/Terminal selection as one agent count", () => {
    const counts: DescendantCounts = {
      spec: 0,
      ticket: 0,
      story: 0,
      review: 0,
      chat: 1,
      "terminal-agent": 1,
    };
    // Agent is the durable entity; Chat/Terminal are only its interfaces, so
    // the summary must not split them into "1 chat and 1 terminal agent".
    expect(formatCascadeSummary(counts)).toBe("2 agents");
  });

  it("uses the singular agent noun for a lone terminal-interface agent", () => {
    const counts: DescendantCounts = {
      spec: 0,
      ticket: 0,
      story: 0,
      review: 0,
      chat: 0,
      "terminal-agent": 1,
    };
    expect(formatCascadeSummary(counts)).toBe("1 agent");
  });

  it("uses 'stories' plural for story", () => {
    const counts: DescendantCounts = {
      spec: 0,
      ticket: 0,
      story: 2,
      review: 0,
      chat: 0,
      "terminal-agent": 0,
    };
    expect(formatCascadeSummary(counts)).toBe("2 stories");
  });
});
