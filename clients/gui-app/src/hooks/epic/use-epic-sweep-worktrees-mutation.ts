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
  type WorktreeCleanupOutcome,
} from "@/lib/epics/run-worktree-cleanup";
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
  /** Host on which the dialog's act-time safety proof was computed. */
  readonly hostId: string;
  readonly worktrees: ReadonlyArray<SweepTargetWorktree>;
}

export interface SweepWorktreesResult {
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly uncertain: ReadonlyArray<string>;
  readonly hostId: string;
}

/**
 * The Sweep action: streams one host-owned batch command for every approved
 * path via the shared cleanup runner (host-side busy-check intact, headless
 * teardown best-effort), then refreshes the worktree listing/binding caches so the
 * history PR pills, task rollups, and the task-status strip converge. A bare
 * `useMutation` rather than `useHostMutation`: there is no single host RPC
 * here - the whole mutation is the streamed multi-path run. `hostId` comes
 * from the candidate query's settled act-time proof, so a host swap between
 * proof and confirm cannot redirect the command or its cache invalidation.
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
      const outcome = await runWorktreeCleanup(
        openStreamTransport,
        variables.hostId,
        variables.worktrees.map((target) => target.worktreePath),
        "task_sweep",
      );
      return { ...outcome, hostId: variables.hostId };
    },
    onSuccess: (result, variables) => {
      emitSweepSummaryToast(result);
      purgeIntentsForRemovedWorktrees(
        result.hostId,
        variables.worktrees,
        result.removed,
      );
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
 *
 * `hostId` is the host the removal ran on (the dialog's act-time proof, frozen
 * in the variables). Both stores scope by it, so only that machine's staged
 * slots and remembered defaults are touched - an identically-named path or
 * branch on another host still materializes there and keeps its pick.
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

/**
 * Worktree paths with an in-flight sweep, read from the mutation cache by the
 * shared key rather than from one hook instance. The Sweep dialog is mounted
 * independently per surface (a History row and the task-status strip each
 * render their own), so a component-local `isPending` would only ever see the
 * run IT started - reopening from the other surface would happily re-stream
 * the same paths. Mirrors `usePendingSetPinnedEpicIds`.
 */
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
  return typeof value.worktreePath === "string";
}

export interface SweepWorktreeSummary {
  readonly level: "success" | "warning";
  readonly message: string;
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
  };
}

function emitSweepSummaryToast(outcome: WorktreeCleanupOutcome): void {
  const summary = sweepWorktreeSummary(outcome);
  if (summary === null) return;
  if (summary.level === "success") {
    toast.success(summary.message);
    return;
  }
  reportableWarningToast(summary.message, undefined, {
    title: "Sweep incomplete",
    message: null,
    code: null,
    source: "Worktree sweep",
  });
}
