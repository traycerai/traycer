import { describe, expect, it } from "vitest";
import {
  describeTreeDeleteDisclosure,
  type TreeDeleteDisclosure,
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

/**
 * Build a `TreeSlice` from a flat record list, as the projector would.
 *
 * REFUSES a cross-family pairing instead of building it. `resolveEffectiveParent`
 * promotes an agent under an artifact (or the reverse) to the root, so a tree
 * holding one is a tree production cannot emit - and a fixture built from one
 * makes the sidebar's walk agree with something it will never be asked about.
 * Throwing here keeps that trap disarmed for every future fixture, rather than
 * leaving each one to remember.
 */
function treeFromRecords(records: ReadonlyArray<EpicTreeRecord>): TreeSlice {
  const isAgent = (type: EpicTreeRecord["type"]): boolean =>
    type === "chat" || type === "terminal-agent";
  const typeById = new Map(records.map((r) => [r.id, r.type]));
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
    if (r.parentId === null) continue;
    const parentType = typeById.get(r.parentId);
    if (parentType !== undefined && isAgent(parentType) !== isAgent(r.type)) {
      throw new Error(
        `${r.id} (${r.type}) under ${r.parentId} (${parentType}) is cross-family; the projector promotes that to the root`,
      );
    }
    (childrenByParent[r.parentId] ??= []).push(r.id);
  }
  const rootIds = records.flatMap((r) => (r.parentId === null ? [r.id] : []));
  return { rootIds, childrenByParent, nodeById };
}

