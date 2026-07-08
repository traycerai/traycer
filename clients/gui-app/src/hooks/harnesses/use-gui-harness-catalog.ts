import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostClient } from "@/lib/host";
import type {
  GuiHarnessOption,
  GuiHarnessId,
  ListGuiAgentCommandsResponse,
  ListGuiAgentModelsResponse,
  ListGuiHarnessesResponse,
} from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostBinding } from "@/lib/host/runtime";
import {
  useHostQuery,
  type UseHostQueryOptions,
} from "@/hooks/host/use-host-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";

// Catalog data (harness availability + model lists) changes rarely, and a cold
// model fetch can spawn the OpenCode server + resolve the shell env. Cache for
// 15 min and stop background polling; users force an update via the picker's
// refresh button (`useRefreshHarnessCatalog`) when they change provider config.
const HARNESS_CATALOG_STALE_TIME_MS = 15 * 60 * 1000;
const HARNESS_AVAILABILITY_REFRESH_MS = 15 * 60 * 1000;

// An availability probe can transiently fail - most often a cold-start SDK
// timeout for Claude (loading its ~200MB native CLI) when the host probes all
// harnesses in parallel at boot. The renderer hides any harness with
// `available: false`, so without a faster retry a transient drop stayed hidden
// for the full 15-min steady-state window (only the picker's manual refresh or
// an app restart recovered it).
//
// While any harness is unavailable we re-fetch on a backoff instead, starting at
// the host's availability-cache TTL (re-fetching faster just re-reads the same
// cached failure, since the host won't re-probe until its 30s cache expires)
// and doubling toward a few-minute ceiling. So a transient drop self-heals in
// ~30s, while a harness that is genuinely absent settles to a periodic re-check
// rather than re-spawning the heavy Claude probe every half-minute. Once every
// harness reports available we drop back to the long steady-state interval and
// stop polling.
//
// `availabilityPending` rows are different: the host returned immediately (no
// probe complete yet) and is actively working in the background. Poll fast —
// matching the authPending / versionPending cadence — until all pending flags
// clear, then fall to the normal unavailable backoff or steady-state interval.
const HARNESS_AVAILABILITY_PENDING_REFRESH_MS = 800;
const HARNESS_AVAILABILITY_RETRY_MIN_MS = 30 * 1000;
const HARNESS_AVAILABILITY_RETRY_MAX_MS = 5 * 60 * 1000;
const HARNESS_MODEL_ERROR_RETRY_MIN_MS = 30 * 1000;
const HARNESS_MODEL_ERROR_RETRY_MAX_MS = 5 * 60 * 1000;

// Consecutive "saw an unavailable harness" fetches, keyed by query hash
// (host + method + params), so the backoff advances once per fetch rather
// than on every `refetchInterval` evaluation, and resets the moment the catalog
// goes fully available. Entries are dropped on recovery, so the map only ever
// holds currently-degraded hosts.
const unavailableStreaks = new Map<
  string,
  { readonly updateCount: number; readonly attempts: number }
>();
const modelErrorStreaks = new Map<
  string,
  { readonly errorUpdateCount: number; readonly attempts: number }
>();

export function nextHarnessAvailabilityRefetchInterval(args: {
  readonly queryHash: string;
  readonly dataUpdateCount: number;
  readonly data: ListGuiHarnessesResponse | undefined;
}): number {
  const { queryHash, dataUpdateCount, data } = args;
  // No data yet (initial load) or a hard RPC rejection (handled by TanStack's
  // own retry/backoff) - keep the steady-state cadence.
  if (data === undefined) {
    unavailableStreaks.delete(queryHash);
    return HARNESS_AVAILABILITY_REFRESH_MS;
  }
  // Poll fast while the host is still running availability probes in the
  // background. Once all pending flags clear, fall through to the normal
  // unavailable backoff or steady-state interval.
  if (data.harnesses.some((harness) => harness.availabilityPending)) {
    return HARNESS_AVAILABILITY_PENDING_REFRESH_MS;
  }
  if (data.harnesses.every((harness) => harness.available)) {
    unavailableStreaks.delete(queryHash);
    return HARNESS_AVAILABILITY_REFRESH_MS;
  }
  const previous = unavailableStreaks.get(queryHash);
  // Advance the attempt count only when a new fetch has landed since we last
  // recorded one; repeated evaluations between fetches must not inflate it.
  const attempts =
    previous !== undefined && previous.updateCount === dataUpdateCount
      ? previous.attempts
      : (previous?.attempts ?? 0) + 1;
  unavailableStreaks.set(queryHash, { updateCount: dataUpdateCount, attempts });
  return Math.min(
    HARNESS_AVAILABILITY_RETRY_MIN_MS * 2 ** (attempts - 1),
    HARNESS_AVAILABILITY_RETRY_MAX_MS,
  );
}

