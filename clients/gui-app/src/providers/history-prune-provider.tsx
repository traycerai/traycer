import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  getHistoryController,
  isHistoryEntryDead,
  installPruneScheduler,
} from "@/lib/history-navigation";
import type { AppRouter } from "@/router";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

export interface HistoryPruneProviderProps {
  /** Live TraycerApp router, not the @/router type singleton. Each window prunes its own stack; inert under browser/memory history. */
  readonly router: AppRouter;
}

/** Load-free prune scheduler. Install only after canvas, landing-draft, and per-window snapshot have hydrated. Never prune while a navigation is loading; never call `router.load()`. */
export function HistoryPruneProvider(
  props: HistoryPruneProviderProps,
): ReactNode {
  const { router } = props;
  const storesHydrated = useStoresHydrated();
  const windowsHydrated = useWindowsBridgeHydrated();
  const hydrated = storesHydrated && windowsHydrated;

  useEffect(() => {
    if (!hydrated) return;
    // Sanitize the restored stack now. The scheduler only sees future
    // mutations; a restored dead entry would recreate its source tab.
    const controller = getHistoryController(router.history);
    const hasInitialDeadEntry =
      controller !== null &&
      controller
        .getEntries()
        .some(
          (href, index) =>
            index !== controller.getIndex() && isHistoryEntryDead(href),
        );
    const loading = isRouterLoadInFlight(router);
    if (hasInitialDeadEntry && !loading) {
      controller.prune(isHistoryEntryDead);
    }
    return installPruneScheduler({
      getController: () => getHistoryController(router.history),
      subscribeStores: (onChange) => {
        const unsubscribeCanvas = useEpicCanvasStore.subscribe(onChange);
        const unsubscribeDrafts = useLandingDraftStore.subscribe(onChange);
        return () => {
          unsubscribeCanvas();
          unsubscribeDrafts();
        };
      },
      isLoadInFlight: () => isRouterLoadInFlight(router),
      // When router hydration is still loading, the eager pass above must not
      // prune mid-navigation. Seed the scheduler instead; it already retries
      // frame-by-frame until idle, then performs this same first sanitation.
      scheduleInitialPrune: hasInitialDeadEntry && loading,
    });
  }, [hydrated, router]);

  return null;
}

/** All three in-flight flags, not just status: under-reporting would prune during an in-flight navigation. */
function isRouterLoadInFlight(router: AppRouter): boolean {
  const state = router.state;
  return state.isLoading || state.isTransitioning || state.status === "pending";
}

/**
 * True once both stores have hydrated. Primitive boolean so the gate flips once.
 */
function useStoresHydrated(): boolean {
  return useSyncExternalStore(
    subscribeStoreHydration,
    getStoreHydrationSnapshot,
    getStoreHydrationSnapshot,
  );
}

function subscribeStoreHydration(callback: () => void): () => void {
  const unsubscribeCanvas =
    useEpicCanvasStore.persist.onFinishHydration(callback);
  const unsubscribeDrafts =
    useLandingDraftStore.persist.onFinishHydration(callback);
  return () => {
    unsubscribeCanvas();
    unsubscribeDrafts();
  };
}

function getStoreHydrationSnapshot(): boolean {
  return (
    useEpicCanvasStore.persist.hasHydrated() &&
    useLandingDraftStore.persist.hasHydrated()
  );
}
