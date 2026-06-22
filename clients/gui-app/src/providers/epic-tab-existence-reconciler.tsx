import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useHostClient } from "@/lib/host";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  fetchExistingEpicIds,
  missingEpicIds,
} from "@/lib/epics/epic-tab-existence";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  collectOpenEpicIds,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";

export function EpicTabExistenceReconciler() {
  useReconcilePersistedEpicTabs();
  return null;
}

function useReconcilePersistedEpicTabs(): void {
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const windowsHydrated = useWindowsBridgeHydrated();
  const authStatus = useAuthStore((state) => state.status);
  const authUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const canvasHydrationVersion = useEpicCanvasHydrationVersion();
  const [reconciledIdentities] = useState(() => new Set<string>());

  const identity = useMemo(() => {
    if (!windowsHydrated) return null;
    if (authStatus !== "signed-in") return null;
    if (readiness.hostId === null) return null;
    if (authUserId === null) return null;
    if (readiness.requestContextUserId !== authUserId) return null;
    return `${readiness.hostId}:${authUserId}:${canvasHydrationVersion}`;
  }, [
    authStatus,
    authUserId,
    canvasHydrationVersion,
    readiness.hostId,
    readiness.requestContextUserId,
    windowsHydrated,
  ]);

  useEffect(() => {
    if (identity === null) return;
    if (reconciledIdentities.has(identity)) return;
    reconciledIdentities.add(identity);

    const openEpicIds = collectOpenEpicIds();
    if (openEpicIds.length === 0) return;

    let cancelled = false;
    void fetchExistingEpicIds(client)
      .then((existingEpicIds) => {
        if (cancelled) return;
        const staleEpicIds = missingEpicIds(openEpicIds, existingEpicIds);
        if (staleEpicIds.length === 0) return;
        useComposerRunSettingsStore
          .getState()
          .clearEpicRunSettings(staleEpicIds);
        useEpicCanvasStore.getState().closeTabsForEpics(staleEpicIds);
      })
      .catch(() => {
        if (!cancelled) {
          reconciledIdentities.delete(identity);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, identity, reconciledIdentities]);
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
