import { useMemo } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  classifyWorktreeTier,
  type WorktreeTier,
} from "@traycer-clients/shared/worktree/classify-worktree";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV14 } from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { isPerPathEnrichmentQueryKey } from "@/lib/query-keys/worktree-enrichment-keys";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { toastFromHostError } from "@/lib/host-error-toast";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { oldestResolvedAt } from "@/lib/worktree/oldest-resolved-at";
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
  /** Host from which the shown snapshot originated; null means no snapshot. */
  readonly hostId: string | null;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  /** True while the act-time probe is in flight (first open OR a re-open). */
  readonly isPending: boolean;
  readonly isError: boolean;
  /** When the host derived the stalest row currently shown. */
  readonly checkedAt: number | null;
  /** The selected host is ready for another forced proof. */
  readonly canRefresh: boolean;
  /** Re-runs the same bounded, forced proof used when the dialog opens. */
  readonly refresh: () => Promise<void>;
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
 * Takes the SELECTED SET of Tasks, not one Task, so History's multi-select can
 * sweep in bulk. The returned rows are the amalgamation - every worktree owned
 * by any selected Task, listed once - and "shared" is judged against the whole
 * selection: a worktree owned by two Tasks is only shared while at least one of
 * its owners is unselected, so selecting both satisfies the constraint and the
 * row becomes an ordinary candidate.
 *
 * EVERY owned worktree is returned, classified: green + exclusive + not busy
 * rows default-checked, everything else unchecked with its reason (still
 * checkable except busy/unverified rows), so the dialog shows the full worktree
 * picture rather than a silently pre-filtered subset.
 *
 * Known residual: PR facts are read non-blocking on the host, so the first
 * forced probe after an EXTERNAL merge can still serve the stale `open` fact
 * while the background `gh` re-probe lands — a just-landed row then starts
 * unchecked until the user refreshes or reopens the dialog. Staleness here
 * only ever under-claims, never false-greens.
 *
 * Cached enrichment rows are presentation-only while that proof is in flight:
 * they let the dialog paint immediately on first open and retain its previous
 * snapshot on re-open, but the caller must keep selection and Sweep disabled
 * until `isPending` and `isError` are both false. Pass `null` (or an empty
 * selection) while the dialog is closed to disable the query. The host-side
 * busy-check on `worktree.deleteByPath` remains the authoritative backstop.
 */
/**
 * Sweep-candidate rows against a caller-resolved client. The proof (and the
 * sweep it authorises, whose host id is frozen from it) is per HOST: the
 * Epics list passes the app-wide client; the Epic panel's sweep action
 * passes the Epic session's, so an Epic projected from host A is never
 * offered - or swept of - host B's worktrees.
 */
