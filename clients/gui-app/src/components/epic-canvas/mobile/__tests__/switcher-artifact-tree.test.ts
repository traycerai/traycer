import { describe, expect, it } from "vitest";
import {
  buildSwitcherArtifactTree,
  type SwitcherTreeNode,
} from "@/components/epic-canvas/mobile/switcher-artifact-tree";
import type { EpicTreeRecord } from "@/lib/epic-selectors";

function record(id: string, parentId: string | null): EpicTreeRecord {
  return {
    id,
    parentId,
    name: id,
    type: "spec",
    status: null,
    hostId: "host-A",
  };
}

/**
 * The nested result flattened to `[id, depth]` in render order. Depth is
 * counted by this walk rather than read off the value under test, so a builder
 * that nested wrongly cannot report itself as correct.
 */
function shape(
  records: ReadonlyArray<EpicTreeRecord>,
): ReadonlyArray<readonly [string, number]> {
  const out: Array<readonly [string, number]> = [];
  const walk = (
    nodes: ReadonlyArray<SwitcherTreeNode>,
    depth: number,
  ): void => {
    for (const node of nodes) {
      out.push([node.record.id, depth]);
      walk(node.children, depth + 1);
    }
  };
  walk(buildSwitcherArtifactTree(records), 0);
  return out;
}

describe("buildSwitcherArtifactTree", () => {
  it("groups children under their parent at increasing depth", () => {
    expect(
      shape([
        record("root", null),
        record("child", "root"),
        record("grandchild", "child"),
      ]),
    ).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ]);
  });

  it("keeps the slice's order between siblings and between roots", () => {
    // The slice arrives in the epic's sort order, so nesting may regroup it but
    // must not re-sort it: `b` before `a` here, and `b`'s children in the order
    // the slice listed them.
    expect(
      shape([
        record("b", null),
        record("b2", "b"),
        record("a", null),
        record("b1", "b"),
      ]),
    ).toEqual([
      ["b", 0],
      ["b2", 1],
      ["b1", 1],
      ["a", 0],
    ]);
  });

  it("promotes a record whose parent is not in the slice to depth 0", () => {
    // The filters removed the parent, or it is a chat and this list excludes
    // chats. Either way the child is still a match and must still be listed.
    expect(shape([record("orphan", "absent-parent")])).toEqual([["orphan", 0]]);
  });

  it("promotes a whole subtree when its root is filtered out", () => {
    expect(
      shape([record("child", "absent"), record("grandchild", "child")]),
    ).toEqual([
      ["child", 0],
      ["grandchild", 1],
    ]);
  });

  it("emits records that no root reaches rather than dropping them", () => {
    // A parent cycle: neither record descends from a root, so the root walk
    // reaches neither. The first is adopted as a root afterwards and the cycle
    // breaks at it, so both are listed - the position is arbitrary, the
    // presence is not.
    expect(shape([record("x", "y"), record("y", "x")])).toEqual([
      ["x", 0],
      ["y", 1],
    ]);
  });

  it("treats a self-parented record as a root", () => {
    expect(shape([record("self", "self")])).toEqual([["self", 0]]);
  });

  it("emits every input exactly once", () => {
    const records = [
      record("r", null),
      record("c", "r"),
      record("loop-a", "loop-b"),
      record("loop-b", "loop-a"),
      record("orphan", "gone"),
    ];
    const flattened = shape(records);
    expect(flattened).toHaveLength(records.length);
    expect(new Set(flattened.map(([id]) => id)).size).toBe(records.length);
  });

  it("returns nothing for an empty slice", () => {
    expect(buildSwitcherArtifactTree([])).toEqual([]);
  });
});
