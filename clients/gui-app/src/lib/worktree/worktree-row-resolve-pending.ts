import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";

/**
 * Whether a binding row's git-eligibility is an unverified placeholder the
 * host is still resolving. This reads the host's single authoritative
 * `isGitResolvePending` signal (v1.2) rather than re-deriving which
 * disabled reasons are git-derived - the host computes it where it derives
 * the reason, and bridges pre-v1.2 hosts to `false` (their answer is
 * authoritative, never perpetually pending).
 *
 * Pickers render pending rows as "checking" instead of dead or hidden; the
 * host's sweep re-derives the view and pushes `worktree.changed`, so the row
 * converges to selectable (or genuinely dead) without user action.
 */
export function isWorkspaceResolvePending(
  row: WorktreeBindingSelectorRowV12,
): boolean {
  return row.isGitResolvePending;
}
