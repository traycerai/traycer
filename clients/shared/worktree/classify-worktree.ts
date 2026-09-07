import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV12,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/index";

/** Proven fact, not a safety verdict. Green tiers need host-validated proof; `review` is the unproven catch-all. */
export type WorktreeTier =
  | "in-use"
  | "review"
  | "orphaned"
  | "merged"
  | "at-base-commit"
  | "unreferenced";

export interface WorktreeClassification {
  readonly tier: WorktreeTier;
  readonly label: string;
  /** Full fact set for CLI/skill reports. Never a time string. */
  readonly facts: readonly string[];
  /** PR/provenance facts GUI chips may hide structurally. */
  readonly prFacts: readonly string[];
  readonly nonPrFacts: readonly string[];
}

export const WORKTREE_TIER_LABEL: Record<WorktreeTier, string> = {
  "in-use": "In use",
  review: "Review",
  orphaned: "Orphaned",
  merged: "Landed",
  // Not "Pristine"/"Untouched": setup may have written ignored files.
  "at-base-commit": "At base commit",
  unreferenced: "Unreferenced",
};

/** Hover copy must stay honest to the evidence ladder. */
export const WORKTREE_TIER_TOOLTIP: Record<WorktreeTier, string> = {
  "in-use":
    "An active task or agent is currently using this worktree, so it can't be deleted.",
  review:
    "Not proven safe to remove: it has uncommitted changes, unmerged or unpushed commits, an unmerged submodule branch, a detached HEAD, or unknown branch status. Review before deleting.",
  orphaned:
    "Git can't remove this worktree normally - its directory or metadata is missing or broken. Deleting it uses a forced cleanup.",
  merged:
    "The work is proven to have landed: a merged PR matches this worktree's current commit, the branch's commits are contained in the default branch, or authored submodule work from an otherwise at-base worktree is proven landed.",
  "at-base-commit":
    "The worktree never advanced from the commit it was created on and has no uncommitted changes - deleting it loses no committed work.",
  unreferenced:
    "Clean, fully pushed (0 commits ahead of its upstream), and no task or agent references it - the branch tip stays safe on the remote.",
};

export const WORKTREE_TIER_ORDER: readonly WorktreeTier[] = [
  "merged",
  "at-base-commit",
  "unreferenced",
  "review",
  "orphaned",
  "in-use",
];

export function worktreeTierRank(tier: WorktreeTier): number {
  const index = WORKTREE_TIER_ORDER.indexOf(tier);
  return index === -1 ? WORKTREE_TIER_ORDER.length : index;
}

export const GIT_UNREADABLE_REASON =
  "Git can't read this worktree — its main repository is missing or was moved";

function gitUnreadableOf(entry: WorktreeHostEntryV12): boolean {
  return (
    "gitUnreadable" in entry &&
    typeof entry.gitUnreadable === "boolean" &&
    entry.gitUnreadable
  );
}

/**
 * First match wins. `gitUnreadable` before orphaned; `atBaseCommit` before local ancestry so an untouched worktree is not labeled Landed.
 * Green requires positive host-validated proof; `ahead === null` is never green on its own.
 */
export function classifyWorktreeTier(
  entry: WorktreeHostEntryV12,
): WorktreeTier {
  if (entry.inUse) return "in-use";
  if (gitUnreadableOf(entry)) return "review";
  if (!entry.gitRemovable) return "orphaned";
  if (entry.uncommittedCount > 0) return "review";
  if (entry.branch === null) return "review";
  // One unproven owned submodule blocks every green; teardown deletes those branches.
  if (entry.submodules.some((fact) => !submoduleMergeProven(fact))) {
    return "review";
  }
  if (entry.prState === "merged" && entry.mergedHeadShaMatches) return "merged";
  if (
    entry.atBaseCommit &&
    entry.submodules.some(submoduleAuthoredWorkLanded)
  ) {
    return "merged";
  }
  if (entry.atBaseCommit) return "at-base-commit";
  const status = entry.branchStatus;
  if (status !== null && status.mergedIntoDefault) return "merged";
  if (status !== null && status.ahead === 0 && entry.owners.length === 0) {
    return "unreferenced";
  }
  return "review";
}

export function describeReviewReasons(
  entry: WorktreeHostEntryV12,
): readonly string[] {
  if (classifyWorktreeTier(entry) !== "review") return [];
  const status = entry.branchStatus;
  const unreadable = gitUnreadableOf(entry);
  return [
    ...(unreadable ? [GIT_UNREADABLE_REASON] : []),
    ...(entry.uncommittedCount > 0
      ? [
          `${entry.uncommittedCount} uncommitted change${entry.uncommittedCount === 1 ? "" : "s"}`,
        ]
      : []),
    ...(!unreadable && entry.branch === null ? ["Detached HEAD"] : []),
    ...entry.submodules
      .filter((fact) => !submoduleMergeProven(fact))
      .map(describeUnprovenSubmodule),
    ...(entry.prState === "merged" && !entry.mergedHeadShaMatches
      ? ["Merged PR does not cover the current HEAD"]
      : []),
    ...(entry.prState === "open" ? ["Superproject PR is open"] : []),
    ...(entry.prState === "closed"
      ? ["Superproject PR was closed without merging"]
      : []),
    ...(entry.prState === "none" &&
    status !== null &&
    status.ahead !== null &&
    status.ahead > 0
      ? [
          `No PR for ${status.ahead} unmerged commit${status.ahead === 1 ? "" : "s"}`,
        ]
      : []),
    // `ahead === null` means no upstream; say so rather than falling back to generic tier help.
    ...(entry.prState === "none" &&
    status !== null &&
    status.ahead === null &&
    !status.mergedIntoDefault
      ? [
          "Commits with no PR that were never pushed - they exist only in this worktree",
        ]
      : []),
    ...(!unreadable && entry.prState === null
      ? ["Checking merge status…"]
      : []),
    ...(status !== null && status.ahead === 0 && entry.owners.length > 0
      ? ["Referenced by a Task at the upstream tip"]
      : []),
  ];
}

