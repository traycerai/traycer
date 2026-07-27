import { useMemo } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useHostClient } from "@/lib/host";
import { epicMutationKeys } from "@/lib/query-keys";
import { invalidateWorktreeListingAndBindingCaches } from "@/hooks/worktree/invalidations";
import { useWorktreeDeleteStreamTransportFactory } from "@/lib/host/use-worktree-delete-stream-transport";
import { runWorktreeCleanup } from "@/lib/epics/run-worktree-cleanup";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type {
  RemovedBranchRepo,
  RemovedWorktreeRefs,
} from "@/lib/worktree/removed-worktree-refs";

/**
 * One approved sweep target. `branch` rides along (from the candidate row) so
 * completion can purge staged/remembered intents that reference the deleted
 * branch - the wire calls only consume `worktreePath`.
 */
export interface SweepTargetWorktree {
  readonly worktreePath: string;
  readonly branch: string | null;
  /**
   * Repository the branch belongs to, so the intent purge can qualify the
   * branch name and leave another repo's same-named branch alone. `null` when
   * the host could not identify the repo (no parseable origin).
   */
  readonly repoIdentifier: RemovedBranchRepo | null;
}

export interface SweepWorktreesVariables {
  readonly worktrees: ReadonlyArray<SweepTargetWorktree>;
}

export interface SweepWorktreesResult {
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly hostId: string;
}

/**
 * The Sweep action: streams one `worktree.deleteByPath` per approved path via
 * the shared cleanup runner (host-side busy-check intact, headless teardown
 * best-effort), then refreshes the worktree listing/binding caches so the
 * history PR pills, task rollups, and the task-status strip converge. A bare
 * `useMutation` rather than `useHostMutation`: there is no single host RPC
 * here - the whole mutation is the streamed multi-path run. `hostId` is
 * captured once at mutate time inside the mutationFn, so a host swap
 * mid-flight can't redirect the tail of the run or its cache invalidation.
 *
 * Runs in the BACKGROUND (matching Settings worktree deletion): the dialog
 * closes at confirm, the kickoff is acknowledged once the host-connection
 * guard has passed, and the outcome lands as a summary toast when every
 * stream settles.
 */
export function useEpicSweepWorktrees(): UseMutationResult<
  SweepWorktreesResult,
  Error,
  SweepWorktreesVariables
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const openStreamTransport = useWorktreeDeleteStreamTransportFactory();
  return useMutation<SweepWorktreesResult, Error, SweepWorktreesVariables>({
    mutationKey: epicMutationKeys.sweepWorktrees(),
    mutationFn: async (variables) => {
      const hostId = client.getActiveHostId();
      if (hostId === null) {
        throw new Error("No host connection - can't sweep worktrees.");
      }
      // Acknowledged here rather than in `onMutate`: the connection guard
      // above runs first, so a disconnected host shows ONLY its error toast
      // instead of "Sweeping 2 worktrees…" immediately contradicted by "No
      // host connection".
      const count = variables.worktrees.length;
      toast.info(
        `Sweeping ${count} worktree${count === 1 ? "" : "s"} in the background…`,
      );
      const outcome = await runWorktreeCleanup(
        openStreamTransport,
        hostId,
        variables.worktrees.map((target) => target.worktreePath),
      );
      return { ...outcome, hostId };
    },
    onSuccess: (result, variables) => {
      emitSweepSummaryToast(result.removed.length, result.failed.length);
      purgeIntentsForRemovedWorktrees(variables.worktrees, result.removed);
      invalidateWorktreeListingAndBindingCaches(queryClient, result.hostId);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}

/**
 * Drops staged + remembered composer intents that reference the worktrees a
 * settled sweep ACTUALLY removed (failed paths keep their intents - the
 * worktree still exists). Without this, a pick staged before the sweep keeps
 * offering the deleted worktree as an "existing worktree" in new chats: the
 * staged tier is deliberately never re-validated by the composer seeding.
 */
function purgeIntentsForRemovedWorktrees(
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
  useWorktreeIntentStagingStore.getState().purgeRemovedWorktreeIntents(removed);
  useWorktreeIntentMemoryStore.getState().purgeRemovedWorktreeIntents(removed);
}

/**
 * Worktree paths with an in-flight sweep, read from the mutation cache by the
 * shared key rather than from one hook instance. The Sweep dialog is mounted
 * independently per surface (a History row and the task-status strip each
 * render their own), so a component-local `isPending` would only ever see the
 * run IT started - reopening from the other surface would happily re-stream
 * the same paths. Mirrors `usePendingSetPinnedEpicIds`.
 */
export function useSweepingWorktreePaths(): ReadonlySet<string> {
  const pendingVariables = useMutationState({
    filters: {
      mutationKey: epicMutationKeys.sweepWorktrees(),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });
  return useMemo(
    () =>
      new Set(
        pendingVariables.flatMap((variables) =>
          isSweepWorktreesVariables(variables)
            ? variables.worktrees.map((target) => target.worktreePath)
            : [],
        ),
      ),
    [pendingVariables],
  );
}

function isSweepWorktreesVariables(
  value: unknown,
): value is SweepWorktreesVariables {
  if (value === null || typeof value !== "object") return false;
  if (!("worktrees" in value)) return false;
  const { worktrees } = value;
  if (!Array.isArray(worktrees)) return false;
  return worktrees.every(isSweepTargetWorktree);
}

function isSweepTargetWorktree(value: unknown): value is SweepTargetWorktree {
  if (value === null || typeof value !== "object") return false;
  if (!("worktreePath" in value)) return false;
  return typeof value.worktreePath === "string";
}

function emitSweepSummaryToast(removed: number, failed: number): void {
  const removedPart = `${removed} worktree${removed === 1 ? "" : "s"} swept`;
  if (failed === 0) {
    toast.success(removedPart);
    return;
  }
  const failedPart = `${failed} couldn't be removed`;
  reportableWarningToast(
    removed > 0 ? `${removedPart}, ${failedPart}` : `Sweep: ${failedPart}`,
    undefined,
    {
      title: "Sweep incomplete",
      message: null,
      code: null,
      source: "Worktree sweep",
    },
  );
}
