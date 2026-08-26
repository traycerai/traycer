/**
 * Direct unit coverage for `@/lib/reparent-projection-rules` - the projected
 * `TreeSlice` evaluator that is now the SOLE authority for every reparent
 * decision in the app (DnD preview, DnD commit, and the store's write-path
 * validation). It has none of its own until this file: it has only ever been
 * reached indirectly through the store or the DnD commit helper.
 *
 * These fixtures build a `TreeSlice` by hand - no Y.Doc, no store, no
 * `createOpenEpicStore`. `evaluateProjectedReparent` and
 * `projectedReparentRejectionError` only ever read `tree.nodeById`, so a
 * `TreeSlice` can be constructed directly without going through the
 * projector. This also means these fixtures don't (and structurally
 * cannot) distinguish a doc-backed node from a registry-backed one - which
 * is exactly the point: the projected tree treats every node uniformly
 * regardless of where it came from, and that uniformity is why it can judge
 * a drop for every node the doc-based evaluator (`@/lib/reparent-rules`)
 * could not see.
 *
 * The matrix in section 1 was ported case-for-case from the doc evaluator's
 * own suite (`epic-y-mutations-reparent.test.ts`), which was written first and
 * ran green alongside this file before that evaluator was deleted - so the two
 * agreed on every cell at the moment the authority moved. That suite is gone
 * with the code it covered; this is now the only matrix, and `git log` for the
 * deleted file is where the parallel-proof history lives.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateProjectedReparent,
  nodeFamilyOf,
  projectedReparentRejectionError,
  type ProjectedReparentEvaluation,
} from "@/lib/reparent-projection-rules";
import type {
  EpicTreeNodeType,
  TreeNode,
  TreeSlice,
} from "@/stores/epics/open-epic/types";
import type { ReparentRejectionReason } from "@/lib/reparent-rules";
import {
  CrossFamilyParentError,
  MissingNodeError,
  ReparentCycleError,
} from "@/lib/errors";

function node(
  id: string,
  type: EpicTreeNodeType,
  parentId: string | null,
): TreeNode {
  return {
    id,
    parentId,
    title: id,
    type,
    status: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function tree(nodes: ReadonlyArray<TreeNode>): TreeSlice {
  const nodeById: Record<string, TreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const n of nodes) {
    nodeById[n.id] = n;
    if (n.parentId === null) {
      rootIds.push(n.id);
    } else {
      const siblings = childrenByParent[n.parentId] ?? [];
      siblings.push(n.id);
      childrenByParent[n.parentId] = siblings;
    }
  }
  return { rootIds, childrenByParent, nodeById };
}

type Decision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ReparentRejectionReason };

function decision(evaluation: ProjectedReparentEvaluation): Decision {
  return evaluation.ok
    ? { ok: true }
    : { ok: false, reason: evaluation.reason };
}

describe("evaluateProjectedReparent — matrix mirrored from the doc evaluator", () => {
  it("returns ok for a valid artifact move", () => {
    const t = tree([
      node("spec-a", "spec", null),
      node("spec-b", "spec", null),
    ]);
    expect(decision(evaluateProjectedReparent(t, "spec-a", "spec-b"))).toEqual({
      ok: true,
    });
  });

  it("returns ok for a chat under a chat", () => {
    const t = tree([
      node("chat-1", "chat", null),
      node("chat-2", "chat", null),
    ]);
    expect(decision(evaluateProjectedReparent(t, "chat-2", "chat-1"))).toEqual({
      ok: true,
    });
  });

  it("flags missing-node when the node is absent", () => {
    const t = tree([node("spec-a", "spec", null)]);
    expect(decision(evaluateProjectedReparent(t, "ghost", null))).toEqual({
      ok: false,
      reason: "missing-node",
    });
  });

  it("flags missing-node when the parent is absent", () => {
    const t = tree([node("spec-a", "spec", null)]);
    expect(decision(evaluateProjectedReparent(t, "spec-a", "ghost"))).toEqual({
      ok: false,
      reason: "missing-node",
    });
  });

  it("flags cross-panel when an artifact targets a chat", () => {
    const t = tree([
      node("spec-a", "spec", null),
      node("chat-1", "chat", null),
    ]);
    expect(decision(evaluateProjectedReparent(t, "spec-a", "chat-1"))).toEqual({
      ok: false,
      reason: "cross-panel",
    });
  });

  it("flags cross-panel when a chat targets an artifact", () => {
    const t = tree([
      node("spec-a", "spec", null),
      node("chat-1", "chat", null),
    ]);
    expect(decision(evaluateProjectedReparent(t, "chat-1", "spec-a"))).toEqual({
      ok: false,
      reason: "cross-panel",
    });
  });

  it("flags cycle when target equals the node itself", () => {
    const t = tree([node("spec-a", "spec", null)]);
    expect(decision(evaluateProjectedReparent(t, "spec-a", "spec-a"))).toEqual({
      ok: false,
      reason: "cycle",
    });
  });

  it("flags cycle when target is an artifact descendant", () => {
    const t = tree([
      node("a", "spec", null),
      node("b", "ticket", "a"),
      node("c", "story", "b"),
    ]);
    expect(decision(evaluateProjectedReparent(t, "a", "c"))).toEqual({
      ok: false,
      reason: "cycle",
    });
  });

  it("flags cycle on an agent-family descendant chain (chat -> chat -> terminal-agent)", () => {
    const t = tree([
      node("chat-a", "chat", null),
      node("chat-b", "chat", "chat-a"),
      node("agent-c", "terminal-agent", "chat-b"),
    ]);
    // chat-a -> agent-c would cycle (agent-c descends from chat-a via chat-b).
    expect(decision(evaluateProjectedReparent(t, "chat-a", "agent-c"))).toEqual(
      { ok: false, reason: "cycle" },
    );
  });

  it("flags same-parent when no movement would occur", () => {
    const t = tree([
      node("spec-a", "spec", null),
      node("tic-1", "ticket", "spec-a"),
    ]);
    expect(decision(evaluateProjectedReparent(t, "tic-1", "spec-a"))).toEqual({
      ok: false,
      reason: "same-parent",
    });
    // root -> root no-op too.
    expect(decision(evaluateProjectedReparent(t, "spec-a", null))).toEqual({
      ok: false,
      reason: "same-parent",
    });
  });

  it("mirrors the doc evaluator's decisions across the full matrix", () => {
    const setup = () =>
      tree([
        node("a", "spec", null),
        node("b", "ticket", "a"),
        node("chat-1", "chat", null),
        node("chat-2", "chat", null),
      ]);

    const cases: ReadonlyArray<{
      nodeId: string;
      newParentId: string | null;
      expected: Decision;
    }> = [
      { nodeId: "b", newParentId: null, expected: { ok: true } },
      { nodeId: "chat-2", newParentId: "chat-1", expected: { ok: true } },
      {
        nodeId: "b",
        newParentId: "a",
        expected: { ok: false, reason: "same-parent" },
      },
      {
        nodeId: "a",
        newParentId: "a",
        expected: { ok: false, reason: "cycle" },
      },
      {
        nodeId: "a",
        newParentId: "b",
        expected: { ok: false, reason: "cycle" },
      },
      {
        nodeId: "a",
        newParentId: "chat-1",
        expected: { ok: false, reason: "cross-panel" },
      },
      {
        nodeId: "chat-1",
        newParentId: "a",
        expected: { ok: false, reason: "cross-panel" },
      },
      {
        nodeId: "a",
        newParentId: "ghost",
        expected: { ok: false, reason: "missing-node" },
      },
      {
        nodeId: "ghost",
        newParentId: "a",
        expected: { ok: false, reason: "missing-node" },
      },
    ];

    for (const c of cases) {
      expect(
        decision(evaluateProjectedReparent(setup(), c.nodeId, c.newParentId)),
      ).toEqual(c.expected);
    }
  });
});

describe("projectedReparentRejectionError blames the side the projection actually complained about", () => {
  it("blames the NODE when the node itself is absent from the tree", () => {
    const t = tree([node("spec-a", "spec", null)]);
    const evaluation = evaluateProjectedReparent(t, "ghost", "spec-a");
    expect(evaluation).toEqual({ ok: false, reason: "missing-node" });

    const error = projectedReparentRejectionError(
      t,
      "missing-node",
      "ghost",
      "spec-a",
    );
    expect(error).toBeInstanceOf(MissingNodeError);
    expect(error.message).toContain("node=ghost");
  });

  it("blames the PARENT when the node exists but the named parent does not", () => {
    // This is the exact bug the doc-based `reparentRejectionError` had for a
    // registry-backed row: its `missingRole` probe asks the DOC, which has
    // no entry for a registry-backed node, so it would blame the node even
    // when the real complaint is the parent. `projectedReparentRejectionError`
    // probes the TREE instead, so a node present there is never misblamed.
    const t = tree([node("spec-a", "spec", null)]);
    const evaluation = evaluateProjectedReparent(t, "spec-a", "ghost-parent");
    expect(evaluation).toEqual({ ok: false, reason: "missing-node" });

    const error = projectedReparentRejectionError(
      t,
      "missing-node",
      "spec-a",
      "ghost-parent",
    );
    expect(error).toBeInstanceOf(MissingNodeError);
    expect(error.message).toContain("parent=ghost-parent");
  });

  it("blames the node correctly even when it is registry-backed (no doc entry to consult)", () => {
    // A registry-backed row is, from the projected tree's point of view, a
    // node like any other - there is nothing in a `TreeSlice` that marks
    // provenance. This is the case that motivated writing
    // `projectedReparentRejectionError` at all: the doc-based version would
    // always answer "node" here, because its doc-probe finds no entry for a
    // registry-backed id regardless of which side is actually missing.
    const t = tree([node("chat-registry", "chat", null)]);
    const error = projectedReparentRejectionError(
      t,
      "missing-node",
      "chat-registry",
      "ghost-parent",
    );
    expect(error.message).toContain("parent=ghost-parent");
    expect(error.message).not.toContain("node=chat-registry");
  });

  it("builds ReparentCycleError and CrossFamilyParentError for their reasons", () => {
    const t = tree([node("a", "spec", null)]);
    expect(
      projectedReparentRejectionError(t, "cycle", "a", "a"),
    ).toBeInstanceOf(ReparentCycleError);
    expect(
      projectedReparentRejectionError(t, "cross-panel", "a", "chat-1"),
    ).toBeInstanceOf(CrossFamilyParentError);
  });
});

describe("isProjectedDescendantOf (via evaluateProjectedReparent) terminates on a pointer cycle", () => {
  it("does not falsely flag cycle when the parent chain contains a pre-existing cycle, and terminates", () => {
    const t = tree([
      // Pre-existing a <-> b cycle (e.g. a concurrent-edit Yjs merge that
      // neither the host nor the projector breaks).
      node("a", "spec", "b"),
      node("b", "spec", "a"),
      // c hangs off the cycle; l is an unrelated leaf at root.
      node("c", "ticket", "a"),
      node("l", "ticket", null),
    ]);
    // Moving l under c walks c -> a -> b -> a (revisit) without ever
    // reaching l, so it must be allowed - the chain looping is not l's
    // descendant. If the `visited` guard were missing, this call would hang
    // instead of returning - and this test would fail on the suite's
    // default timeout rather than silently pass.
    expect(decision(evaluateProjectedReparent(t, "l", "c"))).toEqual({
      ok: true,
    });
    // A node caught in the cycle can still escape to a safe parent (the walk
    // from l never revisits a, so a is not flagged as l's descendant).
    expect(decision(evaluateProjectedReparent(t, "a", "l"))).toEqual({
      ok: true,
    });
  });

  it("terminates on a self-contained cycle with no path to the ancestor at all", () => {
    const t = tree([
      node("x", "chat", "y"),
      node("y", "chat", "x"),
      node("z", "chat", null),
    ]);
    // z is not reachable from the x<->y cycle in either direction.
    expect(decision(evaluateProjectedReparent(t, "z", "x"))).toEqual({
      ok: true,
    });
    expect(decision(evaluateProjectedReparent(t, "x", "z"))).toEqual({
      ok: true,
    });
  });
});

describe("pre-short-circuit ordering", () => {
  it("surfaces cross-panel (not same-parent) when re-dropping onto a corrupt cross-family parent", () => {
    // Artifact whose parentId corruptly points at a chat (different family).
    const t = tree([
      node("spec-a", "spec", "chat-1"),
      node("chat-1", "chat", null),
    ]);
    // Re-dropping spec-a back onto chat-1 must report the real cross-family
    // reason, not be masked as a silent same-parent no-op.
    expect(decision(evaluateProjectedReparent(t, "spec-a", "chat-1"))).toEqual({
      ok: false,
      reason: "cross-panel",
    });
  });
});

describe("nodeFamilyOf", () => {
  // A `Record` over every `EpicTreeNodeType` member: adding a new node type
  // without updating this map is a compile error (a missing property), so a
  // new type cannot silently fall through `nodeFamilyOf`'s default branch
  // unnoticed. Vitest does not type-check (see AGENTS.md), so this
  // exhaustiveness guarantee is enforced by `bun run compile`, not by this
  // test run - the test itself only pins the current mapping.
  const ALL_NODE_TYPES: Record<EpicTreeNodeType, true> = {
    chat: true,
    "terminal-agent": true,
    spec: true,
    ticket: true,
    story: true,
    review: true,
  };

  it("maps chat and terminal-agent to the agent family, everything else to artifact", () => {
    for (const type of Object.keys(ALL_NODE_TYPES) as EpicTreeNodeType[]) {
      const expected =
        type === "chat" || type === "terminal-agent" ? "agent" : "artifact";
      expect(nodeFamilyOf(type)).toBe(expected);
    }
  });
});

describe("cases the doc-based evaluator could not express", () => {
  it("validates a move where both node and parent exist ONLY as tree rows (no doc-arm concept at this layer)", () => {
    // At the projected-tree layer there is no such thing as "doc-backed" vs
    // "registry-backed" - every node is just a row in `nodeById`. That
    // uniformity is the whole fix: the doc evaluator special-cased which of
    // its three Y.Doc maps a node lived in, so a node living in NONE of them
    // (a registry record) was invisible to it. Store-level coverage in
    // `stores/epics/open-epic/__tests__/reparent-artifact-projected-validation.test.ts`
    // exercises the real doc/registry split; this proves the pure evaluator
    // underneath has no such split to trip over in the first place.
    const t = tree([
      node("agent-1", "terminal-agent", null),
      node("chat-registry", "chat", null),
    ]);
    expect(
      decision(evaluateProjectedReparent(t, "agent-1", "chat-registry")),
    ).toEqual({ ok: true });
  });

  it("catches a cycle spanning nodes that would sit in different doc arms", () => {
    // chat-registry (would be record-only) is the ancestor; chat-doc (would
    // be doc-backed) is its descendant. The doc evaluator's walk resolves
    // nodes out of `artifacts`/`chats`/`tuiAgents` Y.Maps directly and would
    // never find a record-only ancestor at all, so this cycle was
    // structurally undetectable before 4.3.
    const t = tree([
      node("chat-registry", "chat", null),
      node("chat-doc", "chat", "chat-registry"),
    ]);
    expect(
      decision(evaluateProjectedReparent(t, "chat-registry", "chat-doc")),
    ).toEqual({ ok: false, reason: "cycle" });
  });
});
