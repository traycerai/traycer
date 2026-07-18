import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV12,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/index";

/**
 * Evidence tier for a host worktree. Names a PROVEN fact about the worktree, not
 * a safety verdict. Three green tiers each require positive, host-validated proof:
 * `merged` (a PR merged with the live HEAD at the merged SHA, local ancestry
 * proof the work landed in the default branch, OR an at-base superproject with
 * authored owned-submodule work proven landed); `at-base-commit` (the worktree
 * never advanced from its birth commit and no authored submodule work landed, so
 * deleting loses nothing committed); and `unreferenced` (a proven upstream-tip
 * branch nothing points at). `review` is the amber catch-all for anything
 * unproven or with would-be-lost state; `orphaned` and `in-use` are neutral. The
 * same names are shared verbatim with the Task-delete dialog and the
 * `traycer-housekeeping` skill.
 */
export type WorktreeTier =
  | "in-use"
  | "review"
  | "orphaned"
  | "merged"
  | "at-base-commit"
  | "unreferenced";

export interface WorktreeClassification {
  readonly tier: WorktreeTier;
  /** Human tier label ("In use" / "Review" / …). */
  readonly label: string;
  /**
   * Ordered, relevance-gated evidence facts for non-chip consumers such as CLI
   * and skill reports. This is the full set: PR provenance facts first, then
   * non-PR facts. Never a time string (that is a render concern the caller
   * appends).
   */
  readonly facts: readonly string[];
  /**
   * PR/provenance facts that GUI chip surfaces may choose to hide structurally
   * rather than by matching rendered fact text.
   */
  readonly prFacts: readonly string[];
  /** Evidence facts unrelated to PR/provenance chip presentation. */
  readonly nonPrFacts: readonly string[];
}

export const WORKTREE_TIER_LABEL: Record<WorktreeTier, string> = {
  "in-use": "In use",
  review: "Review",
  orphaned: "Orphaned",
  merged: "Landed",
  // Honest wording: the worktree is literally unchanged from its birth commit.
  // Deliberately NOT "Pristine"/"Untouched" - setup may have written ignored
  // files, so those labels would over-claim.
  "at-base-commit": "At base commit",
  unreferenced: "Unreferenced",
};

/**
 * Hover explanation for each tier label. Copy must stay honest to the evidence
 * ladder in `classifyWorktreeTier`: green tiers state the PROVEN fact and why
 * deleting is safe; `review` states what is unproven; `orphaned`/`in-use` state
 * the neutral condition. Shown wherever the tier label renders as a pill.
 */
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

/**
 * Safe-first display order (proven-merged first, blocked `in-use` last). Rows land
 * pre-triaged in this order, stalest-first within each tier. `at-base-commit` sits
 * between the two stronger greens and `review`: it is proven-safe to delete but a
 * fresher, less-consequential state than a merged branch.
 */
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

