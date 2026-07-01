import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { useShallow } from "zustand/react/shallow";
import {
  useHostClient,
  useHostCompatibility,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { missingEpicIds } from "@/lib/epics/epic-tab-existence";
import { wasEpicCreatedThisSession } from "@/lib/epics/session-created-epics";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import {
  selectHasActiveInitialChatHandoffForEpic,
  useInitialChatHandoffStore,
} from "@/stores/epics/initial-chat-handoff-store";

const EPIC_TAB_RECONCILE_PAGE_LIMIT = 100;
const EMPTY_EXISTING_EPIC_IDS: ReadonlyArray<string> = [];
const EMPTY_SEEN_RECONCILE_CURSORS: ReadonlySet<string> = new Set();

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

interface ReconcilePage {
  readonly existingEpicIds: ReadonlyArray<string>;
  readonly cursor: string | undefined;
  readonly seenCursors: ReadonlySet<string>;
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

  const identity = useMemo(() => {
    if (!windowsHydrated) return null;
    if (authStatus !== "signed-in") return null;
    if (compatibility.status !== "compatible") return null;
    if (readiness.hostId === null) return null;
    if (authUserId === null) return null;
    if (readiness.requestContextUserId !== authUserId) return null;
    return `${readiness.hostId}:${authUserId}:${canvasHydrationVersion}`;
  }, [
    authStatus,
    authUserId,
    canvasHydrationVersion,
    compatibility.status,
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

  return (
    <EpicTabReconciliationPage
      run={run}
      page={{
        existingEpicIds: EMPTY_EXISTING_EPIC_IDS,
        cursor: undefined,
        seenCursors: EMPTY_SEEN_RECONCILE_CURSORS,
      }}
    />
  );
}

function EpicTabReconciliationPage(props: {
  readonly run: ReconcileRun;
  readonly page: ReconcilePage;
}) {
  const client = useHostClient();
  const completionAppliedRef = useRef(false);
  const {
    cursor: pageCursor,
    existingEpicIds: previousExistingEpicIds,
    seenCursors,
  } = props.page;
  const reconcileParams = useMemo(
    () => ({
      limit: EPIC_TAB_RECONCILE_PAGE_LIMIT,
      cursor: pageCursor,
      filters: { taskType: "epic" as const },
      extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
      extensionEpicVersion: String(CURRENT_EPIC_VERSION),
    }),
    [pageCursor],
  );
  const existingEpicsQuery = useHostQuery<HostRpcRegistry, "epic.listTasks">({
    client,
    method: "epic.listTasks",
    params: reconcileParams,
    cacheKeyIdentity: [props.run.identity, props.run.attempt],
    options: {
      enabled: true,
    },
  });
  const nextPage = useMemo((): ReconcilePage | null => {
    if (!existingEpicsQuery.isSuccess) return null;
    const existingEpicIds = mergeExistingEpicIds(
      previousExistingEpicIds,
      existingEpicsQuery.data,
    );
    const cursor = nextReconcileCursor(existingEpicsQuery.data);
    if (cursor === null || seenCursors.has(cursor)) {
      return {
        existingEpicIds,
        cursor: undefined,
        seenCursors,
      };
    }
    return {
      existingEpicIds,
      cursor,
      seenCursors: addSeenReconcileCursor(seenCursors, cursor),
    };
  }, [
    existingEpicsQuery.data,
    existingEpicsQuery.isSuccess,
    previousExistingEpicIds,
    seenCursors,
  ]);
  const terminalExistingEpicIds =
    nextPage !== null && nextPage.cursor === undefined
      ? nextPage.existingEpicIds
      : null;

  useEffect(() => {
    if (terminalExistingEpicIds === null) return;
    if (completionAppliedRef.current) return;
    completionAppliedRef.current = true;
    // Never force-close an epic this session just created (or is creating):
    // `epic.listTasks` lags `epic.create` (that lag is exactly why
    // `useEpicCreate.onSuccess` manually patches the cloud-tasks cache), so a
    // freshly-created epic is legitimately absent from the reconcile page for a
    // short window. Closing its tab strands the route on a loading skeleton
    // that never recovers. Such epics carry a live open-epic session and/or an
    // active initial-chat handoff; a genuinely-stale persisted tab (its epic
    // deleted while the app was closed) carries neither. A remote delete of an
    // OPEN epic is handled by `EpicAccessCoordinator` (via the live session's
    // `epicDeleted` / `accessLost` / unavailable-`snapshotFetchError` signals),
    // not here, so this exclusion cannot hide a real "epic is gone" signal.
    const staleEpicIds = closableStaleEpicIds(
      missingEpicIds(props.run.openEpicIds, new Set(terminalExistingEpicIds)),
    );
    if (staleEpicIds.length > 0) {
      useComposerRunSettingsStore.getState().clearEpicRunSettings(staleEpicIds);
      useEpicCanvasStore.getState().closeTabsForEpics(staleEpicIds);
    }
  }, [props.run.openEpicIds, terminalExistingEpicIds]);

  if (nextPage === null) return null;
  if (nextPage.cursor === undefined) return null;

  return <EpicTabReconciliationPage run={props.run} page={nextPage} />;
}

/**
 * Drop epics that must never be force-closed by existence reconciliation. An
 * epic is protected when ANY of these hold:
 *  - it was created from the start page this session (synchronous marker set at
 *    create time - the deterministic guard both the GUI-chat and terminal-agent
 *    landing flows share);
 *  - it has a live open-epic session in the registry (`peek` reads without
 *    disturbing MRU ordering);
 *  - it has an active (non-failed) initial-chat handoff (the GUI-chat flow).
 * Each marks an epic this session opened or created, for which a transient
 * `epic.listTasks` miss is propagation lag rather than a deletion. Evaluated
 * fresh here, at close time, so a session/handoff that appears after the
 * reconcile RPC resolves still counts.
 */
function closableStaleEpicIds(
  candidateEpicIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (candidateEpicIds.length === 0) return candidateEpicIds;
  const handoffState = useInitialChatHandoffStore.getState();
  const registry = getOpenEpicRegistry();
  return candidateEpicIds.filter(
    (epicId) =>
      !wasEpicCreatedThisSession(epicId) &&
      registry.peek(epicId) === null &&
      !selectHasActiveInitialChatHandoffForEpic(handoffState, epicId),
  );
}

function mergeExistingEpicIds(
  previousIds: ReadonlyArray<string>,
  page: ListTasksResponse,
): ReadonlyArray<string> {
  return Array.from(
    new Set([
      ...previousIds,
      ...page.tasks.flatMap((task) => {
        const epicId = task.epic?.light?.id ?? null;
        return epicId === null ? [] : [epicId];
      }),
    ]),
  );
}

function nextReconcileCursor(page: ListTasksResponse): string | null {
  if (!page.hasMore) return null;
  if (typeof page.nextCursor !== "string") return null;
  if (page.nextCursor.length === 0) return null;
  return page.nextCursor;
}

function addSeenReconcileCursor(
  seenCursors: ReadonlySet<string>,
  cursor: string,
): ReadonlySet<string> {
  const nextSeenCursors = new Set(seenCursors);
  nextSeenCursors.add(cursor);
  return nextSeenCursors;
}

function useVisibleEpicIds(): ReadonlyArray<string> {
  return useEpicCanvasStore(
    useShallow((state) => {
      const seen = new Set<string>();
      return state.openTabOrder
        .map((tabId) => state.tabsById[tabId])
        .flatMap((tab) => {
          if (tab === undefined || seen.has(tab.epicId)) return [];
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