function submoduleMergeProven(fact: WorktreeSubmoduleMergeFactV12): boolean {
  if (fact.prState === "merged" && fact.mergedHeadShaMatches) return true;
  return fact.mergedIntoDefault || fact.atPinnedCommit;
}

function submoduleAuthoredWorkLanded(
  fact: WorktreeSubmoduleMergeFactV12,
): boolean {
  return !fact.atPinnedCommit && submoduleMergeProven(fact);
}

function describeUnprovenSubmodule(
  fact: WorktreeSubmoduleMergeFactV12,
): string {
  const name = `${fact.repoIdentifier.owner}/${fact.repoIdentifier.repo} (${fact.branch})`;
  if (fact.unmergedCommitCount !== null && fact.unmergedCommitCount >= 1) {
    return `${name}: ${fact.unmergedCommitCount} unmerged commit${fact.unmergedCommitCount === 1 ? "" : "s"}`;
  }
  if (fact.prState === "open" || fact.prState === "closed") {
    return `${name}: PR is ${fact.prState}`;
  }
  if (fact.prState === null) return `${name}: still checking merge status`;
  if (fact.prState === "merged") {
    return `${name}: merged PR does not cover the current HEAD`;
  }
  return `${name}: unmerged commits`;
}

export function provenRemovable(entry: WorktreeHostEntryV12): boolean {
  const tier = classifyWorktreeTier(entry);
  return (
    tier === "merged" || tier === "at-base-commit" || tier === "unreferenced"
  );
}

export function classifyWorktree(
  entry: WorktreeHostEntryV12,
): WorktreeClassification {
  const tier = classifyWorktreeTier(entry);
  const facts = worktreeFacts(entry, tier);
  return {
    tier,
    label: WORKTREE_TIER_LABEL[tier],
    facts: [...facts.prFacts, ...facts.nonPrFacts],
    prFacts: facts.prFacts,
    nonPrFacts: facts.nonPrFacts,
  };
}

interface WorktreeFacts {
  readonly prFacts: readonly string[];
  readonly nonPrFacts: readonly string[];
}

function worktreeFacts(
  entry: WorktreeHostEntryV12,
  tier: WorktreeTier,
): WorktreeFacts {
  // "clean" only on green-leaning tiers; owner/reference is on its own line.
  const cleanGreen =
    entry.uncommittedCount === 0 &&
    (tier === "merged" || tier === "at-base-commit" || tier === "unreferenced");
  const unreadable = gitUnreadableOf(entry);
  return {
    prFacts: [
      ...mergedProvenanceFacts(entry, tier),
      ...unprovenSubmoduleFacts(entry.submodules),
    ],
    nonPrFacts: [
      ...(unreadable ? [GIT_UNREADABLE_REASON] : []),
      ...branchStatusFacts(entry.branchStatus),
      ...dirtinessFacts(entry.uncommittedCount),
      ...(!unreadable && entry.branch === null ? ["detached HEAD"] : []),
      ...(!unreadable && !entry.gitRemovable ? ["git can't remove"] : []),
      ...(entry.branchStatus === null &&
      entry.gitRemovable &&
      entry.branch !== null
        ? ["branch status unknown"]
        : []),
      ...(cleanGreen ? ["clean"] : []),
    ],
  };
}

/** How a `merged` row was proven: PR, landed submodule work, or local ancestry. Only emitted on the merged tier. */
function mergedProvenanceFacts(
  entry: WorktreeHostEntryV12,
  tier: WorktreeTier,
): string[] {
  if (tier !== "merged") return [];
  if (
    entry.prState === "merged" &&
    entry.mergedHeadShaMatches &&
    entry.prNumber !== null
  ) {
    return [`PR #${entry.prNumber}`];
  }
  if (entry.prState === "merged" && entry.mergedHeadShaMatches) {
    return ["merged PR"];
  }
  if (entry.atBaseCommit) {
    return entry.submodules.filter(submoduleAuthoredWorkLanded).map((fact) => {
      const name = `${fact.repoIdentifier.owner}/${fact.repoIdentifier.repo}`;
      return `submodule ${name} landed`;
    });
  }
  return ["in default"];
}

function unprovenSubmoduleFacts(
  submodules: readonly WorktreeSubmoduleMergeFactV12[],
): string[] {
  return submodules
    .filter((fact) => !submoduleMergeProven(fact))
    .map((fact) => {
      const name = `${fact.repoIdentifier.owner}/${fact.repoIdentifier.repo}`;
      if (fact.prState === "open" && fact.prNumber !== null) {
        return `submodule ${name} PR #${fact.prNumber} open`;
      }
      return `submodule ${name} unmerged`;
    });
}

function branchStatusFacts(status: WorktreeBranchStatus | null): string[] {
  if (status === null) return [];
  // Null ahead/behind: render nothing rather than `0 ahead`. Landed-ness is not repeated here.
  return [
    ...(status.ahead !== null && status.ahead > 0
      ? [`${status.ahead} ahead`]
      : []),
    ...(status.behind !== null && status.behind > 0
      ? [`${status.behind} behind`]
      : []),
  ];
}

function dirtinessFacts(uncommittedCount: number): string[] {
  if (uncommittedCount === 0) return [];
  return [
    `${uncommittedCount} uncommitted change${uncommittedCount === 1 ? "" : "s"}`,
  ];
}
