import { useMemo } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { epicMutationKeys } from "@/lib/query-keys";
import { invalidateWorktreeListingAndBindingCaches } from "@/hooks/worktree/invalidations";
import { useWorktreeDeleteStreamTransportFactory } from "@/lib/host/use-worktree-delete-stream-transport";
import {
  runWorktreeCleanup,
  worktreeCleanupFailureDetail,
  type WorktreeCleanupFailure,
  type WorktreeCleanupOutcome,
} from "@/lib/epics/run-worktree-cleanup";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type {
  RemovedBranchRepo,
  RemovedWorktreeRefs,
} from "@/lib/worktree/removed-worktree-refs";

export interface SweepTargetWorktree {
  readonly worktreePath: string;
  readonly branch: string | null;
  /** Repository the branch belongs to, so the intent purge can qualify the branch name and leave another repo's same-named branch alone. */
  readonly repoIdentifier: RemovedBranchRepo | null;
  /** In-use rows the user selected deliberately: deleteByPath with stopOwners. */
  readonly stopOwners: boolean;
}

export interface SweepWorktreesVariables {
  /** Host on which the dialog's act-time safety proof was computed. */
  readonly hostId: string;
  /** The one Task that initiated the sweep; absent for bulk Task sweeps. */
  readonly epicId?: string;
  readonly worktrees: ReadonlyArray<SweepTargetWorktree>;
}

export interface SweepWorktreesResult {
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<WorktreeCleanupFailure>;
  readonly uncertain: ReadonlyArray<string>;
  readonly hostId: string;
}

/**
 * Bare `useMutation`: there is no single host RPC. `hostId` is the candidate query's act-time proof so a swap between proof and confirm cannot redirect the command or invalidation.
 */
export function useEpicSweepWorktrees(): UseMutationResult<
  SweepWorktreesResult,
  Error,
  SweepWorktreesVariables
