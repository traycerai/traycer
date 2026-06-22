import { describe, expect, it } from "vitest";
import {
  clampNormalizedSizes,
  collectPanes,
  findPaneById,
  findPanePath,
  getTreeDepth,
  insertPaneAtEdge,
  normalizeSizes,
  pruneSizes,
  removePaneFromTree,
  replaceNodeAtPath,
  replacePane,
} from "@/stores/epics/canvas/tile-tree";
import type { SizesByGroupId } from "@/stores/epics/canvas/tile-tree";
import {
  MAX_TREE_DEPTH,
  MIN_SPLIT_SIZE,
} from "@/stores/epics/canvas/tile-tree-constants";
import { group, pane } from "./canvas-test-fixtures";

/** Counter-free group-id minter for deterministic insert assertions. */
function makeGroupIdFactory(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

/** Approximate-equality for a fraction list summing to ~1. */
function expectSizesCloseTo(
  actual: ReadonlyArray<number> | undefined,
  expected: ReadonlyArray<number>,
): void {
  expect(actual).toBeDefined();
  if (actual === undefined) return;
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 10);
  });
}

describe("normalizeSizes", () => {
  it("scales arbitrary positive weights to sum to 1", () => {
    expectSizesCloseTo(normalizeSizes([1, 3], 2), [0.25, 0.75]);
  });

  it("pads missing entries with weight 1 before normalizing", () => {
    expectSizesCloseTo(normalizeSizes([2], 2), [2 / 3, 1 / 3]);
  });

  it("truncates extra entries to `count`", () => {
    expectSizesCloseTo(normalizeSizes([1, 1, 1, 1], 2), [0.5, 0.5]);
  });

  it("treats non-finite / non-positive entries as weight 1", () => {
    expectSizesCloseTo(
      normalizeSizes([Number.NaN, -4, 0, 1], 4),
      [0.25, 0.25, 0.25, 0.25],
    );
  });

  it("returns [] for count <= 0", () => {
    expect(normalizeSizes([1, 2], 0)).toEqual([]);
    expect(normalizeSizes([], -1)).toEqual([]);
  });

  it("falls back to even sizes when all weights collapse to 0", () => {
    // After sanitization every entry becomes 1, never 0, so the only way to
    // hit the zero-total branch is an empty-yet-counted request padded to 1s;
    // verify the padded path still produces a valid distribution.
    expectSizesCloseTo(normalizeSizes([], 3), [1 / 3, 1 / 3, 1 / 3]);
  });
});