/**
 * The canonical evidence ladder - FIRST MATCH WINS. Implements the merge-provenance
 * plan's precedence truth table. Order is deliberate:
 *
 *  1. `inUse` → **in-use** (blocked; never a delete candidate).
 *  2. `!gitRemovable` → **orphaned**. Checked BEFORE the greens on purpose: an
 *     orphan's `branchStatus` is usually null. Per-row only, so this only changes
 *     the LABEL, never bulk safety.
 *  3. dirty (`uncommittedCount > 0`) → **review**. Above every green: a merged or
 *     at-base worktree with uncommitted changes still has work that would be lost.
 *  4. detached HEAD (`branch === null`) → **review**. Kept above the greens: a
 *     detached worktree has no branch ref, so force-remove can orphan commits. We
 *     do NOT extend the new positive-proof greens to detached HEADs in this pass
 *     (a conservative, never-false-green choice - see report notes).
 *  5. any owned-submodule branch not proven merged → **review**. Worktree
 *     teardown deletes the owned submodule branches, so an unproven submodule is
 *     would-be-lost work even when the SUPERPROJECT is proven green (the classic
 *     case: submodule commits landed on the submodule branch but its PR hasn't
 *     merged, while the superproject gitlink was never bumped - the superproject
 *     looks clean/at-base). Proof per fact mirrors the superproject greens:
 *     a HEAD-validated merged PR, local `mergedIntoDefault` ancestry, or
 *     `atPinnedCommit` (the branch/tip equals the superproject's pinned gitlink
 *     and carries nothing beyond that pin).
 *     `submodules: []` (none owned, or `includeActivity: false`) gates nothing.
 *  6. `prState === "merged" && mergedHeadShaMatches` → **merged** (green, PR
 *     provenance). Highest green - the authoritative signal that the work landed.
 *     The host already validated the live HEAD is the merged SHA, so the pure
 *     client never needs the SHA. A merged PR state WITHOUT the live-HEAD match
 *     does NOT green - it falls through.
 *  7. `atBaseCommit === true` + any owned submodule with authored work proven
 *     landed → **merged** (green). A submodule has authored work when it differs
 *     from the pinned gitlink (`!atPinnedCommit`); landing proof is the same
 *     HEAD-validated merged PR or local default-branch ancestry used by the
 *     submodule safety gate. The gate above still requires EVERY owned submodule
 *     to be proven safe, so one unproven sibling keeps the row in Review.
 *  8. `atBaseCommit === true` → **at-base-commit** (green). Host-computed
 *     retroactively from signals every worktree carries: `clean && contained in
 *     default (mergedIntoDefault) && no authored-commit reflog entry` ⇒ untouched.
 *     Checked BEFORE local ancestry ON PURPOSE: an untouched worktree is contained
 *     in the default, so `mergedIntoDefault` is ALSO true. Ordering at-base first
 *     makes the common untouched worktree read the honest "At base commit"
 *     instead of the stronger "Landed" label. The reflog guard is the only thing
 *     splitting the two labels - both share the `mergedIntoDefault` safety
 *     floor. Applies
 *     regardless of owners or an open PR; deleting loses nothing committed.
 *  9. `branchStatus.mergedIntoDefault === true` → **merged** (green, local
 *     ancestry). Now correctly rare: only a branch that actually ADVANCED from its
 *     base and is now contained in the default lands here (a genuine merge). Proof
 *     stands regardless of owners and of any upstream.
 *  10. clean + non-null status + `ahead === 0` + no owners → **unreferenced**
 *     (quiet-green; a PROVEN upstream-tip branch nothing references).
 *  11. else → **review** (null status, `ahead === null`/`> 0` unmerged,
 *     referenced-unmerged).
 *
 * Green requires positive, host-validated proof; unknown/stale is never green.
 * `ahead === null` (no upstream) is NOT a green light on its own: a never-pushed
 * branch is only ever Landed (proven contained), At base commit, or Review.
 */