export function nextHarnessModelRefetchInterval(args: {
  readonly queryHash: string;
  readonly errorUpdateCount: number;
  readonly error: unknown;
}): number {
  const { queryHash, errorUpdateCount, error } = args;
  if (error === null) {
    modelErrorStreaks.delete(queryHash);
    return HARNESS_CATALOG_STALE_TIME_MS;
  }
  const previous = modelErrorStreaks.get(queryHash);
  const attempts =
    previous !== undefined && previous.errorUpdateCount === errorUpdateCount
      ? previous.attempts
      : (previous?.attempts ?? 0) + 1;
  modelErrorStreaks.set(queryHash, { errorUpdateCount, attempts });
  return Math.min(
    HARNESS_MODEL_ERROR_RETRY_MIN_MS * 2 ** (attempts - 1),
    HARNESS_MODEL_ERROR_RETRY_MAX_MS,
  );
}

/**
 * Activity gating shared by the catalog/provider query hooks. `enabled`
 * controls whether the query may fetch; `subscribed` controls whether this
 * observer stays attached to cache updates. Surfaces that are merely hidden
 * (not torn down) pass both `false` to fully detach.
 */
export interface QueryActivityOptions {
  readonly enabled: boolean;
  readonly subscribed: boolean;
}

export interface GuiHarnessCatalogEntry extends GuiHarnessOption {
  readonly models: ListGuiAgentModelsResponse["models"];
  readonly modelsLoading: boolean;
  readonly modelsError: HostRpcError | null;
}

export interface GuiHarnessCatalog {
  readonly harnesses: ReadonlyArray<GuiHarnessCatalogEntry>;
  readonly harnessesLoading: boolean;
  readonly harnessesError: HostRpcError | null;
  readonly modelsLoading: boolean;
}

const EMPTY_GUI_HARNESS_IDS: ReadonlyArray<GuiHarnessId> = [];
const EMPTY_GUI_HARNESS_CATALOG_ENTRIES: ReadonlyArray<GuiHarnessCatalogEntry> =
  [];
const EMPTY_GUI_MODEL_OPTIONS: ListGuiAgentModelsResponse["models"] = [];
const EMPTY_GUI_MODEL_REQUESTS: ReadonlyArray<{
  readonly method: "agent.gui.listModels";
  readonly params: {
    readonly harnessId: GuiHarnessId;
    readonly workingDirectory: string | null;
  };
}> = [];

export function useGuiHarnessesQuery(
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiHarnessesResponse, HostRpcError> {
  const client = useHostBinding()?.hostClient ?? null;
  return useHostQuery<HostRpcRegistry, "agent.gui.listHarnesses">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listHarnesses",
    params: {},
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      refetchInterval: (query) =>
        nextHarnessAvailabilityRefetchInterval({
          queryHash: query.queryHash,
          dataUpdateCount: query.state.dataUpdateCount,
          data: query.state.data,
        }),
      staleTime: HARNESS_AVAILABILITY_REFRESH_MS,
    },
  });
}

export function useGuiHarnessModelsQuery(
  harnessId: GuiHarnessId,
  workingDirectory: string | null,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentModelsResponse, HostRpcError> {
  const client = useHostBinding()?.hostClient ?? null;
  const params = useMemo(
    () => ({ harnessId, workingDirectory }),
    [harnessId, workingDirectory],
  );
  return useHostQuery<HostRpcRegistry, "agent.gui.listModels">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listModels",
    params,
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      refetchInterval: (query) =>
        nextHarnessModelRefetchInterval({
          queryHash: query.queryHash,
          errorUpdateCount: query.state.errorUpdateCount,
          error: query.state.error,
        }),
      staleTime: HARNESS_CATALOG_STALE_TIME_MS,
    },
  });
}

export function useGuiHarnessCommandsQuery(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
  workingDirectories: ReadonlyArray<string>,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentCommandsResponse, HostRpcError> {
  const params = useMemo(
    () => guiHarnessCommandsQueryParams(harnessId, workingDirectories),
    [harnessId, workingDirectories],
  );
  return useHostQuery<HostRpcRegistry, "agent.gui.listCommands">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listCommands",
    params,
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: HARNESS_CATALOG_STALE_TIME_MS,
    },
  } satisfies UseHostQueryOptions<HostRpcRegistry, "agent.gui.listCommands">);
}

