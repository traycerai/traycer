import type {
  WorktreeAutoCleanupPausedReason,
  WorktreeAutoCleanupTarget,
  WorktreeAutoCleanupTargetOutcome,
} from "@traycer/protocol/host/worktree-auto-cleanup-schemas";

/**
 * Every word this feature puts in front of a user, in one file, because two of
 * them are load-bearing product decisions rather than labels:
 *
 *  - a `skipped` target is the SAFETY ENGINE WORKING. It lost eligibility
 *    between selection and deletion (someone opened a terminal in it, it went
 *    dirty, the policy changed). Presenting that in failure styling teaches
 *    people to ignore the one state that means Traycer could not do something
 *    it was authorized to do.
 *  - an `interrupted` target is HONESTLY UNCONFIRMED. The host stopped before a
 *    terminal result was durably recorded, so the row may not claim the
 *    worktree was deleted just because it is gone now — and equally may not
 *    claim a failure that never happened.
 *
 * Only `failed` gets failure styling.
 */

/** The GUI's threshold presets. Bounds are the HOST's and travel as data. */
export const AUTO_CLEANUP_DAY_PRESETS: readonly number[] = [7, 14, 30, 60, 90];

/**
 * Why an enabled policy is not evaluating right now.
 *
 * A `Record` over the closed wire enum, so a new pause arm fails to compile
 * here rather than rendering as silence. Every one of these clears WITHOUT the
 * user doing anything — the host retries and resumes on its own — so the copy
 * explains and never offers a repair affordance.
 */
export const AUTO_CLEANUP_PAUSED_COPY: Record<
  WorktreeAutoCleanupPausedReason,
  string
> = {
  no_host_credential:
    "Paused: this host has no stored credential to run cleanup under. It resumes on its own once one is in place.",
  needs_reauth:
    "Paused: this host's credential needs to be re-authorized. Cleanup resumes on its own once it is.",
  owner_mismatch:
    "Paused: the credential on this host belongs to a different account than the one that turned cleanup on. Cleanup never transfers authority silently.",
  startup_reconciliation_failed:
    "Paused: this host could not finish its startup checks, so it cannot prove a worktree is unused. It retries on its own.",
  activity_plane_unhealthy:
    "Paused: this host cannot read its recent-activity records, so it cannot tell how long a worktree has been idle. It retries on its own.",
};

export const AUTO_CLEANUP_OUTCOME_LABEL: Record<
  WorktreeAutoCleanupTargetOutcome,
  string
> = {
  deleted: "Removed",
  skipped: "No longer eligible",
  failed: "Failed",
  interrupted: "Unconfirmed",
};

/** Only `failed` is a failure. See the module header. */
export function autoCleanupOutcomeTone(
  outcome: WorktreeAutoCleanupTargetOutcome | null,
): "neutral" | "positive" | "failure" {
  if (outcome === "failed") return "failure";
  if (outcome === "deleted") return "positive";
  return "neutral";
}

/**
 * The sentence under a target row.
 *
 * The host's own `displayMessage` wins wherever it exists: `reasonCode` is an
 * OPEN string by contract, so a code this build has never heard of still
 * renders host-composed prose instead of a shrug. The fallbacks below cover
 * only the cases where the host sent none.
 */
export function autoCleanupTargetMessage(
  target: WorktreeAutoCleanupTarget,
): string | null {
  if (target.displayMessage !== null) return target.displayMessage;
  switch (target.outcome) {
    case "interrupted":
      return "Unconfirmed — Host stopped during cleanup.";
    case "skipped":
      return "No longer eligible when cleanup reached it.";
    case "failed":
      return "Cleanup could not remove this worktree.";
    case "deleted":
      return null;
    case null:
      return "Queued.";
  }
}

/**
 * The one-line summary on a run row. Reads the same way the notification does,
 * so a user who saw the toast recognizes the row it points at.
 */
export function autoCleanupRunSummaryLine(counts: {
  readonly deletedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly interruptedCount: number;
}): string {
  const parts = [
    `${String(counts.deletedCount)} removed`,
    `${String(counts.skippedCount)} skipped`,
    `${String(counts.failedCount)} failed`,
  ];
  if (counts.interruptedCount > 0) {
    parts.push(`${String(counts.interruptedCount)} unconfirmed`);
  }
  return parts.join(", ");
}

/**
 * The inactivity threshold a draft would send, or the reason it cannot be sent.
 * Pure so the bounds rule is testable without rendering the control — and the
 * bounds come from the HOST's response, never a constant here, so a host that
 * moves them needs no client release.
 */
export function autoCleanupDaysError(
  draft: string,
  bounds: { readonly minDays: number; readonly maxDays: number },
): string | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return "Enter a number of days.";
  if (!/^\d+$/.test(trimmed)) return "Enter a whole number of days.";
  const days = Number(trimmed);
  if (days < bounds.minDays || days > bounds.maxDays) {
    return `Choose between ${String(bounds.minDays)} and ${String(bounds.maxDays)} days.`;
  }
  return null;
}
