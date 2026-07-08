import { useMemo } from "react";
import type { WorktreeBranchStatus } from "@traycer/protocol/host/index";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { provenRemovable } from "@traycer-clients/shared/worktree/classify-worktree";

/**
 * A host worktree the Task-delete dialog may offer to clean up: it has at least
 * one owner, EVERY owner belongs to the Task(s) being deleted, and it is not
 * busy right now. `ownerEpicIds` is carried so the mutation can re-confirm, once
 * the delete result is known, that every owner actually succeeded before
 * removing the worktree. `provenRemovable` is the shared classifier verdict that
 * decides the default-checked state - computed against the POST-delete state
 * (every owner is being removed), so an owned-but-otherwise-green worktree
 * defaults checked here even though its live `owners` keep it out of the green
 * tiers on the always-on Worktrees list.
 */
export interface TaskDeleteWorktreeCandidate {
  readonly worktreePath: string;
  readonly repoLabel: string;
  readonly branch: string | null;
  readonly uncommittedCount: number;
  readonly branchStatus: WorktreeBranchStatus | null;
  readonly ownerEpicIds: ReadonlyArray<string>;
  readonly provenRemovable: boolean;
}

export interface TaskDeleteWorktreeCandidatesResult {
  readonly candidates: ReadonlyArray<TaskDeleteWorktreeCandidate>;
  readonly isError: boolean;
}

const EMPTY_CANDIDATES: ReadonlyArray<TaskDeleteWorktreeCandidate> = [];

/**
 * Derives the worktree-cleanup candidates for a pending Task deletion, entirely
 * client-side over `worktree.listAllForHost@1.1` (no dedicated RPC — the
 * released method-name surface is frozen). Passes `includeActivity: true` so the
 * shared `provenRemovable` classifier can evaluate the PR / at-base / ancestry
 * proofs: default-checked is reserved for PROVEN-removable candidates; unproven
 * (null status) and dirty ones default unchecked. `owners` is populated either
 * way.
 *
 * Scoped to the default-host client: candidates are computed against the
 * dialog's own host connection only. Worktrees a Task owned on OTHER hosts are
 * not offered here — the housekeeping skill / Settings tab on that host catch
 * them later.
 *
 * Pass `null` while the dialog is closed to disable the query. A failed query
 * or zero matches both yield an empty candidate list, so the dialog degrades to
 * exactly today's confirmation.
 */
export function useTaskDeleteWorktreeCandidates(
  deletedEpicIds: ReadonlyArray<string> | null,
): TaskDeleteWorktreeCandidatesResult {
  const client = useHostClient();
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listAllForHost",
    // Whole-list mode (all worktrees), enriched: the candidate classifier needs
    // every row's activity, not a viewport slice.
    params: { includeActivity: true, activityPaths: null },
    options: { enabled: deletedEpicIds !== null },
  });

  // `listAllForHost` is the SHARED host-wide key (Settings / folder + worktree
  // pickers populate it), so React Query can retain the last successful data
  // after a failed refetch. Suppress candidates whenever the query is in an
  // error state so a failed refresh can never offer stale (possibly already
  // deleted) worktree paths - "failure -> no candidates".
  const isError = query.isError;
  const worktrees = query.data?.worktrees;
  const candidates = useMemo<ReadonlyArray<TaskDeleteWorktreeCandidate>>(() => {
    if (deletedEpicIds === null || worktrees === undefined || isError) {
      return EMPTY_CANDIDATES;
    }
    const deletedSet = new Set(deletedEpicIds);
    return worktrees.flatMap((entry) => {
      if (entry.inUse) return [];
      if (entry.owners.length === 0) return [];
      if (!entry.owners.every((owner) => deletedSet.has(owner.epicId))) {
        return [];
      }
      return [
        {
          worktreePath: entry.worktreePath,
          repoLabel: entry.repoLabel,
          branch: entry.branch,
          uncommittedCount: entry.uncommittedCount,
          branchStatus: entry.branchStatus,
          ownerEpicIds: entry.owners.map((owner) => owner.epicId),
          // Model the POST-delete state: every owner here is being removed, so
          // clear `owners` before the shared green check. Otherwise the live
          // reference would keep an at-tip branch out of the `unreferenced` green
          // tier and wrongly default it unchecked.
          provenRemovable: provenRemovable({ ...entry, owners: [] }),
        },
      ];
    });
  }, [deletedEpicIds, isError, worktrees]);

  return { candidates, isError };
}
