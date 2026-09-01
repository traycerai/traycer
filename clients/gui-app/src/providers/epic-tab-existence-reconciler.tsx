import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isConfirmedAbsentTaskContext,
  type GetTaskContextsResponse,
  type ListTasksCompleteness,
  type ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { getNegotiatedHostMethodVersion } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { useShallow } from "zustand/react/shallow";
import {
  useHostClient,
  useHostCompatibility,
  useHostRuntimeClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { registerCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query";
import { epicTabLocalHomeListQueryOptions } from "@/lib/cloud-epic-tasks-query/reconciler-local-home-query";
import { wasEpicCreatedThisSession } from "@/lib/epics/session-created-epics";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  selectHasActiveInitialChatHandoffForEpic,
  useInitialChatHandoffStore,
} from "@/stores/epics/initial-chat-handoff-store";

/**
 * Resolves existence for exactly the epic ids that have an open tab, via
 * `epic.getTaskContexts` - id-scoped, so the cost is O(open tabs) rather than
 * O(the account's whole epic history) as the previous `epic.listTasks` sweep
 * was (it paged the entire list and then intersected).
 *
 * `epic.getTaskContexts` is an OPTIONAL (non-floor) method: it is absent from
 * `RELEASED_FLOOR_METHOD_NAMES`, so a host that predates it negotiates it away
 * instead of failing the handshake, and the client rejects the call locally
 * with `E_HOST_UNSUPPORTED`. Because this reconciler's only action is
 * DESTRUCTIVE (force-closing tabs), every path where existence is not
 * positively established must conclude nothing:
 *
 *  - the host has not advertised the method (or no handshake has completed
 *    yet) - the run never starts;
 *  - any batch is still pending, or failed for any reason including
 *    `E_HOST_UNSUPPORTED` - no ids are treated as missing.
 *
 * Reading an ambiguous or failed response as absence would close tabs that
 * may still exist, so only a positive absence result is actionable.
 *
 * Local-homed epics: pure cloud `getTaskContexts` cannot see unpromoted
 * epics, and a cloud `confirmed-absent` can name an epic whose never-uploaded
 * local edits are deliberately preserved. The host-merged first page of
 * `epic.listTasks` carries local-homed rows with `home: "local"` (durable via
 * the home registry); those ids are excluded as force-close candidates, so a
 * local epic's tab survives app relaunch without relying on session-scoped
 * exemptions.
 */
const RECONCILE_METHOD = "epic.getTaskContexts" as const;
const LOCAL_HOME_LIST_LIMIT = 100;

/**
 * Existence has to stay reasonably fresh - the whole point of the run is to
 * notice an epic deleted elsewhere - but a run's identity already changes on
 * every host / user / canvas-rehydration boundary, so the only repeats this
 * window covers are the ones a plain remount produces (a route change, a
 * StrictMode double-mount, a window reopened). Half a minute collapses those
 * into one RPC while still re-asking the host well inside a session.
 */
const EXISTENCE_STALE_TIME_MS = 30_000;

export function EpicTabExistenceReconciler() {
  const seed = usePersistedEpicTabReconcileSeed();
  if (seed === null) return null;
  return <EpicTabReconciliationRun key={seed.identity} seed={seed} />;
}

interface ReconcileSeed {
  readonly identity: string;
  readonly hostId: string;
  readonly userId: string;
  readonly openEpicIds: ReadonlyArray<string>;
}

function usePersistedEpicTabReconcileSeed(): ReconcileSeed | null {
  const client = useHostClient();
  const compatibility = useHostCompatibility();
  const readiness = useReactiveHostReadiness(client);
  const windowsHydrated = useWindowsBridgeHydrated();
  const authStatus = useAuthStore((state) => state.status);
  const authUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const canvasHydrationVersion = useEpicCanvasHydrationVersion();
  const openEpicIds = useVisibleEpicIds();
  // Three-valued on purpose (`null` = no handshake yet, `false` = known
  // absent): only `true` may license a run. `compatibility.status` cannot
  // stand in for this - it is a `host.status` probe over the released FLOOR
  // channel and says nothing about an optional method. In practice the
  // manifest is already known by the time the gates below pass, because a
  // `compatible` verdict required a completed handshake with this host.
  const methodSupport = useHostMethodSupport(
    readiness.hostId,
    RECONCILE_METHOD,
  );

  const identity = useMemo(() => {
    if (!windowsHydrated) return null;
    // This deliberately remains a VERIFIED-session gate rather than
    // `admitsLocalPlane`. The reconciler's only effect is destructive:
    // `confirmed-absent` clears run settings and permanently evicts the tab's
    // canvas state. An `unverified` session still supplies its stored
    // RequestContext credential lease to host RPCs; unlike
    // `AuthService.cloudBearer()`, that transport does not withhold it. Thus
    // `epic.getTaskContexts` can reach its cloud `resolution: "absent"` arm
    // and manufacture a destructive verdict before authn has verified the
    // session. Leave restored tabs alone until that account verdict arrives.
    if (authStatus !== "signed-in") return null;
    if (compatibility.status !== "compatible") return null;
    if (readiness.hostId === null) return null;
    if (authUserId === null) return null;
    if (readiness.requestContextUserId !== authUserId) return null;
    if (methodSupport !== true) return null;
    return `${readiness.hostId}:${authUserId}:${canvasHydrationVersion}`;
  }, [
    authStatus,
    authUserId,
    canvasHydrationVersion,
    compatibility.status,
    methodSupport,
    readiness.hostId,
    readiness.requestContextUserId,
    windowsHydrated,
  ]);

  return useMemo(() => {
    if (identity === null || readiness.hostId === null || authUserId === null) {
      return null;
    }
    if (openEpicIds.length === 0) return null;
    return {
      identity,
      hostId: readiness.hostId,
      userId: authUserId,
      openEpicIds,
    };
  }, [authUserId, identity, openEpicIds, readiness.hostId]);
}

/**
 * Freezes the id set this run probes. Tabs opened or closed after the run
 * starts must not re-key the batch: reconciliation is about the set as it was
 * persisted, and re-keying on every tab gesture would issue one RPC per
 * gesture. Identity changes remount this component (see the `key` above) and
 * that is the only thing that starts a new run.
 */
function EpicTabReconciliationRun(props: { readonly seed: ReconcileSeed }) {
  const [run] = useState<ReconcileSeed>(() => props.seed);

  return <EpicTabExistenceProbe run={run} />;
}

function EpicTabExistenceProbe(props: { readonly run: ReconcileSeed }) {
  const client = useHostClient();
  const hostRuntimeClient = useHostRuntimeClient();
  const hostDirectory = useHostDirectoryList();
  const completionAppliedRef = useRef(false);
  const openEpicIds = props.run.openEpicIds;
  const requests = useMemo(
    () =>
      chunkEpicIds(openEpicIds, GET_TASK_CONTEXTS_MAX_IDS).map((chunk) => ({
        method: RECONCILE_METHOD,
        params: { taskIds: [...chunk] },
      })),
    [openEpicIds],
  );
  // `null` until EVERY batch has succeeded - see the file header. The combined
  // value is a fresh `Set` per computation, so the effect below can re-run on
  // an unrelated render; `completionAppliedRef` keeps the apply once-only, as
  // it did for the paginated implementation.
  const confirmedAbsentEpicIds = useHostQueries<
    HostRpcRegistry,
    typeof RECONCILE_METHOD,
    ReadonlySet<string> | null
  >({
    client,
    requests,
    cacheKeyIdentity: props.run.identity,
    options: { enabled: true, staleTime: EXISTENCE_STALE_TIME_MS },
    combine: combineConfirmedAbsentEpicIds,
  });

  // First page of host-merged listTasks carries every local-homed epic
  // (prepended, exempt from cursor paging). Used as the durable home-marker
  // source for force-close exemption across app relaunches.
  const localHomeListParams = useMemo(
    () => ({
      limit: LOCAL_HOME_LIST_LIMIT,
      filters: { taskType: "epic" as const },
      extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
      extensionEpicVersion: String(CURRENT_EPIC_VERSION),
    }),
    [],
  );
  const localHomeProbes = useMemo((): ReadonlyArray<LocalHomeProbe> | null => {
    // Directory rows are the complete set of dialable hosts this shell knows.
    // A retained successful value while a refresh is in flight is not a stable
    // set: a newly published host could own the only durable local copy of a
    // cloud-absent epic. This is a destructive path, so wait for a settled
    // directory snapshot instead of treating retained rows as authoritative.
    if (!hostDirectory.isSuccess || hostDirectory.fetchStatus !== "idle") {
      return null;
    }
    const entriesByHostId = new Map<string, HostDirectoryEntry>();
    for (const entry of hostDirectory.data) {
      // Duplicate or non-dialable rows mean this client cannot establish one
      // unambiguous, pinned request lane for every host. Do not guess.
      if (
        entriesByHostId.has(entry.hostId) ||
        entry.transportDialability !== "dialable"
      ) {
        return null;
      }
      entriesByHostId.set(entry.hostId, entry);
    }
    // The host that supplied the positive cloud absence must itself be part of
    // this authoritative snapshot. Otherwise the directory changed under the
    // run and the all-host protection proof no longer has a defined scope.
    if (!entriesByHostId.has(props.run.hostId)) return null;

    const probes: LocalHomeProbe[] = [];
    for (const entry of entriesByHostId.values()) {
      const pinnedClient = buildDialableHostClient(hostRuntimeClient, entry);
      // No credentials, endpoint, or routed requester is an unknown answer,
      // not an empty local-home page. Let a later settled render retry.
      if (pinnedClient === null) return null;
      probes.push({ hostId: entry.hostId, client: pinnedClient });
    }
    return probes;
  }, [
    hostDirectory.data,
    hostDirectory.fetchStatus,
    hostDirectory.isSuccess,
    hostRuntimeClient,
    props.run.hostId,
  ]);

  // The list query reaches its host client through this registry. Register a
  // client explicitly pinned to EACH directory row; the app-wide client is
  // deliberately not a stand-in here, because it follows host selection.
  for (const probe of localHomeProbes ?? []) {
    registerCloudEpicTasksClient(probe.hostId, probe.client);
  }
  // Combined THROUGH `useQueries` rather than by a `useMemo` over its return
  // value, matching `confirmedAbsentEpicIds` above. `useQueries` builds a fresh
  // results array every render, so a `useMemo` keyed on it recomputed every
  // render regardless - the memo read as a stability guarantee it never
  // provided, which is what `@tanstack/query/no-unstable-deps` flags. Folding
  // it into `combine` drops the false guarantee without changing when the
  // combiner runs.
  const locallyProtectedEpicIds = useQueries({
    queries: (localHomeProbes ?? []).map((probe) => ({
      ...epicTabLocalHomeListQueryOptions({
        hostId: probe.hostId,
        userId: props.run.userId,
        params: localHomeListParams,
        // Same identity the existence probe above keys on, plus a discriminator
        // so the two queries never share a cache entry. `identity` alone carries
        // per-run freshness now - the old separate attempt counter is gone.
        cacheKeyIdentity: props.run.identity,
      }),
      enabled: true,
    })),
    combine: (
      results: ReadonlyArray<UseQueryResult<ListTasksResponse>>,
    ): ReadonlySet<string> | null =>
      combineLocallyProtectedEpicIds(localHomeProbes, results),
  });

  useEffect(() => {
    if (confirmedAbsentEpicIds === null) return;
    if (locallyProtectedEpicIds === null) return;
    if (completionAppliedRef.current) return;
    completionAppliedRef.current = true;
    // Never force-close an epic this session just created (or is creating):
    // cloud reads lag `epic.create` (that lag is exactly why
    // `useEpicCreate.onSuccess` manually patches the cloud-tasks cache), so a
    // freshly-created epic is legitimately absent for a short window. Closing
    // its tab strands the route on a loading skeleton that never recovers.
    // Such epics carry a live open-epic session and/or an active initial-chat
    // handoff; a genuinely-stale persisted tab (its epic deleted while the app
    // was closed) carries neither. A remote delete of an OPEN epic is handled
    // by `EpicAccessCoordinator` (via the live session's `epicDeleted` /
    // `accessLost` / unavailable-`snapshotFetchError` signals), not here, so
    // this exclusion cannot hide a real "epic is gone" signal.
    //
    // Local-homed epics (`home: "local"` on the host-merged listTasks row)
    // and cloud-homed rows preserved for never-uploaded local edits are never
    // force-close candidates. Both markers are durable across app relaunches;
    // the latter is intentionally cloud-absent, so `confirmed-absent` is not
    // proof its locally protected content may be destroyed.
    //
    const staleEpicIds = closableStaleEpicIds(
      [...confirmedAbsentEpicIds],
      locallyProtectedEpicIds,
    );
    if (staleEpicIds.length > 0) {
      useComposerRunSettingsStore.getState().clearEpicRunSettings(staleEpicIds);
      tabCommandCoordinator.handleEpicAccessLoss(staleEpicIds);
    }
  }, [confirmedAbsentEpicIds, locallyProtectedEpicIds]);

  return null;
}

interface LocalHomeProbe {
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry>;
}

/**
 * A local-home exemption is trustworthy only when EVERY settled directory
 * host returned a complete-enough first page. A missed host, a rejected
 * request (including unsupported `epic.listTasks`), or a truncated page
 * leaves an unprovable hole, so the destructive effect must wait rather than
 * equate that hole with no local epics. Older successful schemas can omit the
 * marker; absence is not a truncation claim and their rows remain useful.
 */
/**
 * Whether a page's `localRows` marker says the host-synthesized rows on it are
 * the WHOLE local answer.
 *
 * An ALLOWLIST, deliberately, and not `!== "truncated"`. Every value that is
 * not one of these three is the host declining to make a complete claim, and
 * the consumer here force-closes tabs for epics it does not find - so reading
 * an incomplete page as complete deletes a tab whose epic is locally homed.
 * `suppressed-unprovable-filter` is exactly that case and was previously
 * accepted; the protocol's own note on this member names the collapse ("the
 * difference between 'you have no local epics matching' and 'this filter
 * cannot be answered locally'"). Stated as an allowlist so a fourth value
 * added later fails closed here instead of silently joining the accepted set -
 * which is the same warning the schema doc gives about branching on WHICH
 * producer fired.
 *
 * `undefined` is complete ONLY on a negotiated line that cannot produce local
 * rows at all. A pre-`1.4` host does not carry `home: "local"` rows, so its
 * page cannot have truncated any, and treating such a peer as permanently
 * incomplete would strand every tab it serves. A `1.4`/`1.5` host DOES
 * synthesize local rows but predates the `completeness` marker (`1.5` carries
 * it only when the resolver chose to; `1.4` never does), so its missing marker
 * proves nothing: a persisted tab whose epic fell beyond that page's cap
 * would otherwise be force-closed on a page that never claimed to be whole.
 * A `null` version (no manifest recorded yet) is read the same way as a
 * capable line - unknown is not evidence of completeness either.
 */
function localRowsAreComplete(
  localRows: ListTasksCompleteness["localRows"] | undefined,
  negotiatedListTasks: SchemaVersion | null,
): boolean {
  if (localRows === "none" || localRows === "present") return true;
  if (localRows !== undefined) return false;
  return !negotiatedLineCarriesLocalRows(negotiatedListTasks);
}

function negotiatedLineCarriesLocalRows(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return true;
  return version.major > 1 || (version.major === 1 && version.minor >= 4);
}

function combineLocallyProtectedEpicIds(
  probes: ReadonlyArray<LocalHomeProbe> | null,
  results: ReadonlyArray<UseQueryResult<ListTasksResponse>>,
): ReadonlySet<string> | null {
  if (probes === null || results.length !== probes.length) return null;
  const locallyProtected = new Set<string>();
  for (const [index, result] of results.entries()) {
    if (!result.isSuccess) return null;
    const localRows = result.data.completeness?.localRows;
    const negotiatedListTasks = getNegotiatedHostMethodVersion(
      probes[index].hostId,
      "epic.listTasks",
    );
    if (!localRowsAreComplete(localRows, negotiatedListTasks)) return null;
    for (const epicId of locallyProtectedEpicIdsFromListTasks(result.data)) {
      locallyProtected.add(epicId);
    }
  }
  return locallyProtected;
}

/**
 * The subset of open epic ids the host positively confirmed absent, or `null`
 * when a batch has not completed successfully. `unknown` and legacy `null`
 * rows deliberately stay out of this set: only a current host's explicit
 * `confirmed-absent` arm may close a tab.
 *
 * `null` covers pending batches and ANY failure - a transport error, and
 * specifically `E_HOST_UNSUPPORTED` from a host that does not carry the
 * method. Do not soften this into an empty set: `useEpicGetTaskContexts`
 * deliberately degrades unsupported to an empty map because its callers only
 * enrich titles, but here an empty set means "every open tab is stale".
 */
function combineConfirmedAbsentEpicIds(
  results: Array<UseQueryResult<GetTaskContextsResponse, HostRpcError>>,
): ReadonlySet<string> | null {
  if (results.length === 0) return null;
  const confirmedAbsentEpicIds = new Set<string>();
  for (const result of results) {
    if (!result.isSuccess) return null;
    for (const [taskId, resolution] of Object.entries(result.data.tasks)) {
      if (isConfirmedAbsentTaskContext(resolution)) {
        confirmedAbsentEpicIds.add(taskId);
      }
    }
  }
  return confirmedAbsentEpicIds;
}

/** The durable force-close exemption, which IS marker-conditional. */
function locallyProtectedEpicIdsFromListTasks(
  page: ListTasksResponse,
): ReadonlySet<string> {
  const locallyProtected = new Set<string>();
  for (const task of page.tasks) {
    if (task.home !== "local" && task.preservation !== "orphaned-local-edits") {
      continue;
    }
    const epicId = task.epic?.light?.id;
    if (typeof epicId !== "string" || epicId.length === 0) continue;
    locallyProtected.add(epicId);
  }
  return locallyProtected;
}

function chunkEpicIds(
  epicIds: ReadonlyArray<string>,
  maxPerChunk: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (epicIds.length === 0) return [];
  return Array.from(
    { length: Math.ceil(epicIds.length / maxPerChunk) },
    (_value, index) =>
      epicIds.slice(index * maxPerChunk, (index + 1) * maxPerChunk),
  );
}

/**
 * Drop epics that must never be force-closed by existence reconciliation. An
 * epic is protected when ANY of these hold:
 *  - it was created from the start page this session (synchronous marker set at
 *    create time - the deterministic guard both the GUI-chat and terminal-agent
 *    landing flows share);
 *  - it has a live open-epic session in the registry (`peek` reads without
 *    disturbing MRU ordering);
 *  - it has an active (non-failed) initial-chat handoff (the GUI-chat flow);
 *  - the host-merged listTasks response tagged it `home: "local"` or
 *    `preservation: "orphaned-local-edits"` (durable across sessions via the
 *    home registry — not session-scoped).
 * The first three mark an epic this session opened or created, for which a
 * transient absence from the cloud is propagation lag rather than a deletion.
 * The home and preservation markers are durable counterparts for unpromoted
 * and cloud-deleted-but-locally-preserved epics, respectively.
 * Evaluated fresh here, at close time, so a session/handoff that appears after
 * the reconcile RPC resolves still counts.
 */
function closableStaleEpicIds(
  candidateEpicIds: ReadonlyArray<string>,
  locallyProtectedEpicIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  if (candidateEpicIds.length === 0) return candidateEpicIds;
  const handoffState = useInitialChatHandoffStore.getState();
  const registry = getOpenEpicRegistry();
  return candidateEpicIds.filter(
    (epicId) =>
      !wasEpicCreatedThisSession(epicId) &&
      registry.peek(epicId) === null &&
      !selectHasActiveInitialChatHandoffForEpic(handoffState, epicId) &&
      !locallyProtectedEpicIds.has(epicId),
  );
}

function useVisibleEpicIds(): ReadonlyArray<string> {
  return useEpicCanvasStore(
    useShallow((state) => {
      const seen = new Set<string>();
      return state.openTabOrder
        .map((tabId) => state.tabsById[tabId])
        .flatMap((tab) => {
          if (
            tab === undefined ||
            tab.surfaceMode?.kind === "phase-migration" ||
            seen.has(tab.epicId)
          ) {
            return [];
          }
          seen.add(tab.epicId);
          return [tab.epicId];
        });
    }),
  );
}

function useEpicCanvasHydrationVersion(): number {
  return useSyncExternalStore(
    subscribeToEpicCanvasHydration,
    getEpicCanvasHydrationVersion,
    getEpicCanvasHydrationVersion,
  );
}

let epicCanvasHydrationVersion = useEpicCanvasStore.persist.hasHydrated()
  ? 1
  : 0;
const epicCanvasHydrationSubscribers = new Set<() => void>();
let unsubscribeEpicCanvasHydration: (() => void) | null = null;

function subscribeToEpicCanvasHydration(callback: () => void): () => void {
  ensureEpicCanvasHydrationSubscription();
  epicCanvasHydrationSubscribers.add(callback);
  return () => {
    epicCanvasHydrationSubscribers.delete(callback);
  };
}

function getEpicCanvasHydrationVersion(): number {
  return epicCanvasHydrationVersion;
}

function ensureEpicCanvasHydrationSubscription(): void {
  if (unsubscribeEpicCanvasHydration !== null) return;
  unsubscribeEpicCanvasHydration = useEpicCanvasStore.persist.onFinishHydration(
    () => {
      epicCanvasHydrationVersion += 1;
      for (const subscriber of epicCanvasHydrationSubscribers) {
        subscriber();
      }
    },
  );
}
