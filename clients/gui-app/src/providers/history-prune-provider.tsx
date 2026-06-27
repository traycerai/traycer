import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  getHistoryController,
  installPruneScheduler,
} from "@/lib/history-navigation";
import type { AppRouter } from "@/router";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

export interface HistoryPruneProviderProps {
  /**
   * The LIVE app router (the one `TraycerApp` builds with the real desktop
   * `windowId` and hands to `<RouterProvider>`), NOT the module-level
   * `@/router` type-registration singleton. The scheduler reads its `history`
   * (for the branded persistent-history controller) and its `state` (for the
   * in-flight gate) at execution time, so multi-window routers each prune their
   * own stack and the feature stays inert under browser/memory history.
   */
  readonly router: AppRouter;
}

/**
 * Mounts the load-free prune scheduler that keeps the persisted back/forward
 * stack free of dead entries (tech plan §3.3 / §3.4; critique Blocker 1, High
 * 3, High 4). This is the renderer's single mount point for
 * `installPruneScheduler`.
 *
 * Why an effect: this is genuine external-store synchronization (a Zustand +
 * controller subscription installed for the component's lifetime), which is the
 * sanctioned use of `useEffect` under the gui-app "You Might Not Need an Effect"
 * bar — not derived state.
 *
 * Lifecycle:
 * - **Install gate**: only after the canvas + landing-draft stores have hydrated
 *   AND the desktop per-window snapshot has been applied at least once. Pruning
 *   before the stores carry their real contents would read every persisted
 *   `/epics/$epicId/$tabId` and `/draft/$draftId` entry as dead and destroy live
 *   back/forward targets.
 * - **Reactive, not eager**: the scheduler prunes in response to canvas/draft
 *   mutations (the same stores `isHistoryEntryDead` consults). A boot stack that
 *   references now-missing epics is reconciled when `EpicTabExistenceReconciler`
 *   closes those tabs — that store write drives the prune.
 * - **Load-free + non-interleaving**: `isLoadInFlight` is derived from the live
 *   router state so a prune never runs while a navigation is loading or
 *   committing; the scheduler itself calls only `controller.prune`, never
 *   `router.load()` (Blocker 1).
 *
 * Renders nothing.
 */
export function HistoryPruneProvider(
  props: HistoryPruneProviderProps,
): ReactNode {
  const { router } = props;
  const storesHydrated = useStoresHydrated();
  const windowsHydrated = useWindowsBridgeHydrated();
  const hydrated = storesHydrated && windowsHydrated;

  useEffect(() => {
    if (!hydrated) return;
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
    });
  }, [hydrated, router]);

  return null;
}

/**
 * `true` while the router is mid-navigation — loading a match, committing a React
 * transition, or otherwise pending. Reading all three flags (rather than just
 * `status`) keeps the scheduler conservative: over-reporting in-flight only
 * defers a prune by a frame, while under-reporting would let a prune interleave
 * with an in-flight navigation (critique Blocker 1 / High 3).
 */
function isRouterLoadInFlight(router: AppRouter): boolean {
  const state = router.state;
  return state.isLoading || state.isTransitioning || state.status === "pending";
}

/**
 * `true` once BOTH backing stores have finished hydrating from persistence. The
 * snapshot is a primitive boolean, so `useSyncExternalStore` sees a stable value
 * and the gate flips exactly once.
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
