import { describe, expect, it } from "vitest";
import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV12,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/index";
import {
  WORKTREE_TIER_ORDER,
  classifyWorktree,
  classifyWorktreeTier,
  provenRemovable,
  worktreeTierRank,
  type WorktreeTier,
} from "@traycer-clients/shared/worktree/classify-worktree";

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

function subFact(
  over: Partial<WorktreeSubmoduleMergeFactV12>,
): WorktreeSubmoduleMergeFactV12 {
  return {
    repoIdentifier: { owner: "acme", repo: "lib" },
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
    // v1.1 merge-provenance fields default to the "no signal / v1.0 host" shape:
    // a null/false bundle that greens nothing. Each test opts into the fields it
    // exercises.
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    ...over,
  };
}

describe("classifyWorktreeTier - precedence truth table (first match wins)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly entry: WorktreeHostEntryV12;
    readonly tier: WorktreeTier;
  }> = [
    {
      name: "inUse wins over every other signal",
      entry: entry({
        inUse: true,
        gitRemovable: false,
        uncommittedCount: 5,
        branchStatus: status({ mergedIntoDefault: true }),
        prState: "merged",
        mergedHeadShaMatches: true,
        atBaseCommit: true,
      }),
      tier: "in-use",
    },
    {
      name: "orphan (gitRemovable:false) is checked BEFORE the greens, even when merged",
      entry: entry({
        gitRemovable: false,
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
      tier: "orphaned",
    },
    {
      name: "orphan wins even when dirty",
      entry: entry({ gitRemovable: false, uncommittedCount: 2 }),
      tier: "orphaned",
    },
    {
      name: "dirty gate sits ABOVE every green: merged PR + dirty → review",
      entry: entry({
        uncommittedCount: 1,
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
      tier: "review",
    },
    {
      name: "dirty + local-merged → review",
      entry: entry({
        uncommittedCount: 1,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "review",
    },
    {
      name: "dirty + atBaseCommit → review",
      entry: entry({ uncommittedCount: 3, atBaseCommit: true }),
      tier: "review",
    },
    // --- Landed (PR provenance) ---
    {
      name: "prState merged AND mergedHeadShaMatches → merged (PR)",
      entry: entry({ prState: "merged", mergedHeadShaMatches: true }),
      tier: "merged",
    },
    {
      name: "prState merged WITHOUT mergedHeadShaMatches → NOT green (falls through to review)",
      entry: entry({
        prState: "merged",
        mergedHeadShaMatches: false,
        branchStatus: status({ ahead: 2 }),
      }),
      tier: "review",
    },
    {
      name: "prState merged, HEAD moved (ahead>0), but shaMatches false → review, never PR-green",
      entry: entry({
        prState: "merged",
        mergedHeadShaMatches: false,
        prNumber: 42,
        branchStatus: status({ ahead: 3, mergedIntoDefault: false }),
      }),
      tier: "review",
    },
    {
      name: "squash-merged PR: shaMatches true even though locally ahead>0 → merged (PR beats ahead)",
      entry: entry({
        prState: "merged",
        mergedHeadShaMatches: true,
        prNumber: 7,
        branchStatus: status({ ahead: 4, mergedIntoDefault: false }),
      }),
      tier: "merged",
    },
    {
      name: "prState open + mergedHeadShaMatches false → no PR green",
      entry: entry({
        prState: "open",
        mergedHeadShaMatches: false,
        branchStatus: status({ ahead: 1 }),
      }),
      tier: "review",
    },
    {
      name: "prState closed (not merged) → no PR green",
      entry: entry({
        prState: "closed",
        mergedHeadShaMatches: false,
        branchStatus: status({ ahead: 1 }),
      }),
      tier: "review",
    },
    // --- Landed (local ancestry) --- (worked-then-merged: NOT at base)
    {
      name: "clean + mergedIntoDefault, no owners, NOT at base → merged (local)",
      entry: entry({
        atBaseCommit: false,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "merged",
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
      name: "never-pushed + contained (null ahead/behind, merged) → merged",
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
      name: "merged proof holds even with behind > 0",
      entry: entry({
        branchStatus: status({ behind: 4, mergedIntoDefault: true }),
      }),
      tier: "merged",
    },
    // --- At base commit ---
    {
      name: "atBaseCommit true (no PR, no local merge, null status) → at-base-commit",
      entry: entry({ atBaseCommit: true, branchStatus: null }),
      tier: "at-base-commit",
    },
    {
      name: "atBaseCommit true even with owners (deletion loses nothing committed)",
      entry: entry({ atBaseCommit: true, owners: [owner("epic-1")] }),
      tier: "at-base-commit",
    },
    {
      name: "atBaseCommit true with an OPEN PR still greens as at-base",
      entry: entry({
        atBaseCommit: true,
        prState: "open",
        mergedHeadShaMatches: false,
      }),
      tier: "at-base-commit",
    },
    {
      name: "atBaseCommit false, no other proof → review",
      entry: entry({ atBaseCommit: false, branchStatus: null }),
      tier: "review",
    },
    {
      // PRECEDENCE PIN: the common never-touched worktree. Its base is in the
      // default branch, so `mergedIntoDefault` is ALSO true - at-base MUST win so
      // it reads the honest "At base commit", never the stronger "Landed" label.
      name: "at-base beats merged(local) when both set → at-base-commit (never Landed)",
      entry: entry({
        atBaseCommit: true,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "at-base-commit",
    },
    {
      // A validated merged PR is authoritative and still wins over at-base.
      name: "merged PR beats at-base when both set → merged (PR is highest)",
      entry: entry({
        atBaseCommit: true,
        prState: "merged",
        mergedHeadShaMatches: true,
        prNumber: 9,
      }),
      tier: "merged",
    },
    // --- Detached guard (kept above greens) ---
    {
      name: "detached HEAD stays review even when local-merged and clean",
      entry: entry({
        branch: null,
        branchStatus: status({ mergedIntoDefault: true }),
      }),
      tier: "review",
    },
    {
      name: "detached HEAD stays review even with a merged PR match",
      entry: entry({
        branch: null,
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
      tier: "review",
    },
    {
      name: "detached HEAD stays review even when atBaseCommit",
      entry: entry({ branch: null, atBaseCommit: true }),
      tier: "review",
    },
    // --- Owned-submodule gate (blocks every green) ---
    {
      name: "unproven submodule blocks a merged-PR green → review",
      entry: entry({
        prState: "merged",
        mergedHeadShaMatches: true,
        submodules: [subFact({})],
      }),
      tier: "review",
    },
    {
      name: "unproven submodule blocks at-base → review (gitlink never bumped, submodule work unmerged)",
      entry: entry({ atBaseCommit: true, submodules: [subFact({})] }),
      tier: "review",
    },
    {
      name: "unproven submodule blocks local-ancestry merged → review",
      entry: entry({
        branchStatus: status({ mergedIntoDefault: true }),
        submodules: [subFact({ prState: "open", prNumber: 12 })],
      }),
      tier: "review",
    },
    {
      name: "unproven submodule blocks unreferenced → review",
      entry: entry({
        branchStatus: status({ ahead: 0 }),
        submodules: [subFact({ prState: "closed" })],
      }),
      tier: "review",
    },
    {
      name: "submodule proven via HEAD-validated merged PR does not block → merged",
      entry: entry({
        prState: "merged",
        mergedHeadShaMatches: true,
        submodules: [
          subFact({ prState: "merged", mergedHeadShaMatches: true }),
        ],
      }),
      tier: "merged",
    },
    {
      name: "submodule proven via local ancestry does not block → at-base-commit",
      entry: entry({
        atBaseCommit: true,
        submodules: [subFact({ mergedIntoDefault: true })],
      }),
      tier: "at-base-commit",
    },
    {
      name: "submodule proven at its pinned gitlink does not block → at-base-commit",
      entry: entry({
        atBaseCommit: true,
        submodules: [subFact({ atPinnedCommit: true })],
      }),
      tier: "at-base-commit",
    },
    {
      name: "submodule atPinnedCommit false proves nothing by itself → review",
      entry: entry({
        atBaseCommit: true,
        submodules: [subFact({ atPinnedCommit: false })],
      }),
      tier: "review",
    },
    {
      name: "one proven + one unproven submodule → review (true AND across the owned set)",
      entry: entry({
        prState: "merged",
        mergedHeadShaMatches: true,
        submodules: [subFact({ mergedIntoDefault: true }), subFact({})],
      }),
      tier: "review",
    },
    {
      name: "submodule merged PR WITHOUT the live-HEAD match proves nothing → review",
      entry: entry({
        atBaseCommit: true,
        submodules: [
          subFact({ prState: "merged", mergedHeadShaMatches: false }),
        ],
      }),
      tier: "review",
    },
    {
      name: "orphan still outranks the submodule gate (label, not bulk safety)",
      entry: entry({ gitRemovable: false, submodules: [subFact({})] }),
      tier: "orphaned",
    },
    // --- Unreferenced (T9, unchanged) ---
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
    {
      name: "referenced (owners > 0), clean, ahead 0, not merged → review (owners gate)",
      entry: entry({
        owners: [owner("epic-1")],
        branchStatus: status({ ahead: 0, mergedIntoDefault: false }),
      }),
      tier: "review",
    },
    // --- Review catch-all ---
    {
      name: "ahead and not merged → review",
      entry: entry({ branchStatus: status({ ahead: 2 }) }),
      tier: "review",
    },
    {
      name: "null branchStatus, no proof → review",
      entry: entry({ branchStatus: null }),
      tier: "review",
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
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(classifyWorktreeTier(testCase.entry)).toBe(testCase.tier);
    });
  }

  it("classifyWorktree returns the matching label and provenance facts", () => {
    const localMerged = classifyWorktree(
      entry({ branchStatus: status({ mergedIntoDefault: true }) }),
    );
    expect(localMerged.tier).toBe("merged");
    expect(localMerged.label).toBe("Landed");
    // Local-ancestry provenance hint, and no stray "merged" duplicate.
    expect(localMerged.facts).toContain("in default");
    expect(localMerged.prFacts).toContain("in default");
    expect(localMerged.nonPrFacts).not.toContain("in default");
    expect(localMerged.facts).toContain("clean");
    expect(localMerged.nonPrFacts).toContain("clean");

    const prMerged = classifyWorktree(
      entry({ prState: "merged", mergedHeadShaMatches: true, prNumber: 123 }),
    );
    expect(prMerged.tier).toBe("merged");
    expect(prMerged.label).toBe("Landed");
    // PR provenance hint carries the number and never "in default".
    expect(prMerged.facts).toContain("PR #123");
    expect(prMerged.prFacts).toContain("PR #123");
    expect(prMerged.nonPrFacts).not.toContain("PR #123");
    expect(prMerged.facts).not.toContain("in default");

    const prMergedNoNumber = classifyWorktree(
      entry({ prState: "merged", mergedHeadShaMatches: true, prNumber: null }),
    );
    expect(prMergedNoNumber.facts).toContain("merged PR");
    expect(prMergedNoNumber.prFacts).toContain("merged PR");
    expect(prMergedNoNumber.nonPrFacts).not.toContain("merged PR");

    const atBase = classifyWorktree(entry({ atBaseCommit: true }));
    expect(atBase.tier).toBe("at-base-commit");
    expect(atBase.label).toBe("At base commit");
    expect(atBase.facts).toContain("clean");

    const dirty = classifyWorktree(entry({ uncommittedCount: 3 }));
    expect(dirty.tier).toBe("review");
    expect(dirty.facts).toContain("3 uncommitted changes");
    expect(dirty.facts).not.toContain("clean");

    const detached = classifyWorktree(
      entry({ branch: null, branchStatus: status({ ahead: 1 }) }),
    );
    expect(detached.facts).toContain("detached HEAD");

    // Unproven submodules are named as the would-be-lost work; an open PR
    // carries its number, proven submodules emit nothing.
    const submoduleBlocked = classifyWorktree(
      entry({
        atBaseCommit: true,
        submodules: [
          subFact({}),
          subFact({
            repoIdentifier: { owner: "acme", repo: "widgets" },
            prState: "open",
            prNumber: 42,
          }),
          subFact({
            repoIdentifier: { owner: "acme", repo: "done" },
            mergedIntoDefault: true,
          }),
        ],
      }),
    );
    expect(submoduleBlocked.tier).toBe("review");
    expect(submoduleBlocked.facts).toContain("submodule acme/lib unmerged");
    expect(submoduleBlocked.prFacts).toContain("submodule acme/lib unmerged");
    expect(submoduleBlocked.nonPrFacts).not.toContain(
      "submodule acme/lib unmerged",
    );
    expect(submoduleBlocked.facts).toContain(
      "submodule acme/widgets PR #42 open",
    );
    expect(submoduleBlocked.prFacts).toContain(
      "submodule acme/widgets PR #42 open",
    );
    expect(submoduleBlocked.nonPrFacts).not.toContain(
      "submodule acme/widgets PR #42 open",
    );
    expect(
      submoduleBlocked.facts.filter((fact) => fact.includes("acme/done")),
    ).toEqual([]);
  });

  it("degrades to today's behavior against a v1.0 / no-PR host (all new fields null/false)", () => {
    // With the merge-provenance bundle at its null/false defaults, only the T9
    // local-ancestry and upstream-tip signals can green - no Landed (PR), no
    // At base commit.
    expect(
      classifyWorktreeTier(
        entry({ branchStatus: status({ mergedIntoDefault: true }) }),
      ),
    ).toBe("merged");
    expect(
      classifyWorktreeTier(entry({ branchStatus: status({ ahead: 0 }) })),
    ).toBe("unreferenced");
    expect(classifyWorktreeTier(entry({ branchStatus: null }))).toBe("review");
    expect(
      classifyWorktreeTier(entry({ branchStatus: status({ ahead: 2 }) })),
    ).toBe("review");
    // No at-base and no PR greens are ever produced from the null/false bundle.
    expect(
      classifyWorktreeTier(entry({ branchStatus: status({ ahead: 5 }) })),
    ).not.toBe("at-base-commit");
  });
});

describe("worktree tier ordering", () => {
  it("ranks safe-first: merged, at-base-commit, unreferenced, review, orphaned, in-use", () => {
    expect(WORKTREE_TIER_ORDER).toEqual([
      "merged",
      "at-base-commit",
      "unreferenced",
      "review",
      "orphaned",
      "in-use",
    ]);
    expect(worktreeTierRank("merged")).toBeLessThan(
      worktreeTierRank("at-base-commit"),
    );
    expect(worktreeTierRank("at-base-commit")).toBeLessThan(
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

describe("provenRemovable - single green / bulk-eligible predicate", () => {
  it("true for exactly the three green tiers", () => {
    // Landed (PR)
    expect(
      provenRemovable(entry({ prState: "merged", mergedHeadShaMatches: true })),
    ).toBe(true);
    // Landed (local ancestry)
    expect(
      provenRemovable(
        entry({ branchStatus: status({ mergedIntoDefault: true }) }),
      ),
    ).toBe(true);
    // At base commit
    expect(provenRemovable(entry({ atBaseCommit: true }))).toBe(true);
    // Unreferenced
    expect(provenRemovable(entry({ branchStatus: status({ ahead: 0 }) }))).toBe(
      true,
    );
  });

  it("false for review / orphaned / in-use and unproven greens", () => {
    // prState merged without the live-HEAD match never greens.
    expect(
      provenRemovable(
        entry({
          prState: "merged",
          mergedHeadShaMatches: false,
          branchStatus: status({ ahead: 1 }),
        }),
      ),
    ).toBe(false);
    // Dirty overrides a merged PR.
    expect(
      provenRemovable(
        entry({
          uncommittedCount: 1,
          prState: "merged",
          mergedHeadShaMatches: true,
        }),
      ),
    ).toBe(false);
    expect(provenRemovable(entry({ branchStatus: null }))).toBe(false);
    expect(provenRemovable(entry({ branchStatus: status({ ahead: 3 }) }))).toBe(
      false,
    );
    expect(
      provenRemovable(
        entry({
          gitRemovable: false,
          branchStatus: status({ mergedIntoDefault: true }),
        }),
      ),
    ).toBe(false);
    expect(
      provenRemovable(
        entry({
          inUse: true,
          branchStatus: status({ mergedIntoDefault: true }),
        }),
      ),
    ).toBe(false);
    // Detached is never green in this pass, even with positive proof.
    expect(
      provenRemovable(
        entry({ branch: null, prState: "merged", mergedHeadShaMatches: true }),
      ),
    ).toBe(false);
    // An unproven owned-submodule branch blocks bulk eligibility outright.
    expect(
      provenRemovable(
        entry({
          prState: "merged",
          mergedHeadShaMatches: true,
          submodules: [subFact({})],
        }),
      ),
    ).toBe(false);
  });

  it("agrees with the pill: provenRemovable ⇔ classifier is a green tier", () => {
    const samples = [
      entry({ prState: "merged", mergedHeadShaMatches: true }),
      entry({ atBaseCommit: true }),
      entry({ branchStatus: status({ ahead: 0 }) }),
      entry({ branchStatus: status({ ahead: 2 }) }),
      entry({ uncommittedCount: 1 }),
      entry({ gitRemovable: false }),
    ];
    const greens: ReadonlySet<WorktreeTier> = new Set([
      "merged",
      "at-base-commit",
      "unreferenced",
    ]);
    for (const sample of samples) {
      expect(provenRemovable(sample)).toBe(
        greens.has(classifyWorktreeTier(sample)),
      );
    }
  });
});
