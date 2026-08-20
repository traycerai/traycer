import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isConfirmedAbsentTaskContext,
  type GetTaskContextsResponse,
  type ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useShallow } from "zustand/react/shallow";
import {
  useHostClient,
  useHostCompatibility,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
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
const LOCAL_HOME_LIST_METHOD = "epic.listTasks" as const;
const LOCAL_HOME_LIST_LIMIT = 100;

export function EpicTabExistenceReconciler() {
  const seed = usePersistedEpicTabReconcileSeed();
  if (seed === null) return null;
  return <EpicTabReconciliationRun key={seed.identity} seed={seed} />;
}

interface ReconcileSeed {
  readonly identity: string;
  readonly openEpicIds: ReadonlyArray<string>;
}

interface ReconcileRun extends ReconcileSeed {
  readonly attempt: number;
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
    if (identity === null) return null;
    if (openEpicIds.length === 0) return null;
    return { identity, openEpicIds };
  }, [identity, openEpicIds]);
}

let nextReconcileAttempt = 0;

function EpicTabReconciliationRun(props: { readonly seed: ReconcileSeed }) {
  const [run] = useState<ReconcileRun>(() => {
    nextReconcileAttempt += 1;
    return {
      ...props.seed,
      attempt: nextReconcileAttempt,
    };
  });

  return <EpicTabExistenceProbe run={run} />;
}

function EpicTabExistenceProbe(props: { readonly run: ReconcileRun }) {
  const client = useHostClient();
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
    cacheKeyIdentity: `${props.run.identity}|${props.run.attempt}`,
    options: { enabled: true },
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
  const localHomeListQuery = useHostQuery<
    HostRpcRegistry,
    typeof LOCAL_HOME_LIST_METHOD
  >({
    client,
    method: LOCAL_HOME_LIST_METHOD,
    params: localHomeListParams,
    cacheKeyIdentity: [props.run.identity, props.run.attempt, "local-home"],
    options: { enabled: true },
  });

  const localHomedEpicIds = useMemo((): ReadonlySet<string> | null => {
    if (!localHomeListQuery.isSuccess) return null;
    return localHomedEpicIdsFromListTasks(localHomeListQuery.data);
  }, [localHomeListQuery.data, localHomeListQuery.isSuccess]);

  useEffect(() => {
    if (confirmedAbsentEpicIds === null) return;
    if (localHomedEpicIds === null) return;
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
    // Local-homed epics (`home: "local"` on the host-merged listTasks row) are
    // also never force-close candidates. That marker is durable across app
    // relaunches (host home registry), not session-scoped - and a cloud
    // `confirmed-absent` can name an epic whose never-uploaded local edits
    // are deliberately preserved (the orphan-recovery case).
    //
    // A first page whose `completeness.localRows` reports `truncated` did
    // not carry every local-homed epic, so the force-close exemption set
    // is incomplete and no destructive reconciliation may rest on it.
    const localRowsTruncated =
      localHomeListQuery.isSuccess &&
      localHomeListQuery.data.completeness?.localRows === "truncated";
    const staleEpicIds = localRowsTruncated
      ? []
      : closableStaleEpicIds([...confirmedAbsentEpicIds], localHomedEpicIds);
    if (staleEpicIds.length > 0) {
      useComposerRunSettingsStore.getState().clearEpicRunSettings(staleEpicIds);
      tabCommandCoordinator.handleEpicAccessLoss(staleEpicIds);
    }
  }, [
    confirmedAbsentEpicIds,
    localHomeListQuery.data,
    localHomeListQuery.isSuccess,
    localHomedEpicIds,
  ]);

  return null;
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
function localHomedEpicIdsFromListTasks(
  page: ListTasksResponse,
): ReadonlySet<string> {
  const localHomed = new Set<string>();
  for (const task of page.tasks) {
    if (task.home !== "local") continue;
    const epicId = task.epic?.light?.id;
    if (typeof epicId !== "string" || epicId.length === 0) continue;
    localHomed.add(epicId);
  }
  return localHomed;
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
 *  - the host-merged listTasks response tagged it `home: "local"` (durable
 *    across sessions via the home registry — not session-scoped).
 * The first three mark an epic this session opened or created, for which a
 * transient absence from the cloud is propagation lag rather than a deletion.
 * The home marker is the durable counterpart for unpromoted local epics.
 * Evaluated fresh here, at close time, so a session/handoff that appears after
 * the reconcile RPC resolves still counts.
 */
function closableStaleEpicIds(
  candidateEpicIds: ReadonlyArray<string>,
  localHomedEpicIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  if (candidateEpicIds.length === 0) return candidateEpicIds;
  const handoffState = useInitialChatHandoffStore.getState();
  const registry = getOpenEpicRegistry();
  return candidateEpicIds.filter(
    (epicId) =>
      !wasEpicCreatedThisSession(epicId) &&
      registry.peek(epicId) === null &&
      !selectHasActiveInitialChatHandoffForEpic(handoffState, epicId) &&
      !localHomedEpicIds.has(epicId),
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
