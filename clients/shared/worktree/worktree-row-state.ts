import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host/index";

/**
 * What a workspace/worktree binding row's state actually is - ONE derivation
 * both clients read instead of each walking `disabledReason` / `setupState` /
 * `isGitResolvePending` themselves.
 *
 * This is deliberately a state, not a label: the GUI pickers render it as a
 * badge with a tone and a hover detail, and `traycer workspace list` renders it
 * as a table cell. Those two vocabularies differ on purpose (`missing` vs
 * `missing on disk`), and the presentation stays with each client. What must
 * NOT differ is which rows land in which state - the CLI previously kept its
 * own copy of this ladder behind a "keep in sync with the GUI" comment, and it
 * had already drifted: it keyed on `disabledReason` alone and so reported a
 * worktree whose setup script FAILED as plain `ready`.
 *
 * Ordering is precedence, first match wins:
 *
 *  1. blocked + git facts unresolved → `checking`
 *  2. blocked                        → `missing`
 *  3. setup lifecycle                → `setup-pending` / `setting-up` /
 *                                      `setup-failed` / `setup-cancelled`
 *  4. else                           → `ready`
 *
 * The setup states are NOT unavailability: a worktree whose setup script failed
 * is still a directory an agent can work in, so both clients keep such a row
 * selectable and report the state only so the user knows it may be
 * half-configured. Only step 1-2 mean "you cannot use this row".
 */
export type WorktreeRowState =
  | "checking"
  | "missing"
  | "setup-pending"
  | "setting-up"
  | "setup-failed"
  | "setup-cancelled"
  | "ready";

/**
 * The fields the ladder reads. A `Pick` rather than the whole row so callers
 * holding a narrower shape (and tests holding a fixture) can use it, and so the
 * inputs this derivation actually depends on are stated rather than implied.
 */
export type WorktreeRowStateInput = Pick<
  WorktreeBindingSelectorRowV12,
  "disabledReason" | "isGitRepo" | "mode" | "setupState" | "isGitResolvePending"
>;

/**
 * Whether this row's git-eligibility is an unverified placeholder the host is
 * still resolving.
 *
 * Reads the host's single authoritative `isGitResolvePending` signal (v1.2)
 * rather than re-deriving which disabled reasons are git-derived: the host
 * computes it where it derives the reason, and a pre-v1.2 host is bridged up as
 * `false` (its answer IS authoritative - there is no non-null timestamp coming
 * to clear it, so a pending default would strand such a row as perpetually
 * "checking").
 *
 * Named as a function rather than inlined as a field read because the field
 * name says what it is and this says what it MEANS for a row - and because the
 * consequence is a rule: a pending row must never be rendered with a verdict
 * the next host sweep can retract.
 */
export function isWorkspaceResolvePending(
  row: Pick<WorktreeBindingSelectorRowV12, "isGitResolvePending">,
): boolean {
  return row.isGitResolvePending;
}

/**
 * Whether a row is genuinely unusable, as opposed to merely mid-setup.
 *
 * The current host treats CREATION as the selector gate: once a worktree
 * exists, setup progress and outcomes live in `setupState` and the row stays
 * selectable with `disabledReason: null`. Older hosts projected the same
 * lifecycle as `setup_*` reasons, so those are accepted too - and relaxed once
 * disk truth (`mode === "worktree" && isGitRepo`) shows the worktree is
 * actually there, which is what lets a new client unlock promptly against an
 * old host.
 *
 * The switch is exhaustive on purpose. `worktreeBindingSelectorDisabledReason`
 * is a strict `z.enum`, so an unknown reason fails the response parse long
 * before it reaches here; a reason added to the protocol should therefore break
 * this build and force a blocking-or-not decision, not fall through to a
 * default that quietly picks one.
 */
export function hasBlockingWorktreeSelectorReason(
  row: Pick<
    WorktreeBindingSelectorRowV12,
    "disabledReason" | "isGitRepo" | "mode"
  >,
): boolean {
  switch (row.disabledReason) {
    case null:
      return false;
    case "setup_pending":
    case "setup_running":
    case "setup_failed":
    case "setup_cancelled":
      return row.mode === "worktree" && !row.isGitRepo;
    case "missing_worktree_path":
      return true;
  }
}

/**
 * The row's state, per the precedence documented on `WorktreeRowState`.
 *
 * Two details are load-bearing and both exist to avoid asserting something the
 * host has not established:
 *
 * - A blocked row splits on `isWorkspaceResolvePending` BEFORE it is called
 *   missing. The host derives `missing_worktree_path` from an `isGitRepo` it
 *   has not verified yet, so naming it "missing" states as fact something the
 *   next sweep may retract.
 * - Each setup rung accepts either spelling - the live `setupState` or the
 *   legacy `setup_*` reason - because reading only the reason misses a failure
 *   the current host reports solely in `setupState`.
 */
export function worktreeRowState(row: WorktreeRowStateInput): WorktreeRowState {
  if (hasBlockingWorktreeSelectorReason(row)) {
    return isWorkspaceResolvePending(row) ? "checking" : "missing";
  }
  if (row.setupState === "pending" || row.disabledReason === "setup_pending") {
    return "setup-pending";
  }
  if (row.setupState === "running" || row.disabledReason === "setup_running") {
    return "setting-up";
  }
  if (row.setupState === "failed" || row.disabledReason === "setup_failed") {
    return "setup-failed";
  }
  if (
    row.setupState === "cancelled" ||
    row.disabledReason === "setup_cancelled"
  ) {
    return "setup-cancelled";
  }
  return "ready";
}
