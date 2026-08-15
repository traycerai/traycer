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
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";

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
// `staleTime: Infinity` still leaves one hole: TanStack's NO-DATA path ignores
// it, so a fan-out whose observers are enabled fetches every harness with no
// cached entry. On the app-wide default host the prefetcher fills those slots
// at app load and the hole never shows - but a composer pinned to another host
// reads that HOST's cache slots, which nothing prefetched, so a picker or
// palette subpage mounting there cold-started `listModels` for every available
// harness at once: one spawned provider server per rail entry, on a host the
// user had merely opened a picker on. `modelsFetch` (below) closes that hole:
// only `"all-harnesses"` (the prefetcher's app-load fill) may fan out; every
// other surface is `"cached-only"` and warms exactly the harness it is about
// via its own targeted query on the shared cache slot.
//
// Models therefore refresh in exactly four places:
//   - the app-load fill (`HarnessCatalogPrefetcher`), the ONLY fan-out
//     (`modelsFetch: "all-harnesses"`), which populates the default host's
//     cache once per app session; every surface renders from that cache,
//     including while a refresh is in flight (a background refetch keeps the
//     previous data, so `isPending` stays false and no surface blanks);
//   - the picker's intent edges - popover open, harness selection - which
//     refresh ONLY the selected harness, and only once its cached entry is
//     older than `HARNESS_CATALOG_REFRESH_AFTER_MS`
//     (`harnessCatalogEntryNeedsRefresh`);
//   - targeted per-harness fetches on their surface's own gate: the picker's
//     selected-harness and browsed-provider queries
//     (`useGuiHarnessModelsQueryForClient`), and label surfaces warming their
//     one subject harness (`useGuiHarnessModelsWarmup`) - each fetching a
//     single harness's slot on the composer's / owner's host, never the rail;
//   - the picker's manual refresh button (`useRefreshHarnessCatalog`), whose
//     `invalidateQueries` beats `staleTime: Infinity` and re-fetches every
//     ACTIVE query (on a non-default host that is the picker's own targeted
//     queries; a cached-only entry re-pulls when next browsed, since
//     invalidation survives `staleTime: Infinity` at that enabled-mount edge).
//
// Matching that refresh threshold to the host's 15-min idle timeout is what
// keeps the two clocks from fighting: a picker opened inside the window reuses
// cache and leaves a live server alone, and one opened after it refetches -
// respawning a reaped server exactly when the user is about to pick a model.
//
// Host availability recovery is deliberately NOT a refresh point. The
// recovery sweep (`invalidateHostScope` with an active refetch) would beat
// `staleTime: Infinity` and re-probe every harness at once - a provider CLI
// spawn burst that stalls a slow host, flaps stream health, and triggers the
// next sweep (traycer#912). `query-invalidator.ts` therefore exempts
// `agent.gui.listModels` / `agent.gui.listCommands` from the recovery sweep
// ENTIRELY - not refetched, and not marked stale either. Marking them would
// only defer the burst: an invalidated query is stale regardless of
// `staleTime`, so the next mount of this hook would re-probe every harness at
// once. Recovery leaves them untouched and the intent edges above pick up
// whatever is genuinely due.
export const HARNESS_CATALOG_REFRESH_AFTER_MS = 15 * 60 * 1000;
const HARNESS_AVAILABILITY_REFRESH_MS = 15 * 60 * 1000;

export interface HarnessCatalogEntryFreshness {
  readonly dataUpdatedAt: number;
  readonly isError: boolean;
  readonly isFetching: boolean;
}

