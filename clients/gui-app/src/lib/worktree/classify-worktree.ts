import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV11,
} from "@traycer/protocol/host/index";

/**
 * Evidence tier for a host worktree. Names a PROVEN fact about the worktree, not
 * a safety verdict - green (`merged`) is reserved for the one probe-proven tier;
 * `unreferenced` is a quiet-green "nothing points at it, unknown-not-proven"
 * tier; `review` is the amber catch-all for anything with unproven or would-be-
 * lost state. The same five names are shared verbatim with the Task-delete
 * dialog and the `traycer-housekeeping` skill.
 */
export type WorktreeTier =
  "in-use" | "review" | "orphaned" | "merged" | "unreferenced";

export interface WorktreeClassification {
  readonly tier: WorktreeTier;
  /** Human tier label ("In use" / "Review" / …). */
  readonly label: string;
  /**
   * Ordered, relevance-gated evidence facts for the row's secondary line and the
   * skill's report - only non-default signals, most-relevant first. Never a time
   * string (that is a render concern the caller appends).
   */
  readonly facts: readonly string[];
}

export const WORKTREE_TIER_LABEL: Record<WorktreeTier, string> = {
  "in-use": "In use",
  review: "Review",
  orphaned: "Orphaned",
  merged: "Merged",
  unreferenced: "Unreferenced",
};

/**
 * Safe-first display order (merged proof first, blocked `in-use` last). Rows land
 * pre-triaged in this order, stalest-first within each tier.
 */
export const WORKTREE_TIER_ORDER: readonly WorktreeTier[] = [
  "merged",
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
 * The canonical evidence ladder - FIRST MATCH WINS. Order is deliberate:
 *
 *  1. `inUse` → **in-use** (blocked; never a delete candidate).
 *  2. `!gitRemovable` → **orphaned**. Checked BEFORE review on purpose: an
 *     orphan's `branchStatus` is usually null, which the review gate would
 *     otherwise swallow. Both tiers stay per-row only, so this ordering only
 *     changes the LABEL, never bulk safety.
 *  3. **review** (amber) - anything unproven or with would-be-lost state:
 *     dirty, a detached HEAD (`branch === null`, ALWAYS review - force-remove
 *     can orphan detached commits), null branch status (position unprobed),
 *     referenced-and-unmerged (the `owners` gate), or not-merged with local
 *     commits that aren't proven absent (`ahead === null` - never-pushed and
 *     not contained in default - OR `ahead > 0`).
 *  4. clean + `mergedIntoDefault` → **merged** (green; proof stands regardless
 *     of owners and of any upstream - a never-pushed branch whose HEAD is
 *     contained in the default lands here. Proof beats owners: nothing is lost).
 *  5. clean + non-null status + `ahead === 0` + no owners + not merged →
 *     **unreferenced** (quiet-green; reserved for a PROVEN upstream-tip branch).
 *
 * `ahead === null` (no upstream) is NOT a green light: a never-pushed branch is
 * only ever Merged (proven contained) or Review (not proven) - never
 * Unreferenced. Unreferenced requires a proven `ahead === 0`.
 */
export function classifyWorktreeTier(
  entry: WorktreeHostEntryV11,
): WorktreeTier {
  if (entry.inUse) return "in-use";
  if (!entry.gitRemovable) return "orphaned";
  const status = entry.branchStatus;
  const merged = status !== null && status.mergedIntoDefault;
  if (
    entry.uncommittedCount > 0 ||
    entry.branch === null ||
    status === null ||
    (entry.owners.length > 0 && !merged) ||
    (!merged && (status.ahead === null || status.ahead > 0))
  ) {
    return "review";
  }
  if (merged) return "merged";
  // Everything the review gate let through that is not merged is provably a
  // clean, non-null-status, ahead === 0, no-owners, named-branch worktree.
  return "unreferenced";
}

export function classifyWorktree(
  entry: WorktreeHostEntryV11,
): WorktreeClassification {
  const tier = classifyWorktreeTier(entry);
  return {
    tier,
    label: WORKTREE_TIER_LABEL[tier],
    facts: worktreeFacts(entry, tier),
  };
}

/**
 * Primary one-click bulk cohort - PROVEN removable. `!inUse`, clean,
 * `gitRemovable`, non-null branch status, and either proven-merged OR
 * (no local-only commits AND unreferenced). Callers additionally exclude any
 * path with a delete already queued/running.
 */
export function isPrimarySweepEligible(entry: WorktreeHostEntryV11): boolean {
  const status = entry.branchStatus;
  return (
    !entry.inUse &&
    entry.uncommittedCount === 0 &&
    entry.gitRemovable &&
    status !== null &&
    (status.mergedIntoDefault ||
      (status.ahead === 0 && entry.owners.length === 0))
  );
}

/**
 * Secondary, deliberately-separate cohort - clean + unreferenced + a NAMED
 * branch whose status could not be probed (`branchStatus === null`). Removing
 * such a worktree preserves the branch ref, so committed work is recoverable -
 * but this is NEVER "safe"/"loss-free" copy: `uncommittedCount` cannot see
 * ignored files. Detached HEAD (`branch === null`) is excluded (force-remove can
 * orphan detached commits) and stays per-row review.
 */
export function isSecondarySweepEligible(entry: WorktreeHostEntryV11): boolean {
  return (
    !entry.inUse &&
    entry.uncommittedCount === 0 &&
    entry.owners.length === 0 &&
    entry.branch !== null &&
    entry.branchStatus === null &&
    entry.gitRemovable
  );
}

/**
 * Evidence rule for a default-CHECKED Task-delete cleanup candidate: proven
 * removable = clean AND a non-null branch status that is either merged or has no
 * local-only commits. Unproven (null status) and dirty candidates default
 * UNCHECKED. Narrow-shaped so both the full listing entry and the Task-delete
 * candidate can be tested against it.
 */
export function isEvidenceProvenRemovable(input: {
  readonly uncommittedCount: number;
  readonly branchStatus: WorktreeBranchStatus | null;
}): boolean {
  const status = input.branchStatus;
  return (
    input.uncommittedCount === 0 &&
    status !== null &&
    (status.mergedIntoDefault || status.ahead === 0)
  );
}

function worktreeFacts(
  entry: WorktreeHostEntryV11,
  tier: WorktreeTier,
): readonly string[] {
  // "clean" only reads as reassuring on the green-leaning tiers; elsewhere it is
  // noise against the louder signals already listed. The owner/reference state
  // is shown on its own line, so it is deliberately NOT repeated as a fact here.
  const cleanGreen =
    entry.uncommittedCount === 0 &&
    (tier === "merged" || tier === "unreferenced");
  return [
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
  ];
}

function branchStatusFacts(status: WorktreeBranchStatus | null): string[] {
  if (status === null) return [];
  // `ahead`/`behind` are null for a never-pushed branch (no upstream to diff);
  // render nothing rather than a bogus "0 ahead". The merged fact still shows.
  return [
    ...(status.mergedIntoDefault ? ["merged"] : []),
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
