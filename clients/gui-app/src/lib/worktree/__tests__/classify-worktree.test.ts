import { describe, expect, it } from "vitest";
import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV11,
} from "@traycer/protocol/host/index";
import {
  WORKTREE_TIER_ORDER,
  classifyWorktree,
  classifyWorktreeTier,
  isEvidenceProvenRemovable,
  isPrimarySweepEligible,
  isSecondarySweepEligible,
  worktreeTierRank,
  type WorktreeTier,
} from "@/lib/worktree/classify-worktree";

function status(over: Partial<WorktreeBranchStatus>): WorktreeBranchStatus {
  return { ahead: 0, behind: 0, mergedIntoDefault: false, ...over };
}

function owner(epicId: string) {
  return {
    epicId,
    ownerKind: "chat" as const,
    ownerId: `chat-${epicId}`,
    updatedAt: 1,
  };
}

function entry(over: Partial<WorktreeHostEntryV11>): WorktreeHostEntryV11 {
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
    ...over,
  };
}

describe("classifyWorktreeTier - canonical ladder (first match wins)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly entry: WorktreeHostEntryV11;
    readonly tier: WorktreeTier;
  }> = [
    {
      name: "inUse wins over every other signal",
      entry: entry({
        inUse: true,
        gitRemovable: false,
        uncommittedCount: 5,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "in-use",
    },
    {
      name: "orphan (gitRemovable:false) is checked BEFORE review, even with null status",
      entry: entry({ gitRemovable: false, branchStatus: null }),
      tier: "orphaned",
    },
    {
      name: "orphan wins even when dirty",
      entry: entry({ gitRemovable: false, uncommittedCount: 2 }),
      tier: "orphaned",
    },
    {
      name: "dirty (uncommitted > 0) → review",
      entry: entry({
        uncommittedCount: 1,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "review",
    },
    {
      name: "ahead and not merged → review",
      entry: entry({ branchStatus: status({ ahead: 2 }) }),
      tier: "review",
    },
    {
      name: "null branchStatus → review",
      entry: entry({ branchStatus: null }),
      tier: "review",
    },
    {
      name: "detached HEAD (branch === null) → review, even when merged and clean",
      entry: entry({
        branch: null,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "review",
    },
    {
      name: "referenced (owners > 0), clean, ahead 0, not merged → review (owners gate)",
      entry: entry({
        owners: [owner("epic-1")],
        branchStatus: status({ ahead: 0, mergedIntoDefault: false }),
      }),
      tier: "review",
    },
    {
      name: "merged-but-referenced → merged (merge proof beats owners gate)",
      entry: entry({
        owners: [owner("epic-1")],
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "merged",
    },
    {
      name: "clean + merged, no owners → merged",
      entry: entry({ branchStatus: status({ mergedIntoDefault: true }) }),
      tier: "merged",
    },
    {
      name: "never-pushed + contained (null ahead/behind, merged) → merged (the win)",
      entry: entry({
        branchStatus: status({
          ahead: null,
          behind: null,
          mergedIntoDefault: true,
        }),
      }),
      tier: "merged",
    },
    {
      name: "never-pushed + diverged (null ahead, not merged) → review, NEVER unreferenced",
      entry: entry({
        branchStatus: status({
          ahead: null,
          behind: null,
          mergedIntoDefault: false,
        }),
      }),
      tier: "review",
    },
    {
      name: "never-pushed + contained but referenced → merged (proof beats owners, no upstream)",
      entry: entry({
        owners: [owner("epic-1")],
        branchStatus: status({
          ahead: null,
          behind: null,
          mergedIntoDefault: true,
        }),
      }),
      tier: "merged",
    },
    {
      name: "merged proof holds even with behind > 0",
      entry: entry({
        branchStatus: status({ behind: 4, mergedIntoDefault: true }),
      }),
      tier: "merged",
    },
    {
      name: "clean + non-null + ahead 0 + no owners + not merged → unreferenced",
      entry: entry({ branchStatus: status({ ahead: 0 }) }),
      tier: "unreferenced",
    },
    {
      name: "unreferenced holds when only behind (behind alone is not ahead)",
      entry: entry({ branchStatus: status({ ahead: 0, behind: 3 }) }),
      tier: "unreferenced",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(classifyWorktreeTier(testCase.entry)).toBe(testCase.tier);
    });
  }

  it("classifyWorktree returns the matching label and facts", () => {
    const merged = classifyWorktree(
      entry({ branchStatus: status({ mergedIntoDefault: true }) }),
    );
    expect(merged.tier).toBe("merged");
    expect(merged.label).toBe("Merged");
    expect(merged.facts).toContain("merged");
    expect(merged.facts).toContain("clean");

    const dirty = classifyWorktree(entry({ uncommittedCount: 3 }));
    expect(dirty.tier).toBe("review");
    expect(dirty.facts).toContain("3 uncommitted changes");
    expect(dirty.facts).not.toContain("clean");

    const detached = classifyWorktree(
      entry({ branch: null, branchStatus: status({ ahead: 1 }) }),
    );
    expect(detached.facts).toContain("detached HEAD");

    // Never-pushed + contained: the "merged" fact shows, and null ahead/behind
    // render nothing (never "0 ahead" / NaN).
    const neverPushedMerged = classifyWorktree(
      entry({
        branchStatus: status({
          ahead: null,
          behind: null,
          mergedIntoDefault: true,
        }),
      }),
    );
    expect(neverPushedMerged.tier).toBe("merged");
    expect(neverPushedMerged.facts).toContain("merged");
    expect(neverPushedMerged.facts).toContain("clean");
    expect(neverPushedMerged.facts.some((f) => f.includes("ahead"))).toBe(
      false,
    );
    expect(neverPushedMerged.facts.some((f) => f.includes("behind"))).toBe(
      false,
    );
  });
});

describe("worktree tier ordering", () => {
  it("ranks safe-first: merged, unreferenced, review, orphaned, in-use", () => {
    expect(WORKTREE_TIER_ORDER).toEqual([
      "merged",
      "unreferenced",
      "review",
      "orphaned",
      "in-use",
    ]);
    expect(worktreeTierRank("merged")).toBeLessThan(
      worktreeTierRank("unreferenced"),
    );
    expect(worktreeTierRank("unreferenced")).toBeLessThan(
      worktreeTierRank("review"),
    );
    expect(worktreeTierRank("review")).toBeLessThan(
      worktreeTierRank("orphaned"),
    );
    expect(worktreeTierRank("orphaned")).toBeLessThan(
      worktreeTierRank("in-use"),
    );
  });
});

describe("isPrimarySweepEligible", () => {
  it("accepts proven-merged and clean-not-ahead-unreferenced", () => {
    expect(
      isPrimarySweepEligible(
        entry({ branchStatus: status({ mergedIntoDefault: true }) }),
      ),
    ).toBe(true);
    expect(
      isPrimarySweepEligible(entry({ branchStatus: status({ ahead: 0 }) })),
    ).toBe(true);
    // merged proof stands regardless of owners.
    expect(
      isPrimarySweepEligible(
        entry({
          owners: [owner("epic-1")],
          branchStatus: status({ mergedIntoDefault: true }),
        }),
      ),
    ).toBe(true);
  });

  it("never-pushed: contained is primary-eligible, diverged is not", () => {
    expect(
      isPrimarySweepEligible(
        entry({
          branchStatus: status({
            ahead: null,
            behind: null,
            mergedIntoDefault: true,
          }),
        }),
      ),
    ).toBe(true);
    // Null ahead is not a proven `ahead === 0`, so a diverged never-pushed
    // branch is never bulk-swept.
    expect(
      isPrimarySweepEligible(
        entry({
          branchStatus: status({
            ahead: null,
            behind: null,
            mergedIntoDefault: false,
          }),
        }),
      ),
    ).toBe(false);
  });

  it("rejects referenced-not-merged, dirty, null status, in-use, orphan", () => {
    expect(
      isPrimarySweepEligible(
        entry({
          owners: [owner("epic-1")],
          branchStatus: status({ ahead: 0 }),
        }),
      ),
    ).toBe(false);
    expect(
      isPrimarySweepEligible(
        entry({ uncommittedCount: 1, branchStatus: status({ ahead: 0 }) }),
      ),
    ).toBe(false);
    expect(isPrimarySweepEligible(entry({ branchStatus: null }))).toBe(false);
    expect(
      isPrimarySweepEligible(
        entry({
          inUse: true,
          branchStatus: status({ mergedIntoDefault: true }),
        }),
      ),
    ).toBe(false);
    expect(
      isPrimarySweepEligible(
        entry({
          gitRemovable: false,
          branchStatus: status({ mergedIntoDefault: true }),
        }),
      ),
    ).toBe(false);
  });
});

describe("isSecondarySweepEligible", () => {
  it("accepts named-branch, clean, unreferenced, null status", () => {
    expect(isSecondarySweepEligible(entry({ branchStatus: null }))).toBe(true);
  });

  it("rejects detached HEAD, referenced, dirty, non-null status, orphan, in-use", () => {
    expect(
      isSecondarySweepEligible(entry({ branch: null, branchStatus: null })),
    ).toBe(false);
    expect(
      isSecondarySweepEligible(
        entry({ owners: [owner("epic-1")], branchStatus: null }),
      ),
    ).toBe(false);
    expect(
      isSecondarySweepEligible(
        entry({ uncommittedCount: 2, branchStatus: null }),
      ),
    ).toBe(false);
    expect(
      isSecondarySweepEligible(entry({ branchStatus: status({ ahead: 0 }) })),
    ).toBe(false);
    expect(
      isSecondarySweepEligible(
        entry({ gitRemovable: false, branchStatus: null }),
      ),
    ).toBe(false);
    expect(
      isSecondarySweepEligible(entry({ inUse: true, branchStatus: null })),
    ).toBe(false);
  });

  it("primary and secondary cohorts never overlap (null vs non-null status)", () => {
    const nullStatus = entry({ branchStatus: null });
    expect(isSecondarySweepEligible(nullStatus)).toBe(true);
    expect(isPrimarySweepEligible(nullStatus)).toBe(false);
    const proven = entry({ branchStatus: status({ mergedIntoDefault: true }) });
    expect(isPrimarySweepEligible(proven)).toBe(true);
    expect(isSecondarySweepEligible(proven)).toBe(false);
  });
});

describe("isEvidenceProvenRemovable (Task-delete default-check rule)", () => {
  it("true only when clean and non-null status that is merged or not ahead", () => {
    expect(
      isEvidenceProvenRemovable({
        uncommittedCount: 0,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
    ).toBe(true);
    expect(
      isEvidenceProvenRemovable({
        uncommittedCount: 0,
        branchStatus: status({ ahead: 0 }),
      }),
    ).toBe(true);
  });

  it("never-pushed: contained → proven removable, diverged → not", () => {
    // Never-pushed + contained is proven by the upstream-free merge proof.
    expect(
      isEvidenceProvenRemovable({
        uncommittedCount: 0,
        branchStatus: status({
          ahead: null,
          behind: null,
          mergedIntoDefault: true,
        }),
      }),
    ).toBe(true);
    // Never-pushed + diverged: null ahead is NOT `ahead === 0`, so unproven.
    expect(
      isEvidenceProvenRemovable({
        uncommittedCount: 0,
        branchStatus: status({
          ahead: null,
          behind: null,
          mergedIntoDefault: false,
        }),
      }),
    ).toBe(false);
  });

  it("false for null status (unproven), dirty, or ahead-not-merged", () => {
    expect(
      isEvidenceProvenRemovable({ uncommittedCount: 0, branchStatus: null }),
    ).toBe(false);
    expect(
      isEvidenceProvenRemovable({
        uncommittedCount: 2,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
    ).toBe(false);
    expect(
      isEvidenceProvenRemovable({
        uncommittedCount: 0,
        branchStatus: status({ ahead: 3 }),
      }),
    ).toBe(false);
  });
});