describe("describeTreeDeleteDisclosure", () => {
  const UNDONE = "This action cannot be undone.";

  /** The one function, for agent rows whose nested agents have all arrived. */
  function agentDelete(
    tree: TreeSlice,
    nodeIds: readonly string[],
  ): TreeDeleteDisclosure {
    return describeTreeDeleteDisclosure({
      tree,
      kind: "agent",
      nodeIds,
      nestedAgentsKnown: true,
    });
  }

  /** The same, for artifact rows, which have no readiness question to take. */
  function artifactDelete(
    tree: TreeSlice,
    nodeIds: readonly string[],
  ): TreeDeleteDisclosure {
    return describeTreeDeleteDisclosure({
      tree,
      kind: "artifact",
      nodeIds,
      restoreAvailable: false,
    });
  }

  /** The same, where the host serves Deleted artifacts. */
  function restorableArtifactDelete(
    tree: TreeSlice,
    nodeIds: readonly string[],
  ): TreeDeleteDisclosure {
    return describeTreeDeleteDisclosure({
      tree,
      kind: "artifact",
      nodeIds,
      restoreAvailable: true,
    });
  }

  function promotionSentence(nested: string, under: string): string {
    return `${UNDONE} ${nested} nested under ${under} will be kept and moved to the top level.`;
  }

  describe("agents a delete promotes to the top level", () => {
    it("leaves out a child that is itself being deleted", () => {
      const tree = treeFromRecords([
        makeRecord("a", "chat", null),
        makeRecord("b", "chat", "a"),
        makeRecord("c", "terminal-agent", "a"),
      ]);
      expect(agentDelete(tree, ["a"]).description).toBe(
        promotionSentence("2 agents", "it"),
      );
      expect(agentDelete(tree, ["a", "b"]).description).toBe(
        promotionSentence("1 agent", "them"),
      );
      expect(agentDelete(tree, ["a", "b", "c"]).description).toBe(UNDONE);
    });

    /** Depth comes out of the same rule: the parent is the one going away. */
    it("counts a grandchild once its own parent is selected too", () => {
      const tree = treeFromRecords([
        makeRecord("a", "chat", null),
        makeRecord("b", "chat", "a"),
        makeRecord("c", "chat", "b"),
      ]);
      expect(agentDelete(tree, ["a"]).description).toBe(
        promotionSentence("1 agent", "it"),
      );
      expect(agentDelete(tree, ["a", "b"]).description).toBe(
        promotionSentence("1 agent", "them"),
      );
    });

    it("adds up across several selected parents", () => {
      const tree = treeFromRecords([
        makeRecord("a", "chat", null),
        makeRecord("b", "chat", "a"),
        makeRecord("t", "terminal-agent", null),
        makeRecord("u", "terminal-agent", "t"),
      ]);
      expect(agentDelete(tree, ["a", "t"]).description).toBe(
        promotionSentence("2 agents", "them"),
      );
    });

    it("counts the agents nested under a terminal agent", () => {
      const tree = treeFromRecords([
        makeRecord("t", "terminal-agent", null),
        makeRecord("u", "terminal-agent", "t"),
        makeRecord("v", "chat", "t"),
      ]);
      expect(agentDelete(tree, ["t"]).description).toBe(
        promotionSentence("2 agents", "it"),
      );
    });

    /** A repeated id is one row: one child, and still addressed as "it". */
    it("reads the selection as a set", () => {
      const tree = treeFromRecords([
        makeRecord("a", "chat", null),
        makeRecord("b", "chat", "a"),
      ]);
      expect(agentDelete(tree, ["a", "a"]).description).toBe(
        promotionSentence("1 agent", "it"),
      );
    });

    /**
     * The promotion is a description, never a count paragraph: nothing is
     * destroyed beyond the rows picked, so "This will also delete" would be a
     * false claim about an agent that survives.
     */
    it("never carries a cascade count", () => {
      const tree = treeFromRecords([
        makeRecord("a", "chat", null),
        makeRecord("b", "chat", "a"),
      ]);
      expect(agentDelete(tree, ["a"]).cascadeSummary).toBeNull();
    });

    it("says only that the delete cannot be undone for a leaf, an empty selection and an unknown id", () => {
      const tree = treeFromRecords([makeRecord("a", "chat", null)]);
      expect(agentDelete(tree, ["a"]).description).toBe(UNDONE);
      expect(agentDelete(tree, []).description).toBe(UNDONE);
      expect(agentDelete(tree, ["missing"]).description).toBe(UNDONE);
    });
  });

  describe("artifacts a delete takes with it", () => {
    it("counts every depth of the subtree, and nothing outside it", () => {
      const tree = treeFromRecords([
        makeRecord("root", "spec", null),
        makeRecord("child-spec", "spec", "root"),
        makeRecord("g-ticket", "ticket", "child-spec"),
        makeRecord("g-story", "story", "child-spec"),
        makeRecord("other", "spec", null),
        makeRecord("other-ticket", "ticket", "other"),
      ]);

      expect(artifactDelete(tree, ["root"])).toEqual({
        description: UNDONE,
        cascadeSummary: "1 spec, 1 ticket, and 1 story",
        cascadeNestedUnder: "it",
      });
    });

    it("owes no count for an artifact with nothing under it", () => {
      const tree = treeFromRecords([makeRecord("root", "spec", null)]);
      expect(artifactDelete(tree, ["root"]).cascadeSummary).toBeNull();
    });

    it.each([
      ["2 specs", ["spec", "spec"]],
      ["1 story", ["story"]],
      ["2 stories", ["story", "story"]],
      ["2 pages", ["html", "html"]],
      ["2 canvases", ["canvas", "canvas"]],
      ["1 spec and 1 story", ["spec", "story"]],
      [
        "1 spec, 2 tickets, and 1 review",
        ["spec", "ticket", "ticket", "review"],
      ],
    ] as const)("words the subtree as %s", (summary, childTypes) => {
      const tree = treeFromRecords([
        makeRecord("root", "spec", null),
        ...childTypes.map((type, index) =>
          makeRecord(`child-${String(index)}`, type, "root"),
        ),
      ]);
      expect(artifactDelete(tree, ["root"]).cascadeSummary).toBe(summary);
    });

    /** "ALSO delete" is what the selection does not already name. */
    it("does not count a descendant that is itself selected", () => {
      const tree = treeFromRecords([
        makeRecord("spec-root", "spec", null),
        makeRecord("ticket-child", "ticket", "spec-root"),
      ]);
      expect(artifactDelete(tree, ["spec-root"]).cascadeSummary).toBe(
        "1 ticket",
      );
      expect(artifactDelete(tree, ["spec-root", "ticket-child"])).toEqual({
        description: UNDONE,
        cascadeSummary: null,
        cascadeNestedUnder: "them",
      });
    });

    /** Skipping a selected child must not skip its subtree. */
    it("still counts what hangs under a selected descendant", () => {
      const tree = treeFromRecords([
        makeRecord("spec-root", "spec", null),
        makeRecord("ticket-child", "ticket", "spec-root"),
        makeRecord("story-grandchild", "story", "ticket-child"),
      ]);
      expect(
        artifactDelete(tree, ["spec-root", "ticket-child"]).cascadeSummary,
      ).toBe("1 story");
    });

    it("counts a node reached from two selected roots once", () => {
      const tree: TreeSlice = {
        rootIds: ["a", "b"],
        childrenByParent: { a: ["shared"], b: ["shared"] },
        nodeById: {
          a: treeNodeOfType("a", "spec"),
          b: treeNodeOfType("b", "spec"),
          shared: treeNodeOfType("shared", "ticket"),
        },
      };
      expect(artifactDelete(tree, ["a", "b"]).cascadeSummary).toBe("1 ticket");
    });

    it("terminates on a cyclic childrenByParent instead of looping forever", () => {
      const tree: TreeSlice = {
        rootIds: ["a"],
        childrenByParent: { a: ["b"], b: ["a"] },
        nodeById: {
          a: treeNodeOfType("a", "spec"),
          b: treeNodeOfType("b", "ticket"),
        },
      };
      expect(artifactDelete(tree, ["a"]).cascadeSummary).toBe("1 ticket");
    });
  });

  /**
   * A restore takes one artifact, so nested artifacts are not gone for good and
   * do not come back with their parent either. The sentence says both, and the
   * count paragraph is untouched.
   */
  describe("where the host can bring artifacts back", () => {
    const tree = treeFromRecords([
      makeRecord("leaf", "spec", null),
      makeRecord("other-leaf", "spec", null),
      makeRecord("parent", "spec", null),
      makeRecord("ticket", "ticket", "parent"),
    ]);

    it("offers the restore for one artifact with nothing under it", () => {
      expect(restorableArtifactDelete(tree, ["leaf"])).toEqual({
        description: "You can bring it back from Deleted artifacts.",
        cascadeSummary: null,
        cascadeNestedUnder: "it",
      });
    });

    it("says nested artifacts come back separately, beside their count", () => {
      expect(restorableArtifactDelete(tree, ["parent"])).toEqual({
        description:
          "You can bring it back from Deleted artifacts. Artifacts nested under it come back separately.",
        cascadeSummary: "1 ticket",
        cascadeNestedUnder: "it",
      });
    });

    it("says a selection comes back one at a time", () => {
      expect(
        restorableArtifactDelete(tree, ["leaf", "other-leaf"]).description,
      ).toBe("You can bring them back one at a time from Deleted artifacts.");
      expect(
        restorableArtifactDelete(tree, ["leaf", "parent"]).description,
      ).toBe(
        "You can bring them back one at a time from Deleted artifacts. Artifacts nested under them come back separately.",
      );
    });

    /** A row the reader also picked is not nested under anything extra. */
    it("owes no nested sentence when the selection holds the whole subtree", () => {
      expect(
        restorableArtifactDelete(tree, ["parent", "ticket"]).description,
      ).toBe("You can bring them back one at a time from Deleted artifacts.");
    });

    it("offers nothing for an empty selection", () => {
      expect(restorableArtifactDelete(tree, []).description).toBe(UNDONE);
    });
  });

  /**
   * The agent record planes can leave a persisted child out of the tree for a
   * window, so a number read off it would be low. The sentence then names
   * the consequence and states none - it never tells the reader a child does
   * not exist, and it never refuses the delete.
   *
   * Artifacts have no counterpart here on purpose: the arm takes no readiness
   * input, because an artifact's subtree is artifacts (the projector is
   * family-separated) and artifacts are doc-sourced with no record plane to
   * lag behind. Hedging there would assert destruction on a signal that says
   * nothing about it - see the artifact cases above, which state their exact
   * count with no flag to set.
   */
  describe("while the nested agents have not all arrived", () => {
    function pendingAgentDelete(
      tree: TreeSlice,
      nodeIds: readonly string[],
    ): TreeDeleteDisclosure {
      return describeTreeDeleteDisclosure({
        tree,
        kind: "agent",
        nodeIds,
        nestedAgentsKnown: false,
      });
    }

    it("names the promotion without a count, even for a row the tree shows as a leaf", () => {
      const tree = treeFromRecords([makeRecord("a", "chat", null)]);
      expect(pendingAgentDelete(tree, ["a"])).toEqual({
        description: `${UNDONE} Any agents nested under it will be kept and moved to the top level.`,
        cascadeSummary: null,
        cascadeNestedUnder: "it",
      });
    });

    it("addresses a selection as them", () => {
      const tree = treeFromRecords([
        makeRecord("a", "chat", null),
        makeRecord("t", "terminal-agent", null),
      ]);
      expect(pendingAgentDelete(tree, ["a", "t"]).description).toBe(
        `${UNDONE} Any agents nested under them will be kept and moved to the top level.`,
      );
    });

    /** Nothing is selected, so there is nothing for anything to be nested in. */
    it("says only that the delete cannot be undone for an empty selection", () => {
      const tree = treeFromRecords([makeRecord("a", "chat", null)]);
      expect(pendingAgentDelete(tree, []).description).toBe(UNDONE);
    });
  });
});

function treeNodeOfType(id: string, type: TreeNode["type"]): TreeNode {
  return {
    id,
    parentId: null,
    title: id,
    type,
    status: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
