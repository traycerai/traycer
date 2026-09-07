import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeBranchStatus,
  WorktreeHostEntryV14,
} from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV14 } from "@traycer/protocol/host/worktree-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { provenRemovable } from "@traycer-clients/shared/worktree/classify-worktree";

/**
 * Offer worktrees whose every owner belongs to the Task(s) being deleted. `provenRemovable` is classified against the post-delete state.
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
  /** True while the host-wide census can still add cleanup choices. */
  readonly isFetching: boolean;
}

const EMPTY_CANDIDATES: ReadonlyArray<TaskDeleteWorktreeCandidate> = [];
const TASK_DELETE_WORKTREE_PROBED_PAGE_LIMIT = 8;
// Hard ceiling on pages walked in one probe pass. At 8 probed rows/page this
// still covers thousands of worktrees - far beyond any real host - while a
// stale/cyclic `nextCursor` fails closed here instead of looping forever.
const TASK_DELETE_WORKTREE_MAX_PAGES = 256;

/** Fail closed on any page error. This host only. Pass null while the dialog is closed. */
export function useTaskDeleteWorktreeCandidates(
  deletedEpicIds: ReadonlyArray<string> | null,
): TaskDeleteWorktreeCandidatesResult {
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  // Cache identity for the whole paged walk. `forceRefresh: false`: opening
  // the dialog is an automatic read, so it serves the host's TTL-cached view
  // rather than forcing a disk recompute of every managed worktree.
  const queryParams = {
    includeActivity: true,
    activityPaths: null,
    cursor: null,
    limit: TASK_DELETE_WORKTREE_PROBED_PAGE_LIMIT,
    forceRefresh: false,
  } as const;
  const fetchWorktreePages =
    async (): Promise<WorktreeListAllForHostResponseV14> => {
      const worktrees: WorktreeHostEntryV14[] = [];
      // Either way the destructive dialog must fail closed (an error yields zero candidates) rather than probe forever.
      // A repeated cursor means the host is cycling; a run past the page cap means it is handing out fresh cursors without ever terminating.
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < TASK_DELETE_WORKTREE_MAX_PAGES; page += 1) {
        const response: WorktreeListAllForHostResponseV14 =
          await client.request("worktree.listAllForHost", {
            ...queryParams,
            cursor,
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
  // Boundary-wrapped: the pagination guards above throw bare `Error`s, which
  // must not leak through the declared `HostRpcError` generic. Stays a NAMED
  // queryFn so the closure is not mistaken for missing cache identity.
  const fetchWorktreePagesNormalized =
    (): Promise<WorktreeListAllForHostResponseV14> =>
      withHostQueryErrorBoundary("worktree.listAllForHost", fetchWorktreePages);
  const { data, isError, isFetching } = useQuery(
    queryOptions<WorktreeListAllForHostResponseV14, HostRpcError>({
      queryKey: hostQueryKeys.method<
        HostRpcRegistry,
        "worktree.listAllForHost"
      >(readiness.hostId, "worktree.listAllForHost", queryParams),
      queryFn: fetchWorktreePagesNormalized,
      enabled: deletedEpicIds !== null && readiness.isReady,
      retry: false,
    }),
  );

  // Suppress candidates whenever the query is in an error state so a failed refresh can never offer stale (possibly already deleted) worktree paths - "failure -> no candidates".
  const worktrees = data?.worktrees;
  const candidates = useMemo<ReadonlyArray<TaskDeleteWorktreeCandidate>>(() => {
    if (deletedEpicIds === null || worktrees === undefined || isError) {
      return EMPTY_CANDIDATES;
    }
    const deletedSet = new Set(deletedEpicIds);
    return worktrees.flatMap((entry) => {
      if (entry.resolvedAt === null) return [];
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
          // Model the POST-delete state: every owner here is being removed, so clear `owners` before the shared green check.
          provenRemovable: provenRemovable({ ...entry, owners: [] }),
        },
      ];
    });
  }, [deletedEpicIds, isError, worktrees]);

  return { candidates, isError, isFetching };
}
