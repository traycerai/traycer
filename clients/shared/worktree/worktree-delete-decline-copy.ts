import type { WorktreeDeleteDeclinedKind } from "@traycer/protocol/host/worktree-delete-batch-stream";

const GENERIC_DECLINE_MESSAGE =
  "Couldn't remove the worktree. It may still be in use - refresh and try again.";

/**
 * What the delete UI says when the host answered `deleted: false`.
 *
 * `null` is a host that did not say why (older than `worktree.deleteBatchByPath@1.3`,
 * or the per-path fallback), and keeps the one generic line. `count` is how many
 * targets the sentence speaks for: the per-target modal passes 1, while the batch
 * strip and toast pass the failure count so "this folder" is never read against
 * three failures.
 */
export function worktreeDeleteDeclineMessage(
  declined: WorktreeDeleteDeclinedKind | null,
  count: number,
): string {
  const plural = count > 1;
  switch (declined) {
    case null:
      return GENERIC_DECLINE_MESSAGE;
    case "not_managed":
      return plural
        ? "Traycer can't remove these folders because they aren't worktrees it manages, so they were left in place."
        : "Traycer can't remove this folder because it isn't a worktree it manages, so it was left in place.";
    case "teardown_failed":
      return plural
        ? "The teardown script didn't finish successfully, so the worktrees were left in place - check the script and try again."
        : "The teardown script didn't finish successfully, so the worktree was left in place - check the script and try again.";
    case "removal_failed":
      return plural
        ? "The worktrees couldn't be fully removed and parts of them may still be on disk - refresh the list and try again, or check the folders."
        : "The worktree couldn't be fully removed and part of it may still be on disk - refresh the list and try again, or check the folder.";
  }
}