export function classifyWorktreeTier(
  entry: WorktreeHostEntryV12,
): WorktreeTier {
  if (entry.inUse) return "in-use";
  if (!entry.gitRemovable) return "orphaned";
  if (entry.uncommittedCount > 0) return "review";
  if (entry.branch === null) return "review";
  // Owned-submodule gate: teardown deletes owned submodule branches, so ONE
  // unproven submodule blocks every green - the superproject proof says nothing
  // about the submodule branch's work.
  if (entry.submodules.some((fact) => !submoduleMergeProven(fact))) {
    return "review";
  }
  // Positive, host-validated green proofs, in precedence order. `atBaseCommit`
  // sits ABOVE local ancestry so a never-touched worktree (whose base is in the
  // default, making `mergedIntoDefault` also true) reads the honest "At base
  // commit", not "Landed". A validated merged PR still wins over both.
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

/**
 * Specific, non-exclusive blockers for a Review row. Kept separate from the
 * tier classifier: the ladder still picks one tier, while this reports every
 * contributing risk the user should inspect.
 */
export function describeReviewReasons(
  entry: WorktreeHostEntryV12,
): readonly string[] {
  if (classifyWorktreeTier(entry) !== "review") return [];
  const status = entry.branchStatus;
  return [
    ...(entry.uncommittedCount > 0
      ? [
          `${entry.uncommittedCount} uncommitted change${entry.uncommittedCount === 1 ? "" : "s"}`,
        ]
      : []),
    ...(entry.branch === null ? ["Detached HEAD"] : []),
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
    // `ahead === null` = no upstream to diff against: the branch was never
    // pushed (or its remote ref is gone), so its unmerged commits are not
    // recoverable from anywhere else - the highest-stakes Review shape, and it
    // must say so rather than fall back to the generic tier help.
    ...(entry.prState === "none" &&
    status !== null &&
    status.ahead === null &&
    !status.mergedIntoDefault
      ? [
          "Commits with no PR that were never pushed - they exist only in this worktree",
        ]
      : []),
    ...(entry.prState === null ? ["Checking merge status…"] : []),
    ...(status !== null && status.ahead === 0 && entry.owners.length > 0
      ? ["Referenced by a Task at the upstream tip"]
      : []),
  ];
}

/**
 * A single owned-submodule branch is proven merged the same two ways the
 * superproject greens, plus the submodule-specific at-pin proof: a
 * HEAD-validated merged PR (`prState === "merged"` with the host's live-HEAD
 * match), local `mergedIntoDefault` ancestry, or `atPinnedCommit`. `prState`
 * null (not probed) or `"none"` proves nothing on its own - the local proof bits
 * are then the only possible proof.
 */
function submoduleMergeProven(fact: WorktreeSubmoduleMergeFactV12): boolean {
  if (fact.prState === "merged" && fact.mergedHeadShaMatches) return true;
  return fact.mergedIntoDefault || fact.atPinnedCommit;
}

/**
 * Positive proof that an owned submodule both carried work beyond the
 * superproject's pinned gitlink and landed that work. `atPinnedCommit` is kept as
 * a hard exclusion even if another proof bit is also true: the pinned checkout
 * is safe, but it contains no authored submodule work that should promote an
 * otherwise at-base superproject to Landed.
 */
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

/**
 * The single green / bulk-eligible predicate - one source of truth backing the
 * pill, the Task-delete default-check, and the bulk delete copy (critique #5 - no
 * divergent predicates). A worktree is proven-removable when the shared classifier
 * places it in one of the three green tiers: `merged`, `at-base-commit`, or
 * `unreferenced`. Deriving it from `classifyWorktreeTier` guarantees the pill the
 * user sees and the bulk cohort can never disagree.
 */
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
  // "clean" only reads as reassuring on the green-leaning tiers; elsewhere it is
  // noise against the louder signals already listed. The owner/reference state
  // is shown on its own line, so it is deliberately NOT repeated as a fact here.
  const cleanGreen =
    entry.uncommittedCount === 0 &&
    (tier === "merged" || tier === "at-base-commit" || tier === "unreferenced");
  return {
    prFacts: [
      ...mergedProvenanceFacts(entry, tier),
      ...unprovenSubmoduleFacts(entry.submodules),
    ],
    nonPrFacts: [
      ...branchStatusFacts(entry.branchStatus),
      ...dirtinessFacts(entry.uncommittedCount),
      ...(entry.branch === null ? ["detached HEAD"] : []),
      ...(entry.gitRemovable ? [] : ["git can't remove"]),
      ...(entry.branchStatus === null &&
      entry.gitRemovable &&
      entry.branch !== null
        ? ["branch status unknown"]
        : []),
      ...(cleanGreen ? ["clean"] : []),
    ],
  };
}

/**
 * The row-fact hint that distinguishes HOW a `merged` worktree was proven merged:
 * `PR #123` when the green came from a validated superproject PR, `submodule
 * owner/repo landed` when an otherwise at-base superproject carried landed
 * authored submodule work, or `in default` when it came from superproject local
 * ancestry. Only emitted on the `merged` tier - the provenance is the reassuring
 * detail there. The order mirrors the classifier's evidence ladder.
 */
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

/**
 * One fact per owned submodule whose branch is NOT proven merged - the loss the
 * submodule gate is protecting (teardown deletes those branches). An open PR is
 * named so the user can see the work is in flight; otherwise the branch is
 * plainly "unmerged". Proven submodules emit nothing - on a green tier they are
 * covered by the tier itself.
 */
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
  // `ahead`/`behind` are null for a never-pushed branch (no upstream to diff);
  // render nothing rather than a bogus "0 ahead". Landed-ness is surfaced by
  // `mergedProvenanceFacts` (as "PR #123" / "in default") on the merged tier, so
  // landed status is deliberately NOT repeated here.
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
