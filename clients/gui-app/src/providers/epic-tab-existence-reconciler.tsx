import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isConfirmedAbsentTaskContext,
  type GetTaskContextsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useShallow } from "zustand/react/shallow";
import {
  useHostClient,
  useHostCompatibility,
  type HostRpcRegistry,
} from "@/lib/host";
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

/** Existence for open-tab epic ids via optional `epic.getTaskContexts`. Only a positive absence result is actionable. Unsupported, pending, or failed batches must conclude nothing: this run force-closes tabs. */
const RECONCILE_METHOD = "epic.getTaskContexts" as const;

/** Collapses remount repeats into one RPC while still re-asking the host inside a session. */
const EXISTENCE_STALE_TIME_MS = 30_000;

export function EpicTabExistenceReconciler() {
  const seed = usePersistedEpicTabReconcileSeed();
  if (seed === null) return null;
  return <EpicTabReconciliationRun key={seed.identity} seed={seed} />;
}

interface ReconcileSeed {
  readonly identity: string;
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
  // Three-valued (`null` = no handshake yet). Only `true` may license a run. `compatibility.status` is a floor probe and says nothing about this optional method.
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

/** Freeze the probed id set. Tabs opened or closed after start must not re-key the batch. */
function EpicTabReconciliationRun(props: { readonly seed: ReconcileSeed }) {
  const [run] = useState<ReconcileSeed>(() => props.seed);

  return <EpicTabExistenceProbe run={run} />;
}

function EpicTabExistenceProbe(props: { readonly run: ReconcileSeed }) {
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
  // `null` until every batch has succeeded. `completionAppliedRef` keeps the apply once-only.
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

  useEffect(() => {
    if (confirmedAbsentEpicIds === null) return;
    if (completionAppliedRef.current) return;
    completionAppliedRef.current = true;
    // Never force-close an epic this session just created: cloud reads lag `epic.create`. Remote delete of an OPEN epic is `EpicAccessCoordinator`.
    const staleEpicIds = closableStaleEpicIds([...confirmedAbsentEpicIds]);
    if (staleEpicIds.length > 0) {
      useComposerRunSettingsStore.getState().clearEpicRunSettings(staleEpicIds);
      tabCommandCoordinator.handleEpicAccessLoss(staleEpicIds);
    }
  }, [confirmedAbsentEpicIds]);

  return null;
}

/** Open epic ids the host positively confirmed absent, or `null` when any batch is pending or failed. Do not soften failure into an empty set: here empty means every open tab is stale. */
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

/** Protect session-created epics, live registry sessions, and active initial-chat handoffs. Evaluated at close time. */
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
