import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { useRefreshProvidersForClient } from "@/hooks/providers/use-refresh-providers";
import { useHostBinding, useHostClient } from "@/lib/host";
import { resolveSubtreeHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import type {
  GuiHarnessOption,
  GuiHarnessId,
  ListGuiAgentCommandsResponse,
  ListGuiAgentModelsResponse,
  ListGuiHarnessesResponse,
} from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostQuery,
  type UseHostQueryOptions,
} from "@/hooks/host/use-host-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { useHostMethodMajorAtLeast } from "@/hooks/host/use-host-supports-method";

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
  /**
   * A managed profile is selected for this harness and the host negotiated a
   * catalog line too old to answer for one (D21). No request was issued and
   * `models` is empty - deliberately NOT reported through `modelsError`, which
   * renders as a failed fetch with a report-issue affordance beside it. A
   * negotiated host version is a fact about the deployment, not a defect.
   */
  readonly modelsProfileUnsupported: boolean;
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
    readonly profileId: string | null;
  };
}> = [];

/**
 * "Every harness on its default account" - the catalog's profile map when the
 * surface has no profile selection of its own (the app-load fill, a label
 * lookup). Shared constant so those call sites keep a stable identity across
 * renders instead of each minting an empty `Map` per commit.
 */
export const DEFAULT_ACCOUNT_HARNESS_PROFILES: ReadonlyMap<
  GuiHarnessId,
  string | null
> = new Map();

/**
 * The first `agent.gui.listModels` / `agent.gui.listCommands` major that
 * carries `profileId` (D09/D17/D25, W3-T6).
 */
const PROFILE_SCOPED_HARNESS_CATALOG_MAJOR = 2;

/**
 * What a catalog or command request may do for one `(host, profile)` pair.
 *
 * - `"ready"` - send it. Either the default account is selected (every host
 *   can answer that, on every line) or the host negotiated `@2.0` on BOTH
 *   catalog methods.
 * - `"pending"` - no handshake with that host has been recorded yet, so
 *   nothing is known either way. Send nothing and render the surface's own
 *   pending state; accusing a host of being out of date on evidence that has
 *   not arrived is the one wrong answer here.
 * - `"unsupported"` - the host handshook below `@2.0` and a managed profile
 *   is selected. Send nothing and SAY so: D21's downgrade bridges reject a
 *   non-null `profileId` outright rather than rewriting it, and the client
 *   must not reach the same outcome by substituting the default account.
 */
export type HarnessCatalogProfileScopeStatus =
  | "ready"
  | "pending"
  | "unsupported";

/**
 * The single verdict every catalog/command call site reads before issuing a
 * request (D09/D17/D21/D25, W3-T6).
 *
 * `profileId` is ALWAYS the selection it was derived from - never substituted,
 * not even in the two statuses that send nothing. That is deliberate: the id
 * is also the query's cache key, so keeping the profile's own key under a
 * disabled observer means the surface reads that profile's (empty) slot rather
 * than the default account's - which the app-load prefetcher has usually
 * filled, and which is exactly the list D21 exists to keep off screen.
 */
export interface HarnessCatalogProfileScope {
  readonly profileId: string | null;
  readonly status: HarnessCatalogProfileScopeStatus;
}

const DEFAULT_ACCOUNT_SCOPE: HarnessCatalogProfileScope = {
  profileId: null,
  status: "ready",
};

/**
 * The scope decision itself, as a pure function of the selection and the
 * host's negotiated verdict (`null` = no handshake recorded). Exported for the
 * fan-out, which answers it once per harness; a surface with a single
 * selection uses {@link useHarnessCatalogProfileScope}.
 */
export function harnessCatalogProfileScope(
  profileId: string | null,
  scopingSupported: boolean | null,
): HarnessCatalogProfileScope {
  if (profileId === null) return DEFAULT_ACCOUNT_SCOPE;
  if (scopingSupported === null) return { profileId, status: "pending" };
  return { profileId, status: scopingSupported ? "ready" : "unsupported" };
}

/**
 * Whether `hostId` negotiated catalog methods that can answer for a managed
 * profile - `null` while no handshake with it has been recorded.
 *
 * BOTH methods are read, not one standing in for the other. They gained
 * `profileId` in the same change, but that is a fact about the registry as it
 * landed rather than one the type system holds, and this single verdict gates
 * `agent.gui.listCommands` as well as `agent.gui.listModels`.
 */
