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

// Same bound as run-worktree-cleanup's fallback fan-out.
const MAX_PARALLEL_CLEANUP_STREAMS = 2;

type PathHolderInventory =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "ready";
      readonly holders: readonly WorktreeBusyHolder[];
    };

interface SweepCandidatesPayload {
  readonly listing: WorktreeListAllForHostResponseV14;
  readonly holdersByPath: ReadonlyMap<string, PathHolderInventory>;
}

export type EpicSweepRowNote = "shared" | "in-use" | "checking" | "not-landed";

export interface EpicSweepWorktreeRow {
  readonly entry: WorktreeHostEntryV14;
  readonly tier: WorktreeTier;
  /** Green tier + exclusively owned + not busy: starts checked. */
  readonly defaultChecked: boolean;
  /** Disabled rows can never be swept from this dialog. */
  readonly disabled: boolean;
  readonly note: EpicSweepRowNote | null;
  /** T2 holder inventory from `worktree.listHolders`. */
  readonly holders: readonly WorktreeBusyHolder[];
  /** Loading is never treated as empty. */
  readonly holdersStatus: "none" | "loading" | "ready" | "unknown";
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
  /** Re-runs the same bounded, forced proof used when the dialog opens and resolves with the freshly classified rows (not a stale render closure). */
  readonly refresh: () => Promise<ReadonlyArray<EpicSweepWorktreeRow>>;
  /** Same fetch as `refresh`, but through the query CACHE rather than this hook's observer, so it joins a refresh already in flight and keeps running after the dialog unmounts - the flow never holds the user in a modal for it. */
  readonly prove: () => Promise<ReadonlyArray<EpicSweepWorktreeRow>>;
}

const EMPTY_ROWS: ReadonlyArray<EpicSweepWorktreeRow> = [];

/** Act-time proof on this client's host, not a cached listing. Stale PR facts only under-claim, never false-green. */
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
  const { data, isFetching, isError, refetch } = useQuery(
    queryOptions<SweepCandidatesPayload, HostRpcError>({
      ...sweepCandidatesQueryOptions(client, readiness.hostId, selectedEpicIds),
      enabled:
        selectedEpicIds !== null &&
        selectedEpicIds.length > 0 &&
        readiness.isReady,
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
  const prove = (): Promise<ReadonlyArray<EpicSweepWorktreeRow>> =>
    proveSweepCandidates({
      queryClient,
      client,
      hostId: readiness.hostId,
      selectedEpicIds,
    });

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
      prove,
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
    prove,
  };
}

/** The ONE place the candidates query's identity and fetch are written, so the hook's observer and the click-time proof (`proveSweepCandidates`) can never drift onto different keys - which is what lets the proof join a refresh already in flight instead of racing it. */
function sweepCandidatesQueryOptions(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  selectedEpicIds: ReadonlyArray<string> | null,
) {
  // The key names the HOST (`hostId`) rather than the client object: a client
  // is the requester for exactly one host, so the identity is already in the
  // key, and the object itself is not a cache identity.
  const queryFn = (): Promise<SweepCandidatesPayload> =>
    withHostQueryErrorBoundary("worktree.listAllForHost", () =>
      fetchSweepCandidatesPayload(client, selectedEpicIds),
    );
  return queryOptions<SweepCandidatesPayload, HostRpcError>({
    queryKey: hostQueryKeys.sweepWorktreeCandidates(
      hostId,
      selectedEpicIds === null ? "" : selectedEpicIds.join(","),
    ),
    queryFn,
    staleTime: 0,
    retry: false,
  });
}

async function fetchSweepCandidatesPayload(
  client: HostClient<HostRpcRegistry> | null,
  selectedEpicIds: ReadonlyArray<string> | null,
): Promise<SweepCandidatesPayload> {
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
}

/**
 * `fetchQuery` at `staleTime: 0` de-dupes onto an in-flight refresh and runs with no observer, so the dialog can close while the proof answers. Toast and rethrow failures here.
 */
async function proveSweepCandidates(input: {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly selectedEpicIds: ReadonlyArray<string> | null;
}): Promise<ReadonlyArray<EpicSweepWorktreeRow>> {
  const { selectedEpicIds } = input;
  if (selectedEpicIds === null || input.client === null) {
    throw hostClientUnavailableError("worktree.listAllForHost");
  }
  try {
    const payload = await input.queryClient.fetchQuery(
      sweepCandidatesQueryOptions(input.client, input.hostId, selectedEpicIds),
    );
    return classifyOwnedSweepRows(
      selectedEpicIds,
      payload.listing.worktrees,
      payload.holdersByPath,
    );
  } catch (error) {
    if (error instanceof HostRpcError) {
      toastFromHostError(error, "Couldn't check worktree details.");
    }
    throw error;
  }
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

/** Folds the already-mounted task provenance queries into a first-paint snapshot for Sweep. */
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
    return { ...row, holdersStatus: "none" };
  }
  if (inventory === undefined) {
    return {
      ...row,
      disabled: true,
      holders: [],
      holdersStatus: "loading",
    };
  }
  if (inventory.kind === "unknown") {
    return {
      ...row,
      disabled: false,
      holders: [],
      holdersStatus: "unknown",
    };
  }
  return {
    ...row,
    disabled: false,
    holders: inventory.holders,
    holdersStatus: "ready",
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
    if (response.holders.length === 0) {
      return { kind: "unknown" };
    }
    return {
      kind: "ready",
      holders: response.holders,
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