/**
 * Whether an intent edge should refresh a cached catalog entry. Model queries
 * never refetch on their own (see above), so the picker asks this at its open /
 * harness-selection edges rather than refetching unconditionally: `.refetch()`
 * ignores `staleTime` as well as `enabled`, so an unguarded call would re-hit
 * `listModels` - and respawn a reaped OpenCode server - on every popover open,
 * however fresh the cache was.
 *
 * A fetch already in flight is never due: it IS the fresh data coming, and the
 * imperative `refetch()` defaults to `cancelRefetch: true`, so answering "due"
 * would cancel and re-issue that request - a doubled RPC on exactly the cold
 * edges where an enabled-transition fetch and an intent edge race (browsing a
 * provider on a cold host commits the selection in the same commit that
 * enables its first fetch).
 *
 * An entry that never loaded (`dataUpdatedAt === 0`) or whose last fetch failed
 * is always due: with no background retry left, the intent edges are also the
 * error-recovery path.
 */
export function harnessCatalogEntryNeedsRefresh(
  entry: HarnessCatalogEntryFreshness,
): boolean {
  if (entry.isFetching) return false;
  if (entry.isError || entry.dataUpdatedAt === 0) return true;
  return Date.now() - entry.dataUpdatedAt >= HARNESS_CATALOG_REFRESH_AFTER_MS;
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

/**
 * Catalog activity: `QueryActivityOptions` plus the model fan-out scope.
 *
 * `modelsFetch` decides whether this observer may FETCH model lists it has no
 * cache for - it never affects what the catalog SURFACES (cached entries render
 * either way, and keep tracking cache updates):
 *   - `"all-harnesses"`: the model fan-out fetches every available harness with
 *     no cached entry. Reserved for the app-load fill; on a cold host this is
 *     one spawned provider server per rail entry, so no user-facing surface
 *     gets to be the trigger.
 *   - `"cached-only"`: the fan-out never fetches - entries surface whatever the
 *     shared cache slots hold. A surface that needs a specific harness resolved
 *     on a cold host owns a targeted query for it
 *     (`useGuiHarnessModelsQueryForClient` / `useGuiHarnessModelsWarmup`),
 *     whose result lands in the same slot this catalog reads.
 */
export interface CatalogQueryActivityOptions extends QueryActivityOptions {
  readonly modelsFetch: "all-harnesses" | "cached-only";
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
 * every call site below - and so callers outside this module can resolve the
 * same default-host scope without duplicating it inline.
 *
 * App-wide surfaces (the app-load prefetcher, Settings, and the command
 * palette WHEN NO COMPOSER IS FOCUSED) read the catalog through the
 * default-host wrappers below. A COMPOSER never does: every composer surface
 * has a target host - the tab's bound host, a fork dialog's fixed host, or
 * the app-wide default followed through `null` (the landing page, whose
 * picker rebinds that default, and the new-conversation modal opened from the
 * sidebar's app-wide trigger) - and reads its catalog through the
 * `...ForClient` variants with that host's client, so the harnesses, models
 * and commands it offers are the ones the run will actually see. With a
 * composer focused the palette follows it, reading through
 * `FocusedComposerEntry.hostClient` - otherwise its Pick provider / Pick
 * model subpages would list one host's catalog and dispatch into another
 * host's composer store.
 */
export function useDefaultHostClient(): HostClient<HostRpcRegistry> | null {
  return useHostBinding()?.hostClient ?? null;
}

export function useGuiHarnessesQuery(
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiHarnessesResponse, HostRpcError> {
  return useGuiHarnessesQueryForClient(useDefaultHostClient(), activity);
}

/**
 * Client-scoped `agent.gui.listHarnesses`. `client === null` (a tab host the
 * directory has not resolved yet, or an unbound runtime) disables the query
 * rather than falling back to the default host - a composer must never offer
 * another host's harnesses under its own host's name.
 */
export function useGuiHarnessesQueryForClient(
  client: HostClient<HostRpcRegistry> | null,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiHarnessesResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "agent.gui.listHarnesses">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listHarnesses",
    params: {},
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: HARNESS_AVAILABILITY_REFRESH_MS,
    },
  });
}

export function useGuiHarnessModelsQuery(
  harnessId: GuiHarnessId,
  workingDirectory: string | null,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentModelsResponse, HostRpcError> {
  return useGuiHarnessModelsQueryForClient(
    useDefaultHostClient(),
    harnessId,
    workingDirectory,
    activity,
  );
}

/** Client-scoped `agent.gui.listModels`; see `useGuiHarnessesQueryForClient`. */
export function useGuiHarnessModelsQueryForClient(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
  workingDirectory: string | null,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentModelsResponse, HostRpcError> {
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
      // Going inactive (for example while the host is temporarily unavailable)
      // must only detach the observer, not discard the last verified catalog.
      // A successful later listModels response replaces this cache entry and
      // is the authority for models that no longer exist.
      gcTime: Infinity,
    },
  });
}