export function useEpicSweepWorktreeCandidatesForClient(
  client: HostClient<HostRpcRegistry> | null,
  epicIds: ReadonlyArray<string> | null,
): EpicSweepWorktreeCandidatesResult {
  const readiness = useReactiveHostReadiness(client);
  const queryClient = useQueryClient();
  // Sorted + de-duplicated so the cache identity does not depend on selection
  // ORDER, and so re-selecting the same tasks reuses the same query slot.
  const selectedEpicIds = useMemo(
    () => (epicIds === null ? null : [...new Set(epicIds)].sort()),
    [epicIds],
  );
  const selectedEpicKey =
    selectedEpicIds === null ? "" : selectedEpicIds.join(",");
  const fetchFreshTaskWorktrees =
    async (): Promise<WorktreeListAllForHostResponseV14> => {
      // `enabled` already requires readiness (false for a null client); this
      // is the typed guard the closure needs to call `request` at all.
      if (client === null) {
        throw hostClientUnavailableError("worktree.listAllForHost");
      }
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
      const selected = new Set(selectedEpicIds ?? []);
      const ownedPaths = base.worktrees.flatMap((entry) =>
        entry.owners.some((owner) => selected.has(owner.epicId))
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
  const { data, isFetching, isError, refetch } = useQuery(
    queryOptions<WorktreeListAllForHostResponseV14, HostRpcError>({
      queryKey: hostQueryKeys.sweepWorktreeCandidates(
        readiness.hostId,
        selectedEpicKey,
      ),
      queryFn: fetchFreshTaskWorktreesNormalized,
      enabled:
        selectedEpicIds !== null &&
        selectedEpicIds.length > 0 &&
        readiness.isReady,
      // Always stale: every dialog open re-runs the forced probe rather than
      // trusting a previous open's proof.
      staleTime: 0,
      retry: false,
      // Task and History surfaces already keep task-owned provenance enriched.
      // Seed this selection-specific proof query from that warm method cache so
      // first-open is useful immediately; the forced query still starts now
      // and is the only state that authorises the destructive action.
      initialData: () =>
        selectedEpicIds === null || readiness.hostId === null
          ? undefined
          : cachedTaskWorktrees(queryClient, readiness.hostId, selectedEpicIds),
      // The warm snapshot is not an act-time proof even if its cache write was
      // recent. Zero preserves the forced-on-open contract and retains the
      // snapshot if that proof fails.
      initialDataUpdatedAt: 0,
    }),
  );

  const refresh = async (): Promise<void> => {
    const result = await refetch();
    if (result.error === null) return;
    toastFromHostError(result.error, "Couldn't refresh worktree details.");
    throw result.error;
  };

  const isPending =
    selectedEpicIds !== null && selectedEpicIds.length > 0 && isFetching;
  const canRefresh =
    selectedEpicIds !== null && selectedEpicIds.length > 0 && readiness.isReady;
  const worktrees = data?.worktrees;
  if (
    selectedEpicIds === null ||
    readiness.hostId === null ||
    !readiness.isReady ||
    worktrees === undefined
  ) {
    return {
      hostId: null,
      rows: EMPTY_ROWS,
      isPending,
      isError,
      checkedAt: null,
      canRefresh,
      refresh,
    };
  }
  // The amalgamation: every worktree owned by ANY selected Task, listed once.
  const selected = new Set(selectedEpicIds);
  const rows = worktrees.flatMap((entry) =>
    entry.owners.some((owner) => selected.has(owner.epicId))
      ? [classifySweepRow(selected, entry)]
      : [],
  );
  return {
    hostId: readiness.hostId,
    rows,
    isPending,
    isError,
    checkedAt: oldestResolvedAt(rows.map((row) => row.entry.resolvedAt)),
    canRefresh,
    refresh,
  };
}

/**
 * Folds the already-mounted task provenance queries into a first-paint
 * snapshot for Sweep. The dedicated forced-proof key intentionally sits
 * outside this method scope, so reading the cache is the bridge between the
 * attention/event enrichment leg and the act-time safety check.
 */
function cachedTaskWorktrees(
  queryClient: QueryClient,
  hostId: string,
  selectedEpicIds: ReadonlyArray<string>,
): WorktreeListAllForHostResponseV14 | undefined {
  const selected = new Set(selectedEpicIds);
  const byPath = new Map<string, WorktreeHostEntryV14>();
  const cachedResponses =
    queryClient.getQueriesData<WorktreeListAllForHostResponseV14>({
      queryKey: hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    });
  for (const [queryKey, response] of cachedResponses) {
    if (response === undefined || !isPerPathEnrichmentQueryKey(queryKey)) {
      continue;
    }
    for (const entry of response.worktrees) {
      if (!entry.owners.some((owner) => selected.has(owner.epicId))) continue;
      const previous = byPath.get(entry.worktreePath);
      const previousResolvedAt =
        previous?.resolvedAt ?? Number.NEGATIVE_INFINITY;
      const nextResolvedAt = entry.resolvedAt ?? Number.NEGATIVE_INFINITY;
      if (previous === undefined || nextResolvedAt >= previousResolvedAt) {
        byPath.set(entry.worktreePath, entry);
      }
    }
  }
  if (byPath.size === 0) return undefined;
  return { worktrees: [...byPath.values()], nextCursor: null };
}

function classifySweepRow(
  selectedEpicIds: ReadonlySet<string>,
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
  // Exclusivity is judged against the WHOLE selection, not one Task: a
  // worktree shared by two Tasks stops being "shared" once both are selected,
  // because sweeping the selection removes every binding that referenced it.
  if (entry.owners.some((owner) => !selectedEpicIds.has(owner.epicId))) {
    return { ...base, disabled: false, note: "shared" };
  }
  if (!sweepEligibleTier(tier)) {
    return { ...base, disabled: false, note: "not-landed" };
  }
  return { ...base, defaultChecked: true, disabled: false, note: null };
}
