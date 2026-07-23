import { useCallback, useRef, useSyncExternalStore } from "react";
import { useRouter } from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  findEligibleOffset,
  isHistoryEntryEligible,
} from "@/lib/history-navigation/eligibility";

export interface HistoryNavState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

const DISABLED_STATE: HistoryNavState = {
  canGoBack: false,
  canGoForward: false,
};

/**
 * Load-free enabled/disabled signal for the back/forward arrows.
 *
 * Subscribes to BOTH the CURRENT router history's controller store AND
 * `useEpicCanvasStore` via `useSyncExternalStore`, so it recomputes on prune,
 * on every real navigation (the history callbacks poke the controller
 * store), AND when closing/reopening a Task flips eligibility with no
 * history event at all - none of these ever read `router.stores.location`,
 * so none force a `router.load()` (tech plan §3.5).
 *
 * "Enabled" now means an ELIGIBLE entry exists in that direction (closed-Task
 * entries don't count - see `findEligibleOffset`), not just that the raw
 * stack has room to move; a scan bounded by the (capped) entry count is cheap
 * enough to run on every snapshot read.
 *
 * Under browser/memory history (no controller) the snapshot is the stable
 * `DISABLED_STATE`, so both arrows stay disabled.
 *
 * The snapshot is cached and only rebuilt when `canGoBack`/`canGoForward`
 * actually change, so `useSyncExternalStore` sees a stable reference and does
 * not loop.
 */
export function useHistoryNavState(): HistoryNavState {
  const router = useRouter();
  const controller = getHistoryController(router.history);
  const cacheRef = useRef<HistoryNavState>(DISABLED_STATE);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (controller === null) return () => {};
      const unsubscribeController = controller.subscribe(onStoreChange);
      const unsubscribeCanvas = useEpicCanvasStore.subscribe(onStoreChange);
      return () => {
        unsubscribeController();
        unsubscribeCanvas();
      };
    },
    [controller],
  );

  const getSnapshot = useCallback(() => {
    if (controller === null) return DISABLED_STATE;
    const previous = cacheRef.current;
    const entries = controller.getEntries();
    const index = controller.getIndex();
    const canvasState = useEpicCanvasStore.getState();
    const isEligible = (href: string) =>
      isHistoryEntryEligible(href, canvasState);
    const canGoBack =
      findEligibleOffset(entries, index, -1, isEligible) !== null;
    const canGoForward =
      findEligibleOffset(entries, index, 1, isEligible) !== null;
    if (
      previous.canGoBack === canGoBack &&
      previous.canGoForward === canGoForward
    ) {
      return previous;
    }
    const next: HistoryNavState = { canGoBack, canGoForward };
    cacheRef.current = next;
    return next;
  }, [controller]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