/**
 * Targeted single-harness model warmup: fetches `agent.gui.listModels` for
 * exactly one harness into the same cache slot the catalog's entries read,
 * without the all-harness fan-out. For a label surface that pairs a
 * `"cached-only"` catalog with one known subject harness (e.g. the worktree
 * owner header labeling the tuple its owner runs), so that subject still
 * resolves on a cold host at the cost of one provider - never the whole rail.
 *
 * Callers gate `enabled` on the subject's AVAILABILITY as well as their own
 * activity (mirroring the picker's fetch gates and the fan-out, which only
 * ever fetched available harnesses): a subject persisted by a historical
 * chat/TUI agent can name a harness that is now disabled or unavailable, and
 * an availability-blind warmup would hit that provider's `listModels` - and
 * retry the failure on every later mount, since an errored query refetches on
 * the next enabled mount.
 *
 * `harnessId === null` (no subject yet) mounts no query at all - deliberately
 * not a disabled observer on a junk `null`-keyed slot; the result is then an
 * empty array. Same cache-only contract as
 * `useGuiHarnessModelsQueryForClient`: a warm slot is never re-pulled, and
 * the last verified list is never garbage-collected.
 */
export function useGuiHarnessModelsWarmup(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId | null,
  activity: QueryActivityOptions,
): Array<UseQueryResult<ListGuiAgentModelsResponse, HostRpcError>> {
  const requests = useMemo(() => {
    if (harnessId === null) return EMPTY_GUI_MODEL_REQUESTS;
    return [
      {
        method: "agent.gui.listModels" as const,
        params: { harnessId, workingDirectory: null },
      },
    ];
  }, [harnessId]);
  return useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
    client,
    cacheKeyIdentity: undefined,
    requests,
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: Infinity,
      gcTime: Infinity,
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
  activity: CatalogQueryActivityOptions,
): GuiHarnessCatalog {
  return useGuiHarnessCatalogForClient(
    useDefaultHostClient(),
    workingDirectory,
    activity,
  );
}

/**
 * Client-scoped harness + model catalog; see `useGuiHarnessesQueryForClient`.
 * The model picker reads its rail/rows through this with the composer's
 * run-target client.
 */