describe("clampNormalizedSizes", () => {
  it("returns [] for an empty input", () => {
    expect(clampNormalizedSizes([])).toEqual([]);
  });

  it("returns [1] for a single entry", () => {
    expect(clampNormalizedSizes([0.01])).toEqual([1]);
  });

  it("leaves already-valid sizes untouched (within float tolerance)", () => {
    expectSizesCloseTo(clampNormalizedSizes([0.5, 0.5]), [0.5, 0.5]);
  });

  it("floors a below-MIN entry and redistributes the remainder", () => {
    const clamped = clampNormalizedSizes([0.02, 0.98]);
    expect(clamped[0]).toBeCloseTo(MIN_SPLIT_SIZE, 10);
    expect(clamped[1]).toBeCloseTo(1 - MIN_SPLIT_SIZE, 10);
    expect(clamped.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  });

  it("falls back to even sizes when the floor cannot be satisfied", () => {
    // 11 entries * 0.1 = 1.1 > 1, so no floor assignment is possible.
    const count = Math.ceil(1 / MIN_SPLIT_SIZE) + 1;
    const clamped = clampNormalizedSizes(
      Array.from({ length: count }, () => 1),
    );
    expectSizesCloseTo(
      clamped,
      Array.from({ length: count }, () => 1 / count),
    );
  });

  it("floors every entry below MIN simultaneously and renormalizes", () => {
    // Three tiny + one large: each tiny clamps to MIN, the large keeps the
    // remainder, and the result still sums to 1.
    const clamped = clampNormalizedSizes([0.01, 0.01, 0.01, 0.97]);
    expect(clamped[0]).toBeCloseTo(MIN_SPLIT_SIZE, 10);
    expect(clamped[1]).toBeCloseTo(MIN_SPLIT_SIZE, 10);
    expect(clamped[2]).toBeCloseTo(MIN_SPLIT_SIZE, 10);
    expect(clamped[3]).toBeCloseTo(1 - 3 * MIN_SPLIT_SIZE, 10);
  });
});

describe("findPanePath", () => {
  it("returns [] for the root pane", () => {
    expect(findPanePath(pane("p", []), "p")).toEqual([]);
  });

  it("returns the index path to a nested pane", () => {
    const tree = group("g", "horizontal", [
      pane("a", []),
      group("g2", "vertical", [pane("b", []), pane("c", [])]),
    ]);
    expect(findPanePath(tree, "a")).toEqual([0]);
    expect(findPanePath(tree, "b")).toEqual([1, 0]);
    expect(findPanePath(tree, "c")).toEqual([1, 1]);
  });

  it("returns null for an absent pane id", () => {
    expect(findPanePath(pane("p", []), "missing")).toBeNull();
  });
});

describe("findPaneById", () => {
  it("returns null for a null root", () => {
    expect(findPaneById(null, "p")).toBeNull();
  });

  it("locates a nested pane and returns its exact reference", () => {
    const leaf = pane("b", ["t-b"]);
    const tree = group("g", "horizontal", [pane("a", []), leaf]);
    expect(findPaneById(tree, "b")).toBe(leaf);
    expect(findPaneById(tree, "missing")).toBeNull();
  });
});

describe("collectPanes", () => {
  it("returns [] for a null root", () => {
    expect(collectPanes(null)).toEqual([]);
  });

  it("returns a single pane for a bare-pane root", () => {
    const p = pane("p", []);
    expect(collectPanes(p)).toEqual([p]);
  });

  it("flattens panes left-to-right depth-first", () => {
    const a = pane("a", []);
    const b = pane("b", []);
    const c = pane("c", []);
    const tree = group("g", "horizontal", [a, group("g2", "vertical", [b, c])]);
    expect(collectPanes(tree)).toEqual([a, b, c]);
  });
});

describe("getTreeDepth", () => {
  it("reports depth 1 for a bare pane", () => {
    expect(getTreeDepth(pane("p", []))).toBe(1);
  });

  it("reports depth across an unbalanced tree", () => {
    // g (1) -> g2 (2) -> g3 (3) -> pane (4): the deepest branch dominates.
    const tree = group("g", "horizontal", [
      pane("a", []),
      group("g2", "vertical", [
        pane("b", []),
        group("g3", "horizontal", [pane("c", []), pane("d", [])]),
      ]),
    ]);
    expect(getTreeDepth(tree)).toBe(4);
  });
});

describe("replaceNodeAtPath", () => {
  it("applies the updater at the root for an empty path", () => {
    const next = pane("next", ["t"]);
    expect(replaceNodeAtPath(pane("p", []), [], () => next)).toBe(next);
  });

  it("returns the SAME root reference when the updater returns the node unchanged", () => {
    const tree = group("g", "horizontal", [pane("a", []), pane("b", [])]);
    const same = replaceNodeAtPath(tree, [1], (node) => node);
    expect(same).toBe(tree);
  });

  it("copies only the path to the touched node; siblings keep identity", () => {
    const a = pane("a", ["t-a"]);
    const sibling = group("g-sib", "vertical", [pane("c", []), pane("d", [])]);
    const tree = group("g", "horizontal", [a, sibling]);

    const replacedA = pane("a", ["t-a", "t-extra"]);
    const next = replaceNodeAtPath(tree, [0], () => replacedA);

    expect(next).not.toBe(tree);
    if (next.kind !== "group") throw new Error("expected group root");
    expect(next.children[0]).toBe(replacedA);
    // The untouched sibling subtree keeps reference identity.
    expect(next.children[1]).toBe(sibling);
  });

  it("structurally shares deep untouched siblings", () => {
    const deepSibling = group("g-deep", "horizontal", [
      pane("x", []),
      pane("y", []),
    ]);
    const tree = group("g", "horizontal", [
      group("g-left", "vertical", [pane("a", []), deepSibling]),
      pane("b", []),
    ]);

    // Touch pane "a" deep on the left.
    const next = replaceNodeAtPath(tree, [0, 0], () => pane("a", ["t-new"]));
    if (next.kind !== "group") throw new Error("expected group root");
    const left = next.children[0];
    if (left.kind !== "group") throw new Error("expected left group");
    // Deep sibling under the same parent stays `===`.
    expect(left.children[1]).toBe(deepSibling);
    // The whole right subtree stays `===`.
    expect(next.children[1]).toBe(tree.children[1]);
  });
});

describe("replacePane", () => {
  it("returns the same root when the pane id is absent", () => {
    const tree = group("g", "horizontal", [pane("a", []), pane("b", [])]);
    expect(replacePane(tree, "missing", (p) => p)).toBe(tree);
  });

  it("returns the same root when the updater is a no-op", () => {
    const tree = group("g", "horizontal", [pane("a", []), pane("b", [])]);
    expect(replacePane(tree, "a", (p) => p)).toBe(tree);
  });

  it("updates the matched pane while sharing the untouched sibling", () => {
    const sibling = pane("b", ["t-b"]);
    const tree = group("g", "horizontal", [pane("a", ["t-a"]), sibling]);
    const next = replacePane(tree, "a", (p) => ({
      ...p,
      activeTabId: null,
    }));
    if (next.kind !== "group") throw new Error("expected group root");
    expect(next.children[0]).not.toBe(tree.children[0]);
    expect(next.children[1]).toBe(sibling);
  });
});

describe("pruneSizes", () => {
  it("returns the same map when every size key is live", () => {
    const tree = group("g", "horizontal", [pane("a", []), pane("b", [])]);
    const sizes: SizesByGroupId = { g: [0.5, 0.5] };
    expect(pruneSizes(tree, sizes)).toBe(sizes);
  });

  it("drops size entries for groups no longer in the tree", () => {
    const tree = group("g", "horizontal", [pane("a", []), pane("b", [])]);
    const sizes: SizesByGroupId = { g: [0.5, 0.5], dead: [0.3, 0.7] };
    const pruned = pruneSizes(tree, sizes);
    expect(pruned).toEqual({ g: [0.5, 0.5] });
  });

  it("drops every entry for a null root", () => {
    expect(pruneSizes(null, { g: [0.5, 0.5] })).toEqual({});
  });
});

describe("insertPaneAtEdge - same-direction merge", () => {
  it("splices into the parent group and halves the target fraction (trailing)", () => {
    const target = pane("a", ["t-a"]);
    const tree = group("g", "horizontal", [target, pane("b", ["t-b"])]);
    const result = insertPaneAtEdge({
      state: { root: tree, sizesByGroupId: { g: [0.4, 0.6] } },
      targetPaneId: "a",
      newPane: pane("new", ["t-new"]),
      position: "right",
      createGroupId: makeGroupIdFactory("grp"),
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    if (result.root.kind !== "group") throw new Error("expected group root");
    // Flat: 3 children in the SAME group, no new group minted.
    expect(result.root.id).toBe("g");
    expect(result.root.children).toHaveLength(3);
    expect(result.root.children.map((c) => c.id)).toEqual(["a", "new", "b"]);
    // Target fraction 0.4 halved between "a" and "new"; "b" keeps 0.6.
    expectSizesCloseTo(result.sizesByGroupId.g, [0.2, 0.2, 0.6]);
  });

  it("splices before the target for a leading position", () => {
    const tree = group("g", "horizontal", [
      pane("a", ["t-a"]),
      pane("b", ["t-b"]),
    ]);
    const result = insertPaneAtEdge({
      state: { root: tree, sizesByGroupId: { g: [0.4, 0.6] } },
      targetPaneId: "a",
      newPane: pane("new", ["t-new"]),
      position: "left",
      createGroupId: makeGroupIdFactory("grp"),
    });
    if (result === null) throw new Error("expected insertion");
    if (result.root.kind !== "group") throw new Error("expected group root");
    expect(result.root.children.map((c) => c.id)).toEqual(["new", "a", "b"]);
    expectSizesCloseTo(result.sizesByGroupId.g, [0.2, 0.2, 0.6]);
  });

  it("keeps untouched sibling subtrees `===` after a merge", () => {
    const sibling = group("g-sib", "vertical", [
      pane("x", ["t-x"]),
      pane("y", ["t-y"]),
    ]);
    const tree = group("g", "horizontal", [pane("a", ["t-a"]), sibling]);
    const result = insertPaneAtEdge({
      state: { root: tree, sizesByGroupId: {} },
      targetPaneId: "a",
      newPane: pane("new", ["t-new"]),
      position: "right",
      createGroupId: makeGroupIdFactory("grp"),
    });
    if (result === null) throw new Error("expected insertion");
    if (result.root.kind !== "group") throw new Error("expected group root");
    // The sibling group object is reused unchanged.
    expect(result.root.children[result.root.children.length - 1]).toBe(sibling);
  });
});

describe("insertPaneAtEdge - cross-direction wrap", () => {
  it("wraps a bare-pane root in a new 2-child group with [0.5, 0.5]", () => {
    const target = pane("a", ["t-a"]);
    const createGroupId = makeGroupIdFactory("grp");
    const result = insertPaneAtEdge({
      state: { root: target, sizesByGroupId: {} },
      targetPaneId: "a",
      newPane: pane("new", ["t-new"]),
      position: "bottom",
      createGroupId,
    });
    if (result === null) throw new Error("expected insertion");
    if (result.root.kind !== "group") throw new Error("expected group root");
    expect(result.root.id).toBe("grp-1");
    expect(result.root.direction).toBe("vertical");
    expect(result.root.children.map((c) => c.id)).toEqual(["a", "new"]);
    expectSizesCloseTo(result.sizesByGroupId["grp-1"], [0.5, 0.5]);
  });

  it("wraps with the new pane leading for a top/left position", () => {
    const target = pane("a", ["t-a"]);
    const result = insertPaneAtEdge({
      state: { root: target, sizesByGroupId: {} },
      targetPaneId: "a",
      newPane: pane("new", ["t-new"]),
      position: "left",
      createGroupId: makeGroupIdFactory("grp"),
    });
    if (result === null) throw new Error("expected insertion");
    if (result.root.kind !== "group") throw new Error("expected group root");
    expect(result.root.direction).toBe("horizontal");
    expect(result.root.children.map((c) => c.id)).toEqual(["new", "a"]);
  });

  it("wraps a pane whose parent group runs in the cross direction", () => {
    // Parent runs horizontal; a vertical drop on "a" must wrap "a" alone.
    const sibling = pane("b", ["t-b"]);
    const tree = group("g", "horizontal", [pane("a", ["t-a"]), sibling]);
    const result = insertPaneAtEdge({
      state: { root: tree, sizesByGroupId: { g: [0.5, 0.5] } },
      targetPaneId: "a",
      newPane: pane("new", ["t-new"]),
      position: "bottom",
      createGroupId: makeGroupIdFactory("grp"),
    });
    if (result === null) throw new Error("expected insertion");
    if (result.root.kind !== "group") throw new Error("expected group root");
    expect(result.root.id).toBe("g");
    const wrapped = result.root.children[0];
    if (wrapped.kind !== "group") throw new Error("expected wrapped group");
    expect(wrapped.direction).toBe("vertical");
    expect(wrapped.children.map((c) => c.id)).toEqual(["a", "new"]);
    expectSizesCloseTo(result.sizesByGroupId[wrapped.id], [0.5, 0.5]);
    // Parent's own sizes survive untouched; sibling kept `===`.
    expect(result.root.children[1]).toBe(sibling);
    expect(result.sizesByGroupId.g).toEqual([0.5, 0.5]);
  });
});

describe("insertPaneAtEdge - rejections", () => {
  it("returns null for a missing target pane", () => {
    const result = insertPaneAtEdge({
      state: { root: pane("a", []), sizesByGroupId: {} },
      targetPaneId: "missing",
      newPane: pane("new", []),
      position: "right",
      createGroupId: makeGroupIdFactory("grp"),
    });
    expect(result).toBeNull();
  });

  it("returns null when a cross-direction wrap would exceed MAX_TREE_DEPTH", () => {
    // Build a depth-MAX_TREE_DEPTH tree where the deepest pane sits at the cap;
    // a cross-direction wrap of it would overflow.
    const deepest = pane("d", ["t-d"]);
    const level3 = group("g3", "horizontal", [pane("c", ["t-c"]), deepest]);
    const level2 = group("g2", "vertical", [pane("b", ["t-b"]), level3]);
    const root = group("g1", "horizontal", [pane("a", ["t-a"]), level2]);
    expect(getTreeDepth(root)).toBe(MAX_TREE_DEPTH);

    // Cross-direction wrap of the deepest pane would deepen past the cap.
    const result = insertPaneAtEdge({
      state: { root, sizesByGroupId: {} },
      targetPaneId: "d",
      newPane: pane("new", ["t-new"]),
      position: "bottom",
      createGroupId: makeGroupIdFactory("grp"),
    });
    expect(result).toBeNull();

    // A same-direction merge on that pane stays flat and is still allowed.
    const merged = insertPaneAtEdge({
      state: { root, sizesByGroupId: {} },
      targetPaneId: "d",
      newPane: pane("new", ["t-new"]),
      position: "right",
      createGroupId: makeGroupIdFactory("grp"),
    });
    expect(merged).not.toBeNull();
    expect(merged === null ? 0 : getTreeDepth(merged.root)).toBe(
      MAX_TREE_DEPTH,
    );
  });
});

describe("removePaneFromTree", () => {
  it("returns null when the pane id is absent", () => {
    expect(
      removePaneFromTree(
        { root: pane("a", []), sizesByGroupId: {} },
        "missing",
      ),
    ).toBeNull();
  });

  it("yields root: null when removing the bare-pane root", () => {
    const result = removePaneFromTree(
      { root: pane("a", []), sizesByGroupId: {} },
      "a",
    );
    expect(result?.root).toBeNull();
    expect(result?.sizesByGroupId).toEqual({});
  });

  it("shrinks a >2-child parent and renormalizes its sizes", () => {
    const tree = group("g", "horizontal", [
      pane("a", ["t-a"]),
      pane("b", ["t-b"]),
      pane("c", ["t-c"]),
    ]);
    const result = removePaneFromTree(
      { root: tree, sizesByGroupId: { g: [0.2, 0.3, 0.5] } },
      "b",
    );
    if (result === null || result.root === null) {
      throw new Error("expected surviving root");
    }
    if (result.root.kind !== "group") throw new Error("expected group root");
    expect(result.root.children.map((c) => c.id)).toEqual(["a", "c"]);
    // Remaining [0.2, 0.5] renormalize to sum 1.
    expectSizesCloseTo(result.sizesByGroupId.g, [0.2 / 0.7, 0.5 / 0.7]);
  });

  it("dissolves a 2-child parent into its surviving child and prunes sizes", () => {
    const survivor = pane("b", ["t-b"]);
    const tree = group("g", "horizontal", [pane("a", ["t-a"]), survivor]);
    const result = removePaneFromTree(
      { root: tree, sizesByGroupId: { g: [0.4, 0.6] } },
      "a",
    );
    if (result === null) throw new Error("expected result");
    // The surviving child is promoted into the group's slot (and is the
    // exact same reference - structural sharing).
    expect(result.root).toBe(survivor);
    // The dissolved group's sizes entry is pruned.
    expect(result.sizesByGroupId).toEqual({});
  });

  it("keeps untouched sibling subtrees `===` when shrinking a deeper parent", () => {
    const farSibling = group("g-far", "vertical", [
      pane("x", ["t-x"]),
      pane("y", ["t-y"]),
    ]);
    const innerGroup = group("g-inner", "horizontal", [
      pane("a", ["t-a"]),
      pane("b", ["t-b"]),
      pane("c", ["t-c"]),
    ]);
    const tree = group("g-root", "vertical", [innerGroup, farSibling]);
    const result = removePaneFromTree(
      { root: tree, sizesByGroupId: { "g-inner": [0.3, 0.3, 0.4] } },
      "b",
    );
    if (result === null || result.root === null) {
      throw new Error("expected surviving root");
    }
    if (result.root.kind !== "group") throw new Error("expected group root");
    // The far sibling subtree is reused unchanged.
    expect(result.root.children[1]).toBe(farSibling);
  });
});