export function useHarnessCatalogProfileScopingSupport(
  hostId: string | null,
): boolean | null {
  const models = useHostMethodMajorAtLeast(
    hostId,
    "agent.gui.listModels",
    PROFILE_SCOPED_HARNESS_CATALOG_MAJOR,
  );
  const commands = useHostMethodMajorAtLeast(
    hostId,
    "agent.gui.listCommands",
    PROFILE_SCOPED_HARNESS_CATALOG_MAJOR,
  );
  if (models === null || commands === null) return null;
  return models && commands;
}

/**
 * THE choke point: which profile id a catalog/command request carries for
 * `(hostId, profileId)`, and whether it may be sent at all.
 *
 * Every surface that threads a `profileId` into `agent.gui.listModels` /
 * `agent.gui.listCommands` resolves it here - the composer toolbar, the slash
 * palette, the model picker, the worktree owner header, and the catalog
 * fan-out itself - so "may this request go out, and with what" has one answer
 * per `(host, harness)` instead of one per call site.
 */
export function useHarnessCatalogProfileScope(
  hostId: string | null,
  profileId: string | null,
): HarnessCatalogProfileScope {
  const scopingSupported = useHarnessCatalogProfileScopingSupport(hostId);
  return useMemo(
    () => harnessCatalogProfileScope(profileId, scopingSupported),
    [profileId, scopingSupported],
  );
}

/**
 * WHICH SURFACES MAY USE THE DEFAULT-HOST WRAPPERS BELOW.
 *
 * This rule used to live on a `useDefaultHostClient()` hook here. That hook was
 * deleted: once `HostRuntimeBinding` carries its own `hostId`, it resolved
 * exactly what `useDefaultHostClient()` resolves, and a wrapper that adds nothing
 * is one more place for this to drift. The rule is not about the hook, so it
 * outlives it.
 *
 * App-wide surfaces (the app-load prefetcher, Settings, and the command palette
 * WHEN NO COMPOSER IS FOCUSED) read the catalog through the wrappers below. A
 * COMPOSER never does: every composer surface has a target host - the tab's
 * bound host, a fork dialog's fixed host, or the app-wide default followed
 * through `null` (the landing page, whose picker rebinds that default, and the
 * new-conversation modal opened from the sidebar's app-wide trigger) - and
 * reads its catalog through the `...ForClient` variants with that host's
 * client, so the harnesses, models and commands it offers are the ones the run
 * will actually see. With a composer focused the palette follows it, reading
 * through `FocusedComposerEntry.hostClient` - otherwise its Pick provider /
 * Pick model subpages would list one host's catalog and dispatch into another
 * host's composer store.
 *
 * "Default host" now means THE SURFACE'S host, which inside Settings is the
 * SCOPED one - and that is a fix, not a widening. `TerminalAgentArgsSection`
 * renders inside the Providers panel's re-provided binding and gates its whole
 * control on `harnesses.some(...)` from this query, while the write it guards
 * (`providers.setTerminalAgentArgs`) was already scoped. So the panel scoped to
 * host B asked host A whether to show the field, then wrote the answer to B.
 */
