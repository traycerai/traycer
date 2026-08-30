import { useMemo } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
import { sanitizeHoldersRevision } from "@/lib/worktree/teardown-holder-copy";

// Same bound as run-worktree-cleanup's fallback fan-out.
const MAX_PARALLEL_CLEANUP_STREAMS = 2;

type PathHolderInventory =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "ready";
      readonly holders: readonly WorktreeBusyHolder[];
      readonly holdersRevision: string | undefined;
    };

interface SweepCandidatesPayload {
  readonly listing: WorktreeListAllForHostResponseV14;
  readonly holdersByPath: ReadonlyMap<string, PathHolderInventory>;
}

/**
 * Why a row is not default-checked (or not checkable at all). `shared` and
 * `not-landed` rows stay CHECKABLE - the user may consciously sweep them -
 * while `checking` (facts unverified) rows are disabled. `in-use` rows
 * stay checkable-unchecked: selecting them is a deliberate stop-and-sweep.
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
  /**
   * T2 holder inventory from `worktree.listHolders`. Empty for idle rows
   * and for the unknown fallback (unsupported host / failed read /
   * inUse-with-empty race).
   */
  readonly holders: readonly WorktreeBusyHolder[];
  /**
   * `none` for idle rows. In-use rows start `loading` (not selectable)
   * until listHolders resolves or degrades to `unknown`. Loading is
   * never treated as empty.
   */
  readonly holdersStatus: "none" | "loading" | "ready" | "unknown";
  /**
   * Host digest of the ready inventory. Echo as
   * `expectedHoldersRevision` on delete. Absent on old hosts and on
   * the unknown fallback.
   */
  readonly holdersRevision: string | undefined;
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
  /**
   * Re-runs the same bounded, forced proof used when the dialog opens and
   * resolves with the freshly classified rows (not a stale render closure).
   */
  readonly refresh: () => Promise<ReadonlyArray<EpicSweepWorktreeRow>>;
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
 * checkable except unverified rows; in-use is checkable-unchecked), so the
 * dialog shows the full worktree picture rather than a silently pre-filtered
 * subset.
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
  const fetchFreshTaskWorktrees = async (): Promise<SweepCandidatesPayload> => {
    if (client === null) {
      throw hostClientUnavailableError("worktree.listAllForHost");
    }
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
    if (ownedPaths.length === 0) {
      return {
        listing: { worktrees: [], nextCursor: null },
        holdersByPath: new Map(),
      };
    }
    const listing = await client.request("worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: ownedPaths,
      cursor: null,
      limit: null,
      forceRefresh: true,
    });
    const holdersByPath = await loadHoldersForInUseRows(
      client,
      listing.worktrees,
    );
    return { listing, holdersByPath };
  };
  const fetchFreshTaskWorktreesNormalized =
    (): Promise<SweepCandidatesPayload> =>
      withHostQueryErrorBoundary(
        "worktree.listAllForHost",
        fetchFreshTaskWorktrees,
      );
  const { data, isFetching, isError, refetch } = useQuery(
    queryOptions<SweepCandidatesPayload, HostRpcError>({
      queryKey: hostQueryKeys.sweepWorktreeCandidates(
        readiness.hostId,
        selectedEpicKey,
      ),
      queryFn: fetchFreshTaskWorktreesNormalized,
      enabled:
        selectedEpicIds !== null &&
        selectedEpicIds.length > 0 &&
        readiness.isReady,
      staleTime: 0,
      retry: false,
      initialData: () => {
        if (selectedEpicIds === null || readiness.hostId === null) {
          return undefined;
        }
        const listing = cachedTaskWorktrees(
          queryClient,
          readiness.hostId,
          selectedEpicIds,
        );
        if (listing === undefined) return undefined;
        return { listing, holdersByPath: new Map() };
      },
      initialDataUpdatedAt: 0,
    }),
  );

  const refresh = async (): Promise<ReadonlyArray<EpicSweepWorktreeRow>> => {
    const result = await refetch();
    if (result.error !== null) {
      toastFromHostError(result.error, "Couldn't refresh worktree details.");
      throw result.error;
    }
    if (selectedEpicIds === null || result.data === undefined) return [];
    return classifyOwnedSweepRows(
      selectedEpicIds,
      result.data.listing.worktrees,
      result.data.holdersByPath,
    );
  };

  const isPending =
    selectedEpicIds !== null && selectedEpicIds.length > 0 && isFetching;
  const canRefresh =
    selectedEpicIds !== null && selectedEpicIds.length > 0 && readiness.isReady;
  const worktrees = data?.listing.worktrees;
  const holdersByPath = data?.holdersByPath;
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
  const rows = classifyOwnedSweepRows(
    selectedEpicIds,
    worktrees,
    holdersByPath ?? new Map(),
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

function classifyOwnedSweepRows(
  selectedEpicIds: ReadonlyArray<string>,
  worktrees: readonly WorktreeHostEntryV14[],
  holdersByPath: ReadonlyMap<string, PathHolderInventory>,
): EpicSweepWorktreeRow[] {
  const selected = new Set(selectedEpicIds);
  return worktrees.flatMap((entry) =>
    entry.owners.some((owner) => selected.has(owner.epicId))
      ? [
          applyHolderInventory(
            classifySweepRow(selected, entry),
            holdersByPath.get(entry.worktreePath),
          ),
        ]
      : [],
  );
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

function applyHolderInventory(
  row: EpicSweepWorktreeRow,
  inventory: PathHolderInventory | undefined,
): EpicSweepWorktreeRow {
  if (row.note !== "in-use") {
    return { ...row, holdersStatus: "none", holdersRevision: undefined };
  }
  if (inventory === undefined) {
    return {
      ...row,
      disabled: true,
      holders: [],
      holdersStatus: "loading",
      holdersRevision: undefined,
    };
  }
  if (inventory.kind === "unknown") {
    return {
      ...row,
      disabled: false,
      holders: [],
      holdersStatus: "unknown",
      holdersRevision: undefined,
    };
  }
  return {
    ...row,
    disabled: false,
    holders: inventory.holders,
    holdersStatus: "ready",
    holdersRevision: inventory.holdersRevision,
  };
}

async function loadHoldersForInUseRows(
  client: HostClient<HostRpcRegistry>,
  worktrees: readonly WorktreeHostEntryV14[],
): Promise<ReadonlyMap<string, PathHolderInventory>> {
  const inUse = worktrees.filter((entry) => entry.inUse);
  if (inUse.length === 0) return new Map();
  const loaded: Array<readonly [string, PathHolderInventory]> = [];
  const queue = [...inUse];
  const worker = async (): Promise<void> => {
    for (
      let entry = queue.shift();
      entry !== undefined;
      entry = queue.shift()
    ) {
      const inventory = await readPathHolderInventory(
        client,
        entry.worktreePath,
      );
      loaded.push([entry.worktreePath, inventory]);
    }
  };
  const workerCount = Math.min(MAX_PARALLEL_CLEANUP_STREAMS, inUse.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return new Map(loaded);
}

async function readPathHolderInventory(
  client: HostClient<HostRpcRegistry>,
  worktreePath: string,
): Promise<PathHolderInventory> {
  try {
    const response = await client.request("worktree.listHolders", {
      worktreePath,
      owner: null,
    });
    const holdersRevision = sanitizeHoldersRevision(response.holdersRevision);
    // Empty inventory or a missing digest cannot form consent — same
    // unknown fallback as an unsupported host.
    if (response.holders.length === 0 || holdersRevision === undefined) {
      return { kind: "unknown" };
    }
    return {
      kind: "ready",
      holders: response.holders,
      holdersRevision,
    };
  } catch {
    return { kind: "unknown" };
  }
}

function classifySweepRow(
  selectedEpicIds: ReadonlySet<string>,
  entry: WorktreeHostEntryV14,
): EpicSweepWorktreeRow {
  const tier = classifyWorktreeTier(entry);
  const base = {
    entry,
    tier,
    defaultChecked: false,
    holders: [],
    holdersStatus: "none" as const,
    holdersRevision: undefined,
  };
  if (entry.inUse) {
    return {
      ...base,
      disabled: true,
      note: "in-use",
      holdersStatus: "loading",
    };
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
