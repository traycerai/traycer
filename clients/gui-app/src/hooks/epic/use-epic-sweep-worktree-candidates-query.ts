import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  classifyWorktreeTier,
  type WorktreeTier,
} from "@traycer-clients/shared/worktree/classify-worktree";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV14 } from "@traycer/protocol/host/worktree-schemas";
import { useHostClient } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { sweepEligibleTier } from "@/lib/worktree/sweep-candidates";

/**
 * Why a row is not default-checked (or not checkable at all). `shared` and
 * `not-landed` rows stay CHECKABLE - the user may consciously sweep them -
 * while `in-use` (host refuses anyway) and `checking` (facts unverified)
 * rows are disabled.
 */
export type EpicSweepRowNote = "shared" | "in-use" | "checking" | "not-landed";

/**
 * One task-owned worktree in the Sweep dialog. EVERY worktree the Task owns
 * is listed (Settings-grade detail rides on `entry`); only the proven-safe
 * subset starts checked.
 */
export interface EpicSweepWorktreeRow {
  readonly entry: WorktreeHostEntryV14;
  readonly tier: WorktreeTier;
  /** Green tier + exclusively owned + not busy: starts checked. */
  readonly defaultChecked: boolean;
  /** Disabled rows can never be swept from this dialog. */
  readonly disabled: boolean;
  readonly note: EpicSweepRowNote | null;
}

export interface EpicSweepWorktreeCandidatesResult {
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  /** True while the act-time probe is in flight (first open OR a re-open). */
  readonly isPending: boolean;
  readonly isError: boolean;
}

const EMPTY_ROWS: ReadonlyArray<EpicSweepWorktreeRow> = [];

/**
 * Derives the Sweep rows for one Task from an ACT-TIME proof, not the cached
 * listing. The host serves resolved rows indefinitely with `forceRefresh:
 * false` (steady-state liveness is manual-refresh-owned), so a worktree that
 * was clean+Landed when last probed but was edited from an external terminal
 * since would still read "proven safe" from cache — and `worktree.deleteByPath`
 * force-removes a dirty tree (its busy-check only covers Traycer-registered
 * owners). The dialog therefore re-proves before offering: a cheap un-probed
 * walk finds the Task's paths, then ONE selection-mode `listAllForHost` with
 * `activityPaths` = those paths and `forceRefresh: true` re-derives the disk
 * facts (uncommitted count, branch) and merge proofs — bounded by the Task's
 * worktree count, never the fleet.
 *
 * EVERY task-owned worktree is returned, classified: green + exclusive + not
 * busy rows default-checked, everything else unchecked with its reason (still
 * checkable except busy/unverified rows), so the dialog shows the Task's full
 * worktree picture rather than a silently pre-filtered subset.
 *
 * Known residual: PR facts are read non-blocking on the host, so the first
 * forced probe after an EXTERNAL merge can still serve the stale `open` fact
 * while the background `gh` re-probe lands — a just-landed row then starts
 * unchecked until the dialog is reopened. Staleness here only ever
 * under-claims, never false-greens.
 *
 * Rows are recomputed only from a settled probe (`isPending` while in flight,
 * including re-opens), so the dialog can never offer rows from a previous
 * open. Pass `null` while the dialog is closed to disable the query. Any
 * error yields zero rows ("failure -> no candidates"); the host-side
 * busy-check on `worktree.deleteByPath` remains the authoritative backstop
 * either way.
 */
export function useEpicSweepWorktreeCandidates(
  epicId: string | null,
): EpicSweepWorktreeCandidatesResult {
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const fetchFreshTaskWorktrees =
    async (): Promise<WorktreeListAllForHostResponseV14> => {
      // Cheap disk-truth walk (no git/gh probes, host cache is fine): only
      // used to discover WHICH paths this Task owns.
      const base: WorktreeListAllForHostResponseV14 = await client.request(
        "worktree.listAllForHost",
        {
          includeActivity: false,
          activityPaths: null,
          cursor: null,
          limit: null,
          forceRefresh: false,
        },
      );
      const ownedPaths = base.worktrees.flatMap((entry) =>
        entry.owners.some((owner) => owner.epicId === epicId)
          ? [entry.worktreePath]
          : [],
      );
      if (ownedPaths.length === 0) return { worktrees: [], nextCursor: null };
      // The act-time proof: forced selection-mode re-derive of exactly the
      // Task's paths. Selection mode caps the probe cost by the array itself.
      return client.request("worktree.listAllForHost", {
        includeActivity: true,
        activityPaths: ownedPaths,
        cursor: null,
        limit: null,
        forceRefresh: true,
      });
    };
  // Boundary-wrapped and NAMED so the closure is not mistaken for missing
  // cache identity.
  const fetchFreshTaskWorktreesNormalized =
    (): Promise<WorktreeListAllForHostResponseV14> =>
      withHostQueryErrorBoundary(
        "worktree.listAllForHost",
        fetchFreshTaskWorktrees,
      );
  const { data, isFetching, isError } = useQuery(
    queryOptions<WorktreeListAllForHostResponseV14, HostRpcError>({
      queryKey: hostQueryKeys.sweepWorktreeCandidates(
        readiness.hostId,
        epicId ?? "",
      ),
      queryFn: fetchFreshTaskWorktreesNormalized,
      enabled: epicId !== null && readiness.isReady,
      // Always stale: every dialog open re-runs the forced probe rather than
      // trusting a previous open's proof.
      staleTime: 0,
      retry: false,
    }),
  );

  const isPending = epicId !== null && isFetching;
  const worktrees = data?.worktrees;
  return useMemo<EpicSweepWorktreeCandidatesResult>(() => {
    // While the probe is in flight, retained data from a PREVIOUS open must
    // not surface as offerable rows — the whole point is act-time proof.
    if (epicId === null || worktrees === undefined || isError || isPending) {
      return { rows: EMPTY_ROWS, isPending, isError };
    }
    const rows = worktrees.flatMap((entry) =>
      entry.owners.some((owner) => owner.epicId === epicId)
        ? [classifySweepRow(epicId, entry)]
        : [],
    );
    return { rows, isPending: false, isError };
  }, [epicId, isError, isPending, worktrees]);
}

function classifySweepRow(
  epicId: string,
  entry: WorktreeHostEntryV14,
): EpicSweepWorktreeRow {
  const tier = classifyWorktreeTier(entry);
  const base = { entry, tier, defaultChecked: false } as const;
  if (entry.inUse) {
    return { ...base, disabled: true, note: "in-use" };
  }
  if (entry.resolvedAt === null) {
    return { ...base, disabled: true, note: "checking" };
  }
  if (entry.owners.some((owner) => owner.epicId !== epicId)) {
    return { ...base, disabled: false, note: "shared" };
  }
  if (!sweepEligibleTier(tier)) {
    return { ...base, disabled: false, note: "not-landed" };
  }
  return { ...base, defaultChecked: true, disabled: false, note: null };
}