export function useGuiHarnessCatalog(
  workingDirectory: string | null,
  activity: QueryActivityOptions,
): GuiHarnessCatalog {
  const harnessesQuery = useGuiHarnessesQuery(activity);
  const client = useHostBinding()?.hostClient ?? null;
  const active = activity.enabled && activity.subscribed;

  const harnessIds = useMemo(() => {
    if (!active) return EMPTY_GUI_HARNESS_IDS;
    return (
      harnessesQuery.data?.harnesses.flatMap((harness) =>
        harness.available ? [harness.id] : [],
      ) ?? EMPTY_GUI_HARNESS_IDS
    );
  }, [active, harnessesQuery.data?.harnesses]);

  const requests = useMemo(() => {
    if (harnessIds.length === 0) return EMPTY_GUI_MODEL_REQUESTS;
    return harnessIds.map((harnessId) => ({
      method: "agent.gui.listModels" as const,
      params: { harnessId, workingDirectory },
    }));
  }, [harnessIds, workingDirectory]);

  const modelQueries = useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
    client,
    requests,
    options: {
      enabled: activity.enabled,
      refetchInterval: (query) =>
        nextHarnessModelRefetchInterval({
          queryHash: query.queryHash,
          errorUpdateCount: query.state.errorUpdateCount,
          error: query.state.error,
        }),
      staleTime: HARNESS_CATALOG_STALE_TIME_MS,
    },
  });

  const queryByHarnessId = useMemo(() => {
    const queryMap = new Map<GuiHarnessId, (typeof modelQueries)[number]>();
    harnessIds.forEach((id, index) => {
      queryMap.set(id, modelQueries[index]);
    });
    return queryMap;
  }, [harnessIds, modelQueries]);

  const harnesses = useMemo<ReadonlyArray<GuiHarnessCatalogEntry>>(
    () =>
      active && harnessesQuery.data !== undefined
        ? harnessesQuery.data.harnesses.map((harness) => {
            const modelQuery = queryByHarnessId.get(harness.id);
            return {
              ...harness,
              models: modelQuery?.data?.models ?? EMPTY_GUI_MODEL_OPTIONS,
              modelsLoading: modelQuery?.isPending ?? false,
              modelsError:
                modelQuery?.error instanceof HostRpcError
                  ? modelQuery.error
                  : null,
            };
          })
        : EMPTY_GUI_HARNESS_CATALOG_ENTRIES,
    [active, harnessesQuery.data, queryByHarnessId],
  );
  const modelsLoading = useMemo(
    () => modelQueries.some((query) => query.isPending),
    [modelQueries],
  );

  return useMemo(
    () => ({
      harnesses,
      harnessesLoading: harnessesQuery.isPending,
      harnessesError: harnessesQuery.error,
      modelsLoading,
    }),
    [harnesses, harnessesQuery.error, harnessesQuery.isPending, modelsLoading],
  );
}

const REFRESHABLE_CATALOG_METHODS = [
  "agent.gui.listHarnesses",
  "agent.gui.listModels",
  "agent.gui.listCommands",
] as const;

/**
 * Returns a function that force-refreshes the harness catalog (availability +
 * model lists + commands) for the active host, bypassing the long catalog
 * cache. Wired to the picker's refresh button so users can re-fetch on demand
 * without waiting out the 15-min stale window - e.g. to pick up provider
 * enable/disable changes or an updated models.dev catalog. (It re-queries the
 * existing provider servers; a brand-new shell API key exported after the
 * host started still needs a host restart, since the server's env is fixed
 * at spawn.)
 */
export function useRefreshHarnessCatalog(): () => Promise<void> {
  const queryClient = useQueryClient();
  const client = useHostClient();
  return useCallback(async () => {
    const hostId = client.getActiveHostId();
    if (hostId === null) return;
    // `invalidateQueries` resolves once the refetches it triggers on active
    // queries settle, so awaiting all of them lets the caller drive a spinner
    // that reflects real refetch progress (not just fire-and-forget).
    await Promise.all(
      REFRESHABLE_CATALOG_METHODS.map((method) =>
        queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, method),
        }),
      ),
    );
  }, [client, queryClient]);
}

function guiHarnessCommandsQueryParams(
  harnessId: GuiHarnessId,
  workingDirectories: ReadonlyArray<string>,
) {
  const normalized = dedupeNonEmptyStrings(workingDirectories);
  return {
    harnessId,
    workingDirectory: normalized[0] ?? null,
    workingDirectories: normalized,
  };
}

function dedupeNonEmptyStrings(values: ReadonlyArray<string>): string[] {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? [trimmed] : [];
      }),
    ),
  );
}
