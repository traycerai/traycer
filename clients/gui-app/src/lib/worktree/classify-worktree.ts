import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV11,
} from "@traycer/protocol/host/index";

/**
 * Evidence tier for a host worktree. Names a PROVEN fact about the worktree, not
 * a safety verdict. Three green tiers each require positive, host-validated proof:
 * `merged` (a PR merged with the live HEAD at the merged SHA, OR local ancestry
 * proof the work landed in the default branch); `at-base-commit` (the worktree
 * never advanced from its birth commit, so deleting loses nothing committed); and
 * `unreferenced` (a proven upstream-tip branch nothing points at). `review` is the
 * amber catch-all for anything unproven or with would-be-lost state; `orphaned`
 * and `in-use` are neutral. The same names are shared verbatim with the
 * Task-delete dialog and the `traycer-housekeeping` skill.
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
  // Honest wording: the worktree is literally unchanged from its birth commit.
  // Deliberately NOT "Pristine"/"Untouched" - setup may have written ignored
  // files, so those labels would over-claim.
  "at-base-commit": "At base commit",
  unreferenced: "Unreferenced",
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
 *  5. `prState === "merged" && mergedHeadShaMatches` → **merged** (green, PR
 *     provenance). Highest green - the authoritative signal that the work landed.
 *     The host already validated the live HEAD is the merged SHA, so the pure
 *     client never needs the SHA. A merged PR state WITHOUT the live-HEAD match
 *     does NOT green - it falls through.
 *  6. `atBaseCommit === true` → **at-base-commit** (green). Host-computed
 *     retroactively from signals every worktree carries: `clean && contained in
 *     default (mergedIntoDefault) && no authored-commit reflog entry` ⇒ untouched.
 *     Checked BEFORE local ancestry ON PURPOSE: an untouched worktree is contained
 *     in the default, so `mergedIntoDefault` is ALSO true. Ordering at-base first
 *     makes the common untouched worktree read the honest "At base commit" instead
 *     of the misnomer "Merged". The reflog guard is the only thing splitting the
 *     two labels - both share the `mergedIntoDefault` safety floor. Applies
 *     regardless of owners or an open PR; deleting loses nothing committed.
 *  7. `branchStatus.mergedIntoDefault === true` → **merged** (green, local
 *     ancestry). Now correctly rare: only a branch that actually ADVANCED from its
 *     base and is now contained in the default lands here (a genuine merge). Proof
 *     stands regardless of owners and of any upstream.
 *  8. clean + non-null status + `ahead === 0` + no owners → **unreferenced**
 *     (quiet-green; a PROVEN upstream-tip branch nothing references).
 *  9. else → **review** (null status, `ahead === null`/`> 0` unmerged,
 *     referenced-unmerged).
 *
 * Green requires positive, host-validated proof; unknown/stale is never green.
 * `ahead === null` (no upstream) is NOT a green light on its own: a never-pushed
 * branch is only ever Merged (proven contained), At base commit, or Review.
 */
export function classifyWorktreeTier(
  entry: WorktreeHostEntryV11,
): WorktreeTier {
  if (entry.inUse) return "in-use";
  if (!entry.gitRemovable) return "orphaned";
  if (entry.uncommittedCount > 0) return "review";
  if (entry.branch === null) return "review";
  // Positive, host-validated green proofs, in precedence order. `atBaseCommit`
  // sits ABOVE local ancestry so a never-touched worktree (whose base is in the
  // default, making `mergedIntoDefault` also true) reads the honest "At base
  // commit", not "Merged". A validated merged PR still wins over both.
  if (entry.prState === "merged" && entry.mergedHeadShaMatches) return "merged";
  if (entry.atBaseCommit) return "at-base-commit";
  const status = entry.branchStatus;
  if (status !== null && status.mergedIntoDefault) return "merged";
  if (status !== null && status.ahead === 0 && entry.owners.length === 0) {
    return "unreferenced";
  }
  return "review";
}

/**
 * The single green / bulk-eligible predicate - one source of truth backing the
 * pill, the Task-delete default-check, and the bulk delete copy (critique #5 - no
 * divergent predicates). A worktree is proven-removable when the shared classifier
 * places it in one of the three green tiers: `merged`, `at-base-commit`, or
 * `unreferenced`. Deriving it from `classifyWorktreeTier` guarantees the pill the
 * user sees and the bulk cohort can never disagree.
 */
export function provenRemovable(entry: WorktreeHostEntryV11): boolean {
  const tier = classifyWorktreeTier(entry);
  return (
    tier === "merged" || tier === "at-base-commit" || tier === "unreferenced"
  );
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

function worktreeFacts(
  entry: WorktreeHostEntryV11,
  tier: WorktreeTier,
): readonly string[] {
  // "clean" only reads as reassuring on the green-leaning tiers; elsewhere it is
  // noise against the louder signals already listed. The owner/reference state
  // is shown on its own line, so it is deliberately NOT repeated as a fact here.
  const cleanGreen =
    entry.uncommittedCount === 0 &&
    (tier === "merged" || tier === "at-base-commit" || tier === "unreferenced");
  return [
    ...mergedProvenanceFacts(entry, tier),
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

/**
 * The row-fact hint that distinguishes HOW a `merged` worktree was proven merged:
 * `PR #123` when the green came from a validated merged PR, or `in default` when
 * it came from local ancestry. Only emitted on the `merged` tier - the provenance
 * is the reassuring detail there. `PR #123` takes precedence because the
 * classifier evaluates the PR row first.
 */
function mergedProvenanceFacts(
  entry: WorktreeHostEntryV11,
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
  return ["in default"];
}

function branchStatusFacts(status: WorktreeBranchStatus | null): string[] {
  if (status === null) return [];
  // `ahead`/`behind` are null for a never-pushed branch (no upstream to diff);
  // render nothing rather than a bogus "0 ahead". Merged-ness is surfaced by
  // `mergedProvenanceFacts` (as "PR #123" / "in default") on the merged tier, so
  // it is deliberately NOT repeated here.
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
