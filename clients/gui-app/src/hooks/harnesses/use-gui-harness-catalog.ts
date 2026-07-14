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

// Model catalogs are CACHE-ONLY: `staleTime: Infinity` on every model query -
// the batched fan-out in `useGuiHarnessCatalog` and the standalone
// `useGuiHarnessModelsQuery` alike - so no observer ever refetches one on its
// own. Not on a timer, not when a surface mounts, and not when an `enabled`
// gate flips as the user moves between composers, chat tiles and palette
// subpages.
//
// A finite `staleTime` is not enough here, and that is the subtle part. It
// stops nothing by itself: it only decides whether the *next* mount or
// enabled-transition refetches. Four surfaces mount this catalog (the app-load
// prefetcher, the picker popover, `chat-tile`, the palette's model/provider
// subpages), so once the cache aged past a finite window, the next surface the
// user touched silently re-pulled every harness - which reads as a background
// refresh nobody asked for, and pulled all providers on a picker open when only
// the selected one was wanted.
//
// That matters because a cold `listModels` can spawn the OpenCode server and
// resolve the shell env, and the host reaps that server after
// `OPENCODE_SERVER_IDLE_TIMEOUT_MS` without traffic. An unasked-for fetch both
// pays a respawn and resets the host's idle clock, which is what kept a spawned
// server effectively unreapable.
//
// Models therefore refresh in exactly three places:
//   - the app-load fill (`HarnessCatalogPrefetcher`), which populates the cache
//     once per app session; every surface renders from that cache, including
//     while a refresh is in flight (a background refetch keeps the previous
//     data, so `isPending` stays false and no surface blanks);
//   - the picker's intent edges - popover open, harness selection - which
//     refresh ONLY the selected harness, and only once its cached entry is
//     older than `HARNESS_CATALOG_REFRESH_AFTER_MS`
//     (`harnessCatalogEntryNeedsRefresh`);
//   - the picker's manual refresh button (`useRefreshHarnessCatalog`), whose
//     `invalidateQueries` beats `staleTime: Infinity` and re-fetches everything.
//
// Matching that refresh threshold to the host's 15-min idle timeout is what
// keeps the two clocks from fighting: a picker opened inside the window reuses
// cache and leaves a live server alone, and one opened after it refetches -
// respawning a reaped server exactly when the user is about to pick a model.
export const HARNESS_CATALOG_REFRESH_AFTER_MS = 15 * 60 * 1000;
const HARNESS_AVAILABILITY_REFRESH_MS = 15 * 60 * 1000;

export interface HarnessCatalogEntryFreshness {
  readonly dataUpdatedAt: number;
  readonly isError: boolean;
}

/**
 * Whether an intent edge should refresh a cached catalog entry. Model queries
 * never refetch on their own (see above), so the picker asks this at its open /
 * harness-selection edges rather than refetching unconditionally: `.refetch()`
 * ignores `staleTime` as well as `enabled`, so an unguarded call would re-hit
 * `listModels` - and respawn a reaped OpenCode server - on every popover open,
 * however fresh the cache was.
 *
 * An entry that never loaded (`dataUpdatedAt === 0`) or whose last fetch failed
 * is always due: with no background retry left, the intent edges are also the
 * error-recovery path.
 */
export function harnessCatalogEntryNeedsRefresh(
  entry: HarnessCatalogEntryFreshness,
): boolean {
  if (entry.isError || entry.dataUpdatedAt === 0) return true;
  return Date.now() - entry.dataUpdatedAt >= HARNESS_CATALOG_REFRESH_AFTER_MS;
}

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

// Consecutive "saw an unavailable harness" fetches, keyed by query hash
// (host + method + params), so the backoff advances once per fetch rather
// than on every `refetchInterval` evaluation, and resets the moment the catalog
// goes fully available. Entries are dropped on recovery, so the map only ever
// holds currently-degraded hosts.
const unavailableStreaks = new Map<
  string,
  { readonly updateCount: number; readonly attempts: number }
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

/**
 * The app-wide default host's client (`null` while unbound), factored out so
 * the `?.`/`??` fallback lives in one place instead of being repeated at
 * every call site below - and so callers outside this module (e.g. the model
 * picker's commands-prewarm query) can resolve the same default-host scope
 * without duplicating it inline.
 */
export function useDefaultHostClient(): HostClient<HostRpcRegistry> | null {
  return useHostBinding()?.hostClient ?? null;
}

export function useGuiHarnessesQuery(
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiHarnessesResponse, HostRpcError> {
  const client = useDefaultHostClient();
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
  const client = useDefaultHostClient();
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
      // Cache-only (see the module header). This observer's `enabled` tracks
      // surface activity, so a finite staleTime would refetch - and respawn a
      // reaped server - every time the user merely switched back to a composer
      // with an aged cache.
      staleTime: Infinity,
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
      // Commands keep a finite staleTime, unlike models: this hook's only
      // steady consumer is the composer's slash popup, whose `enabled` flips
      // when the user types "/" - an intent edge in its own right, and the one
      // that already prewarms an OpenCode-backed server. Refreshing it at most
      // once per window on that edge is the behavior we want.
      staleTime: HARNESS_CATALOG_REFRESH_AFTER_MS,
    },
  } satisfies UseHostQueryOptions<HostRpcRegistry, "agent.gui.listCommands">);
}

export function useGuiHarnessCatalog(
  workingDirectory: string | null,
  activity: QueryActivityOptions,
): GuiHarnessCatalog {
  const harnessesQuery = useGuiHarnessesQuery(activity);
  const client = useDefaultHostClient();
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
    cacheKeyIdentity: undefined,
    requests,
    options: {
      enabled: activity.enabled,
      // Cache-only (see the module header). These observers are created and
      // destroyed as each surface activates, so a finite staleTime turned every
      // picker open / chat-tile reveal / palette subpage mount past the window
      // into a fan-out across EVERY harness. A harness with no cached entry yet
      // (newly available, or the app-load fill still in flight) still fetches -
      // TanStack's no-data path ignores staleTime - so this only suppresses
      // re-pulling harnesses we already hold.
      staleTime: Infinity,
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