function useDefaultHostClient(): HostClient<HostRpcRegistry> | null {
  // MODULE-PRIVATE, and no longer exported. It used to be, and as an export it
  // was a second name for `useHostClient()` that could drift from it - which is
  // what the deleted version had done. What survives is the null-tolerance the
  // three wrappers below need (`null` DISABLES their query) and the rule above.
  //
  // The binding is read HERE rather than inside a shared hook. Roughly forty
  // suites inject a binding by overriding `useHostBinding` on `@/lib/host`, and
  // a hook that read the binding through its own module import would bypass
  // every one of them silently. See `lib/host/binding-host-client.ts`.
  const binding = useHostBinding();
  const effectiveHostId = useEffectiveHostId();
  return useMemo(
    () => resolveSubtreeHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );
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

/**
 * Which catalog one `agent.gui.listModels` observer is about. One object
 * rather than three positional arguments so `profileId` travels as a NAMED
 * field beside the harness it qualifies - it is part of the cache key, and a
 * positional `null` in the middle of a call is exactly the shape a surface
 * with a profile switcher forgets to fill in.
 */
export interface GuiHarnessModelsTarget {
  readonly harnessId: GuiHarnessId;
  readonly workingDirectory: string | null;
  /** `null` is the default account (D09/D25, W3-T6), never "unset". */
  readonly profileId: string | null;
}

/** Same, for `agent.gui.listCommands` (D17, W3-T6). */
export interface GuiHarnessCommandsTarget {
  readonly harnessId: GuiHarnessId;
  readonly workingDirectories: ReadonlyArray<string>;
  readonly profileId: string | null;
}

export function useGuiHarnessModelsQuery(
  target: GuiHarnessModelsTarget,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentModelsResponse, HostRpcError> {
  return useGuiHarnessModelsQueryForClient(
    useDefaultHostClient(),
    target,
    activity,
  );
}

/**
 * Client-scoped `agent.gui.listModels`; see `useGuiHarnessesQueryForClient`.
 *
 * `profileId` (D09/D25, W3-T6) selects WHICH account's catalog this is -
 * `null` is the default account. It is part of the cache key, so a profile's
 * models never share a slot with the default account's, and required rather
 * than optional so a surface with a profile switcher cannot forget it and
 * silently show the wrong list.
 *
 * The profile-scoping verdict is applied HERE rather than at each call site:
 * a managed profile against a host that never negotiated `@2.0` holds
 * `enabled` closed, whatever the caller passed. A surface that must SAY why
 * asks {@link useHarnessCatalogProfileScope} for the same verdict; a surface
 * that only reads a catalog needs to know nothing about it.
 */
export function useGuiHarnessModelsQueryForClient(
  client: HostClient<HostRpcRegistry> | null,
  target: GuiHarnessModelsTarget,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentModelsResponse, HostRpcError> {
  const { harnessId, workingDirectory, profileId } = target;
  const scope = useHarnessCatalogProfileScope(
    client?.getActiveHostId() ?? null,
    profileId,
  );
  // Rebuilt from the FIELDS, not passed through: a caller writing the target
  // inline mints a fresh object every render, and this identity is what the
  // query's params memo hangs on.
  const params = useMemo(
    () => ({ harnessId, workingDirectory, profileId }),
    [harnessId, workingDirectory, profileId],
  );
  return useHostQuery<HostRpcRegistry, "agent.gui.listModels">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listModels",
    params,
    options: {
      enabled: activity.enabled && scope.status === "ready",
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
  profileId: string | null,
  activity: QueryActivityOptions,
): Array<UseQueryResult<ListGuiAgentModelsResponse, HostRpcError>> {
  const scope = useHarnessCatalogProfileScope(
    client?.getActiveHostId() ?? null,
    profileId,
  );
  const requests = useMemo(() => {
    if (harnessId === null) return EMPTY_GUI_MODEL_REQUESTS;
    return [
      {
        method: "agent.gui.listModels" as const,
        params: { harnessId, workingDirectory: null, profileId },
      },
    ];
  }, [harnessId, profileId]);
  return useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
    client,
    cacheKeyIdentity: undefined,
    requests,
    options: {
      // Same choke point as the standalone query: a label surface warming an
      // owner's tuple has no version knowledge of its own, and the worst
      // outcome for it is a raw slug rather than a wrong model name.
      enabled: activity.enabled && scope.status === "ready",
      subscribed: activity.subscribed,
      staleTime: Infinity,
      gcTime: Infinity,
    },
  });
}

/**
 * Client-scoped `agent.gui.listCommands`. `profileId` (D17, W3-T6) decides
 * whose skills the palette lists: a managed profile's skill roots hang off
 * that profile's home, so `null` here means the default account and nothing
 * else.
 */
export function useGuiHarnessCommandsQuery(
  client: HostClient<HostRpcRegistry> | null,
  target: GuiHarnessCommandsTarget,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentCommandsResponse, HostRpcError> {
  const { harnessId, workingDirectories, profileId } = target;
  const scope = useHarnessCatalogProfileScope(
    client?.getActiveHostId() ?? null,
    profileId,
  );
  const params = useMemo(
    () =>
      guiHarnessCommandsQueryParams(harnessId, workingDirectories, profileId),
    [harnessId, workingDirectories, profileId],
  );
  return useHostQuery<HostRpcRegistry, "agent.gui.listCommands">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listCommands",
    params,
    options: {
      enabled: activity.enabled && scope.status === "ready",
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
  profileIdByHarnessId: ReadonlyMap<GuiHarnessId, string | null>,
): GuiHarnessCatalog {
  return useGuiHarnessCatalogForClient(
    useDefaultHostClient(),
    workingDirectory,
    activity,
    profileIdByHarnessId,
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
  profileIdByHarnessId: ReadonlyMap<GuiHarnessId, string | null>,
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

  // One profile per harness, not one for the catalog: this fan-out spans every
  // available harness at once, and a profile id is only meaningful against the
  // provider that minted it. A harness absent from the map is on its default
  // account - which is every harness for the app-load fill and the label
  // surfaces, and all but the browsed/selected pair for the picker.
  //
  // The fan-out asks the choke point once per harness rather than trusting the
  // map: this hook is the LAST place a `profileId` can turn into a request, so
  // a caller that hands it a managed profile for a host that cannot answer for
  // one must lose the request here, not have it rejected on the wire.
  const scopingSupported = useHarnessCatalogProfileScopingSupport(
    client?.getActiveHostId() ?? null,
  );
  const scopeByHarnessId = useMemo(() => {
    const map = new Map<GuiHarnessId, HarnessCatalogProfileScope>();
    for (const harnessId of harnessIds) {
      map.set(
        harnessId,
        harnessCatalogProfileScope(
          profileIdByHarnessId.get(harnessId) ?? null,
          scopingSupported,
        ),
      );
    }
    return map;
  }, [harnessIds, profileIdByHarnessId, scopingSupported]);
  // Only the harnesses whose scope resolved may hold an observer at all. A
  // held one keyed on the default account would surface the slot the app-load
  // fill populated - the substitution D21 forbids - so they are dropped from
  // the batch entirely and their entries are synthesized below.
  const scopedHarnessIds = useMemo(
    () =>
      harnessIds.filter(
        (harnessId) => scopeByHarnessId.get(harnessId)?.status === "ready",
      ),
    [harnessIds, scopeByHarnessId],
  );
  const requests = useMemo(() => {
    if (scopedHarnessIds.length === 0) return EMPTY_GUI_MODEL_REQUESTS;
    return scopedHarnessIds.map((harnessId) => ({
      method: "agent.gui.listModels" as const,
      params: {
        harnessId,
        workingDirectory,
        profileId: scopeByHarnessId.get(harnessId)?.profileId ?? null,
      },
    }));
  }, [scopeByHarnessId, scopedHarnessIds, workingDirectory]);

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
    scopedHarnessIds.forEach((id, index) => {
      queryMap.set(id, modelQueries[index]);
    });
    return queryMap;
  }, [modelQueries, scopedHarnessIds]);

  const harnesses = useMemo<ReadonlyArray<GuiHarnessCatalogEntry>>(
    () =>
      attached && harnessesQuery.data !== undefined
        ? harnessesQuery.data.harnesses.map((harness) => {
            const modelQuery = queryByHarnessId.get(harness.id);
            const scopeStatus = scopeByHarnessId.get(harness.id)?.status;
            return {
              ...harness,
              models: modelQuery?.data?.models ?? EMPTY_GUI_MODEL_OPTIONS,
              // "Loading" must mean a fetch is actually happening. Raw
              // `isPending` is true for ANY no-data slot - including one a
              // `"cached-only"` observer will never fetch - which would read
              // as an eternal spinner. `isLoading` (`isPending && isFetching`)
              // reflects the query's shared fetch state, so it also turns true
              // while a surface's own targeted query fills this same slot.
              // A scope still waiting on the host's handshake IS a fetch
              // coming: the verdict lands with the manifest and the batch
              // picks the harness up on that render.
              modelsLoading:
                (modelQuery?.isLoading ?? false) || scopeStatus === "pending",
              modelsError:
                modelQuery?.error instanceof HostRpcError
                  ? modelQuery.error
                  : null,
              modelsProfileUnsupported: scopeStatus === "unsupported",
            };
          })
        : EMPTY_GUI_HARNESS_CATALOG_ENTRIES,
    [attached, harnessesQuery.data, queryByHarnessId, scopeByHarnessId],
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
 * model lists + commands) and the provider list for the active host, bypassing
 * the long caches. Wired to the picker's refresh button so users can re-fetch
 * on demand without waiting out the 15-min stale window - e.g. to pick up
 * provider enable/disable changes, an updated models.dev catalog, or a
 * credential they just configured in the provider's own store. (It re-queries the
 * existing provider servers; a brand-new shell API key exported after the
 * host started still needs a host restart, since the server's env is fixed
 * at spawn.)
 */
export type HarnessCatalogRefreshOutcome =
  | { readonly kind: "refreshed" }
  | {
      readonly kind: "unavailable";
      readonly reason: "host-unresolved" | "rpc-endpoint-absent";
    };

export function useRefreshHarnessCatalog(): () => Promise<HarnessCatalogRefreshOutcome> {
  return useRefreshHarnessCatalogForClient(useHostClient());
}

/**
 * Client-scoped catalog refresh: invalidates the catalog keys of the host
 * `client` targets, so the picker's refresh button re-fetches the catalog of
 * the host the composer runs on - never the app-wide active host's while a tab
 * or dialog is bound elsewhere. When the host identity or its RPC endpoint is
 * absent, refresh returns an explicit unavailable outcome and deliberately
 * leaves every query unmodified. Invalidating disabled catalog observers would
 * retain the click until the endpoint appears and turn it into a deferred
 * all-provider fan-out on the default host.
 */
export function useRefreshHarnessCatalogForClient(
  client: HostClient<HostRpcRegistry> | null,
): () => Promise<HarnessCatalogRefreshOutcome> {
  const queryClient = useQueryClient();
  const refreshProviders = useRefreshProvidersForClient(client);
  return useCallback(async () => {
    const hostId = client?.getActiveHostId() ?? null;
    if (hostId === null) {
      return { kind: "unavailable", reason: "host-unresolved" };
    }
    if ((client?.getActiveHost()?.websocketUrl ?? null) === null) {
      return { kind: "unavailable", reason: "rpc-endpoint-absent" };
    }
    getConditionPollEpisodeCoordinator(queryClient).resetQueryByKey(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listHarnesses">(
        hostId,
        "agent.gui.listHarnesses",
        {},
      ),
    );
    // The picker's auth line and its degraded-tab set read `providers.list`,
    // which is otherwise held for fifteen minutes, and the catalog row's own
    // `authStatus` cannot stand in for it: the host fills that field from a
    // thirty-second cache and OMITS it once that expires. Nor is invalidating
    // the list enough - a plain refetch serves the last-known verdict while
    // the host re-probes in the background - so this is the FORCED refresh
    // the Settings and banner refresh buttons use, committed under this
    // host's classic key. Its failure is already toasted by the mutation and
    // must not withhold the catalog refetch below.
    const providersRefreshed = await refreshProviders().then(
      () => true,
      () => false,
    );
    // `invalidateQueries` resolves once the refetches it triggers on active
    // queries settle, so awaiting all of them lets the caller drive a spinner
    // that reflects real refetch progress (not just fire-and-forget).
    //
    // The dedupe below is owed entirely to the commit ABOVE HAVING RUN: a
    // successful `commitAuthoritativeProvidersList` invalidates every
    // `PROVIDER_INVALIDATIONS` scope (`agent.gui.listHarnesses` among them),
    // so invalidating those again here would restart refetches already in
    // flight. A REJECTED forced request never reaches that commit and so
    // invalidates nothing - and the harness row is where `enabled`,
    // `available` and `authStatus` come from, the very fields the rail dims
    // on. Deducting it unconditionally would return `refreshed` from a click
    // that refetched neither the provider list nor the rail it feeds, over a
    // provider-probe timeout that left the catalog endpoints perfectly
    // usable. So the filter applies only on the success path; on failure this
    // pass covers every refreshable method itself.
    await Promise.all(
      REFRESHABLE_CATALOG_METHODS.filter(
        (method) =>
          !providersRefreshed || !PROVIDER_INVALIDATIONS.includes(method),
      ).map((method) =>
        queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, method),
        }),
      ),
    );
    return { kind: "refreshed" };
  }, [client, queryClient, refreshProviders]);
}

function guiHarnessCommandsQueryParams(
  harnessId: GuiHarnessId,
  workingDirectories: ReadonlyArray<string>,
  profileId: string | null,
) {
  const normalized = dedupeNonEmptyStrings(workingDirectories);
  return {
    harnessId,
    workingDirectory: normalized[0] ?? null,
    workingDirectories: normalized,
    profileId,
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
