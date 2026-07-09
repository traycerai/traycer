import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV11,
} from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV11 } from "@traycer/protocol/host/worktree-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
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
const TASK_DELETE_WORKTREE_PROBED_PAGE_LIMIT = 8;
// Hard ceiling on pages walked in one probe pass. At 8 probed rows/page this
// still covers thousands of worktrees - far beyond any real host - while a
// stale/cyclic `nextCursor` fails closed here instead of looping forever.
const TASK_DELETE_WORKTREE_MAX_PAGES = 256;

/**
 * Derives the worktree-cleanup candidates for a pending Task deletion, entirely
 * client-side over `worktree.listAllForHost@1.1` (no dedicated RPC — the
 * released method-name surface is frozen). It loops finite, activity-probed
 * pages explicitly: `provenRemovable` needs PR / at-base / ancestry proofs, and
 * default-checked is reserved for proven-removable candidates. The destructive
 * dialog must see the complete host-wide owner set, so any page error fails
 * closed rather than passing a partial accumulation as complete.
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
  const readiness = useReactiveHostReadiness(client);
  const queryParams = {
    includeActivity: true,
    activityPaths: null,
    cursor: null,
    limit: TASK_DELETE_WORKTREE_PROBED_PAGE_LIMIT,
  } as const;
  const fetchWorktreePages =
    async (): Promise<WorktreeListAllForHostResponseV11> => {
      const worktrees: WorktreeHostEntryV11[] = [];
      // A repeated cursor means the host is cycling; a run past the page cap
      // means it is handing out fresh cursors without ever terminating. Either
      // way the destructive dialog must fail closed (an error yields zero
      // candidates) rather than probe forever.
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < TASK_DELETE_WORKTREE_MAX_PAGES; page += 1) {
        const response: WorktreeListAllForHostResponseV11 =
          await client.request("worktree.listAllForHost", {
            includeActivity: true,
            activityPaths: null,
            cursor,
            limit: TASK_DELETE_WORKTREE_PROBED_PAGE_LIMIT,
          });
        worktrees.push(...response.worktrees);
        if (response.nextCursor === null) {
          return { worktrees, nextCursor: null };
        }
        if (seenCursors.has(response.nextCursor)) {
          throw new Error(
            "worktree.listAllForHost returned a repeated pagination cursor",
          );
        }
        seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
      }
      throw new Error(
        "worktree.listAllForHost exceeded the maximum pagination page count",
      );
    };
  const { data, isError } = useQuery(
    queryOptions<WorktreeListAllForHostResponseV11, HostRpcError>({
      queryKey: hostQueryKeys.method<
        HostRpcRegistry,
        "worktree.listAllForHost"
      >(readiness.hostId, "worktree.listAllForHost", queryParams),
      queryFn: fetchWorktreePages,
      enabled: deletedEpicIds !== null && readiness.isReady,
      retry: false,
    }),
  );

  // `listAllForHost` is the SHARED host-wide key (Settings / folder + worktree
  // pickers populate it), so React Query can retain the last successful data
  // after a failed refetch. Suppress candidates whenever the query is in an
  // error state so a failed refresh can never offer stale (possibly already
  // deleted) worktree paths - "failure -> no candidates".
  const worktrees = data?.worktrees;
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
