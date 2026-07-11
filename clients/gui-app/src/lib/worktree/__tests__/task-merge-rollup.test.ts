import { describe, expect, it } from "vitest";
import type {
  WorktreeHostEntryV12,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/index";
import {
  buildTaskMergeRollups,
  computeTaskMergeRollup,
  taskMergeRollupLabel,
} from "@/lib/worktree/task-merge-rollup";

function owner(epicId: string) {
  return {
    epicId,
    ownerKind: "chat" as const,
    ownerId: `chat-${epicId}`,
    updatedAt: 1,
  };
}

/**
 * Owned-submodule merge fact. Defaults to the "no signal" shape (no PR, no HEAD
 * match); each test opts into the fields it exercises.
 */
function submodule(
  over: Partial<WorktreeSubmoduleMergeFactV12>,
): WorktreeSubmoduleMergeFactV12 {
  return {
    repoIdentifier: { owner: "acme", repo: "sub" },
    branch: "feat/x",
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    mergedIntoDefault: false,
    atPinnedCommit: false,
    ...over,
  };
}

/**
 * Superproject listing entry. Merge-provenance fields default to the "no
 * signal / v1.0 or pre-M4 host" shape (null PR bundle, `[]` submodules) that
 * claims nothing.
 */
function entry(over: Partial<WorktreeHostEntryV12>): WorktreeHostEntryV12 {
  return {
    worktreePath: "/wt/x",
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch: "feat/x",
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    ...over,
  };
}

describe("computeTaskMergeRollup - True-AND across superproject + submodules", () => {
  it("all owned branches merged (superproject + submodule) → Merged", () => {
    const rollup = computeTaskMergeRollup([
      entry({
        prState: "merged",
        prNumber: 1,
        mergedHeadShaMatches: true,
        submodules: [
          submodule({
            prState: "merged",
            prNumber: 2,
            mergedHeadShaMatches: true,
          }),
        ],
      }),
    ]);
    expect(rollup).toEqual({ status: "merged", merged: 2, total: 2 });
    expect(taskMergeRollupLabel(rollup)).toBe("Merged");
  });

  it("superproject unmerged (PR still open) + submodule merged → partial 1/2 [gitlink-bump pending]", () => {
    const rollup = computeTaskMergeRollup([
      entry({
        // Gitlink bump PR is open, not merged - HEAD does not match a merged SHA.
        prState: "open",
        prNumber: 10,
        mergedHeadShaMatches: false,
        submodules: [
          submodule({
            prState: "merged",
            prNumber: 11,
            mergedHeadShaMatches: true,
          }),
        ],
      }),
    ]);
    expect(rollup).toEqual({ status: "partial", merged: 1, total: 2 });
    expect(taskMergeRollupLabel(rollup)).toBe("Merged 1/2");
  });

  it("superproject with NO PR yet + submodule merged → still partial 1/2, never Merged", () => {
    const rollup = computeTaskMergeRollup([
      entry({
        // Probe ran, found no superproject PR at all.
        prState: "none",
        mergedHeadShaMatches: false,
        submodules: [
          submodule({
            prState: "merged",
            prNumber: 3,
            mergedHeadShaMatches: true,
          }),
        ],
      }),
    ]);
    expect(rollup).toEqual({ status: "partial", merged: 1, total: 2 });
  });

  it("merged PR whose live HEAD moved off the merged SHA does NOT count as merged", () => {
    const rollup = computeTaskMergeRollup([
      entry({
        prState: "merged",
        prNumber: 4,
        // Host live-HEAD comparison failed → not a green branch.
        mergedHeadShaMatches: false,
        submodules: [
          submodule({
            prState: "merged",
            prNumber: 5,
            mergedHeadShaMatches: true,
          }),
        ],
      }),
    ]);
    expect(rollup).toEqual({ status: "partial", merged: 1, total: 2 });
  });

  it("no PR anywhere in the set → no merged claim (none)", () => {
    const rollup = computeTaskMergeRollup([
      entry({
        prState: "none",
        submodules: [submodule({ prState: "none" })],
      }),
    ]);
    expect(rollup).toEqual({ status: "none" });
    expect(taskMergeRollupLabel(rollup)).toBeNull();
  });

  it("open PR present but nothing merged → none (never over-claims 'Merged 0/N')", () => {
    const rollup = computeTaskMergeRollup([
      entry({
        prState: "open",
        prNumber: 6,
        submodules: [submodule({ prState: "open", prNumber: 7 })],
      }),
    ]);
    expect(rollup).toEqual({ status: "none" });
  });

  it("mixed counts across three owned branches → Merged 2/3", () => {
    const rollup = computeTaskMergeRollup([
      entry({
        prState: "merged",
        prNumber: 20,
        mergedHeadShaMatches: true,
        submodules: [
          submodule({
            repoIdentifier: { owner: "acme", repo: "sub-a" },
            prState: "merged",
            prNumber: 21,
            mergedHeadShaMatches: true,
          }),
          submodule({
            repoIdentifier: { owner: "acme", repo: "sub-b" },
            prState: "open",
            prNumber: 22,
          }),
        ],
      }),
    ]);
    expect(rollup).toEqual({ status: "partial", merged: 2, total: 3 });
    expect(taskMergeRollupLabel(rollup)).toBe("Merged 2/3");
  });

  it("degrades cleanly: empty submodules[] + no PR facts (pre-M4 / gh absent) → none, no crash", () => {
    const rollup = computeTaskMergeRollup([entry({})]);
    expect(rollup).toEqual({ status: "none" });
  });

  it("degrades cleanly: empty entry set → none", () => {
    expect(computeTaskMergeRollup([])).toEqual({ status: "none" });
  });

  it("superproject-only merged PR, no submodules → Merged 1/1", () => {
    const rollup = computeTaskMergeRollup([
      entry({ prState: "merged", prNumber: 8, mergedHeadShaMatches: true }),
    ]);
    expect(rollup).toEqual({ status: "merged", merged: 1, total: 1 });
    expect(taskMergeRollupLabel(rollup)).toBe("Merged");
  });

  it("aggregates across multiple worktree entries a Task owns (True-AND spans entries)", () => {
    // A Task owning two superproject worktrees: one fully merged, one still open.
    // True-AND ⇒ the Task is only partial until BOTH land.
    const rollup = computeTaskMergeRollup([
      entry({
        worktreePath: "/wt/a",
        prState: "merged",
        prNumber: 30,
        mergedHeadShaMatches: true,
      }),
      entry({
        worktreePath: "/wt/b",
        repoIdentifier: { owner: "acme", repo: "other" },
        prState: "open",
        prNumber: 31,
      }),
    ]);
    expect(rollup).toEqual({ status: "partial", merged: 1, total: 2 });
  });
});

describe("buildTaskMergeRollups - per-epic aggregation over a host listing", () => {
  it("buckets entries by owning epic and rolls each up independently", () => {
    const merged = entry({
      worktreePath: "/wt/merged",
      owners: [owner("epic-merged")],
      prState: "merged",
      prNumber: 40,
      mergedHeadShaMatches: true,
    });
    const partial = entry({
      worktreePath: "/wt/partial",
      owners: [owner("epic-partial")],
      prState: "open",
      prNumber: 41,
      submodules: [
        submodule({
          prState: "merged",
          prNumber: 42,
          mergedHeadShaMatches: true,
        }),
      ],
    });
    const rollups = buildTaskMergeRollups([merged, partial]);
    expect(rollups.get("epic-merged")).toEqual({
      status: "merged",
      merged: 1,
      total: 1,
    });
    expect(rollups.get("epic-partial")).toEqual({
      status: "partial",
      merged: 1,
      total: 2,
    });
  });

  it("a Task owning two entries rolls both into one shared True-AND signal", () => {
    const a = entry({
      worktreePath: "/wt/a",
      owners: [owner("epic-multi")],
      prState: "merged",
      prNumber: 50,
      mergedHeadShaMatches: true,
    });
    const b = entry({
      worktreePath: "/wt/b",
      owners: [owner("epic-multi")],
      prState: "open",
      prNumber: 51,
    });
    const rollups = buildTaskMergeRollups([a, b]);
    expect(rollups.get("epic-multi")).toEqual({
      status: "partial",
      merged: 1,
      total: 2,
    });
  });

  it("dedupes an entry's multiple owners of the same epic (counts the entry once)", () => {
    const shared = entry({
      worktreePath: "/wt/shared",
      owners: [owner("epic-dup"), owner("epic-dup")],
      prState: "merged",
      prNumber: 60,
      mergedHeadShaMatches: true,
    });
    const rollups = buildTaskMergeRollups([shared]);
    expect(rollups.get("epic-dup")).toEqual({
      status: "merged",
      merged: 1,
      total: 1,
    });
  });

  it("entries with no owners contribute no epic buckets", () => {
    expect(buildTaskMergeRollups([entry({})]).size).toBe(0);
  });
});