> {
  const queryClient = useQueryClient();
  const openStreamTransport = useWorktreeDeleteStreamTransportFactory();
  return useMutation<SweepWorktreesResult, Error, SweepWorktreesVariables>({
    mutationKey: epicMutationKeys.sweepWorktrees(),
    mutationFn: async (variables) => {
      // Acknowledged here rather than in `onMutate`: the proof's host identity
      // is already frozen in the variables, so the command cannot move onto
      // whichever host happens to be active now.
      const count = variables.worktrees.length;
      toast.info(
        `Sweeping ${count} worktree${count === 1 ? "" : "s"} in the background…`,
      );
      const stopOwnersPaths = new Set(
        variables.worktrees.flatMap((target) =>
          target.stopOwners ? [target.worktreePath] : [],
        ),
      );
      const outcome = await runWorktreeCleanup(openStreamTransport, {
        hostId: variables.hostId,
        paths: variables.worktrees.map((target) => target.worktreePath),
        source: "task_sweep",
        epicId: variables.epicId,
        stopOwnersPaths,
      });
      return { ...outcome, hostId: variables.hostId };
    },
    onSuccess: (result, variables) => {
      const settled =
        result.removed.length > 0 ||
        result.failed.length > 0 ||
        result.uncertain.length > 0;
      emitSweepSummaryToast(result);
      if (settled) {
        purgeIntentsForRemovedWorktrees(
          result.hostId,
          variables.worktrees,
          result.removed,
        );
        invalidateWorktreeListingAndBindingCaches(queryClient, result.hostId);
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}

/**
 * Drop staged/remembered intents for worktrees the sweep actually removed. `hostId` is the act-time proof so another host's identically named path is untouched.
 */
function purgeIntentsForRemovedWorktrees(
  hostId: string,
  targets: ReadonlyArray<SweepTargetWorktree>,
  removedPaths: ReadonlyArray<string>,
): void {
  if (removedPaths.length === 0) return;
  const removedSet = new Set(removedPaths);
  const removed: RemovedWorktreeRefs = {
    worktreePaths: removedSet,
    branches: targets.flatMap((target) =>
      target.branch !== null && removedSet.has(target.worktreePath)
        ? [{ repoIdentifier: target.repoIdentifier, branch: target.branch }]
        : [],
    ),
  };
  useWorktreeIntentStagingStore
    .getState()
    .purgeRemovedWorktreeIntents(hostId, removed);
  useWorktreeIntentMemoryStore
    .getState()
    .purgeRemovedWorktreeIntents(hostId, removed);
}

/** Worktree paths with an in-flight sweep, read from the mutation cache by the shared key rather than from one hook instance. */
export function useSweepingWorktreePaths(
  hostId: string | null,
): ReadonlySet<string> {
  const pendingVariables = useMutationState({
    filters: {
      mutationKey: epicMutationKeys.sweepWorktrees(),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });
  return useMemo(
    () => sweepingWorktreePathsForHost(pendingVariables, hostId),
    [hostId, pendingVariables],
  );
}

export function sweepingWorktreePathsForHost(
  pendingVariables: ReadonlyArray<unknown>,
  hostId: string | null,
): ReadonlySet<string> {
  return new Set(
    pendingVariables.flatMap((variables) =>
      isSweepWorktreesVariables(variables) && variables.hostId === hostId
        ? variables.worktrees.map((target) => target.worktreePath)
        : [],
    ),
  );
}

function isSweepWorktreesVariables(
  value: unknown,
): value is SweepWorktreesVariables {
  if (value === null || typeof value !== "object") return false;
  if (!("hostId" in value) || !("worktrees" in value)) return false;
  const { hostId, worktrees } = value;
  if (typeof hostId !== "string") return false;
  if (!Array.isArray(worktrees)) return false;
  return worktrees.every(isSweepTargetWorktree);
}

function isSweepTargetWorktree(value: unknown): value is SweepTargetWorktree {
  if (value === null || typeof value !== "object") return false;
  if (!("worktreePath" in value)) return false;
  if (typeof value.worktreePath !== "string") return false;
  if (!("stopOwners" in value)) return true;
  return typeof value.stopOwners === "boolean";
}

export interface SweepWorktreeSummary {
  readonly level: "success" | "warning";
  readonly message: string;
  /** Never goes into the report-issue context - it names absolute paths. */
  readonly detail: string | null;
}

export function sweepWorktreeSummary(
  outcome: WorktreeCleanupOutcome,
): SweepWorktreeSummary | null {
  const removed = outcome.removed.length;
  const failed = outcome.failed.length;
  const uncertain = outcome.uncertain.length;
  if (removed === 0 && failed === 0 && uncertain === 0) return null;
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(`${removed} worktree${removed === 1 ? "" : "s"} swept`);
  }
  if (failed > 0) {
    parts.push(
      `${failed} worktree${failed === 1 ? "" : "s"} couldn't be removed`,
    );
  }
  // A dropped observation is not a filesystem failure. The host still owns
  // the command and its durable completion row will carry the actual counts.
  if (uncertain > 0) {
    parts.push(
      `${uncertain} worktree${uncertain === 1 ? "" : "s"} unconfirmed`,
    );
  }
  return {
    level: failed === 0 && uncertain === 0 ? "success" : "warning",
    message: parts.join(", "),
    detail: worktreeCleanupFailureDetail(outcome.failed),
  };
}

function emitSweepSummaryToast(outcome: WorktreeCleanupOutcome): void {
  const summary = sweepWorktreeSummary(outcome);
  if (summary === null) return;
  if (summary.level === "success") {
    toast.success(summary.message);
    return;
  }
  reportableWarningToast(
    summary.message,
    // The reason the host gave, on screen at the moment of the action. The
    // report context below stays fixed product copy: a report is public and
    // these reasons name absolute paths.
    summary.detail === null ? undefined : { description: summary.detail },
    {
      title: "Sweep incomplete",
      message: null,
      code: null,
      source: "Worktree sweep",
    },
  );
}