export function useGuiHarnessCatalogForClient(
  client: HostClient<HostRpcRegistry> | null,
  workingDirectory: string | null,
  activity: CatalogQueryActivityOptions,
): GuiHarnessCatalog {
  const harnessesQuery = useGuiHarnessesQueryForClient(client, activity);
  // Fetching is gated by `enabled` (inside the sub-query hooks); the projection
  // is gated by `subscribed` alone, so a cache-only reader
  // (`{ enabled: false, subscribed: true }`) still surfaces the cached catalog
  // for label lookup on any visible transcript, without owning a fetch. For
  // every existing caller `enabled === subscribed`, so this is unchanged for
  // them.
  const attached = activity.subscribed;

  const harnessIds = useMemo(() => {
    if (!attached) return EMPTY_GUI_HARNESS_IDS;
    return (
      harnessesQuery.data?.harnesses.flatMap((harness) =>
        harness.available ? [harness.id] : [],
      ) ?? EMPTY_GUI_HARNESS_IDS
    );
  }, [attached, harnessesQuery.data?.harnesses]);

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
      // Only the app-load fill may fan out (see `CatalogQueryActivityOptions`):
      // TanStack's no-data path ignores `staleTime`, so an enabled observer on
      // a cold host's cache slot IS a fetch - and on a non-default host every
      // slot is cold, which made a picker/palette mount there spawn every
      // provider's server at once. A `"cached-only"` observer never fetches;
      // it still surfaces and tracks the shared slots, which the surface's own
      // targeted per-harness queries fill.
      enabled: activity.enabled && activity.modelsFetch === "all-harnesses",
      // Cache-only (see the module header). These observers are created and
      // destroyed as each surface activates, so a finite staleTime turned every
      // picker open / chat-tile reveal / palette subpage mount past the window
      // into a fan-out across EVERY harness. A harness with no cached entry yet
      // (newly available, or the app-load fill still in flight) still fetches -
      // TanStack's no-data path ignores staleTime - so this only suppresses
      // re-pulling harnesses we already hold.
      staleTime: Infinity,
      // Match the standalone model-query contract above: inactivity may mark
      // the catalog stale, but cannot garbage-collect the last verified list.
      gcTime: Infinity,
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
      attached && harnessesQuery.data !== undefined
        ? harnessesQuery.data.harnesses.map((harness) => {
            const modelQuery = queryByHarnessId.get(harness.id);
            return {
              ...harness,
              models: modelQuery?.data?.models ?? EMPTY_GUI_MODEL_OPTIONS,
              // "Loading" must mean a fetch is actually happening. Raw
              // `isPending` is true for ANY no-data slot - including one a
              // `"cached-only"` observer will never fetch - which would read
              // as an eternal spinner. `isLoading` (`isPending && isFetching`)
              // reflects the query's shared fetch state, so it also turns true
              // while a surface's own targeted query fills this same slot.
              modelsLoading: modelQuery?.isLoading ?? false,
              modelsError:
                modelQuery?.error instanceof HostRpcError
                  ? modelQuery.error
                  : null,
            };
          })
        : EMPTY_GUI_HARNESS_CATALOG_ENTRIES,
    [attached, harnessesQuery.data, queryByHarnessId],
  );
  // Same predicate as the per-entry flag above: a slot nothing will fetch is
  // not "loading", however empty it is.
  const modelsLoading = useMemo(
    () => modelQueries.some((query) => query.isLoading),
    [modelQueries],
  );
  // "Loading" means a fetch is actually coming. With no client the harness
  // query is disabled, and a disabled query with no cached data reports
  // `isPending` forever - reading it raw would leave the picker's rail (and
  // any other consumer) spinning for a fetch that will never start. The model
  // fan-out needs no such gate: it only exists once harnesses loaded, which
  // needs a client.
  const harnessesLoading = client !== null && harnessesQuery.isPending;

  return useMemo(
    () => ({
      harnesses,
      harnessesLoading,
      harnessesError: harnessesQuery.error,
      modelsLoading,
    }),
    [harnesses, harnessesQuery.error, harnessesLoading, modelsLoading],
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
  return useRefreshHarnessCatalogForClient(useHostClient());
}

/**
 * Client-scoped catalog refresh: invalidates the catalog keys of the host
 * `client` targets, so the picker's refresh button re-fetches the catalog of
 * the host the composer runs on - never the app-wide active host's while a tab
 * or dialog is bound elsewhere. A `null` client (host not resolved yet) is a
 * no-op, matching the disabled queries it would otherwise refetch.
 */
export function useRefreshHarnessCatalogForClient(
  client: HostClient<HostRpcRegistry> | null,
): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    const hostId = client?.getActiveHostId() ?? null;
    if (hostId === null) return;
    getConditionPollEpisodeCoordinator(queryClient).resetQueryByKey(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listHarnesses">(
        hostId,
        "agent.gui.listHarnesses",
        {},
      ),
    );
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
