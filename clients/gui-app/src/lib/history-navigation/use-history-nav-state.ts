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
 * What a history with no controller brand can report.
 * Frozen module constants rather than fresh objects, because `useSyncExternalStore` compares snapshots by reference and would re-render forever on a new one per read.
 */
const BACK_ONLY_STATE: HistoryNavState = {
  canGoBack: true,
  canGoForward: false,
};

/** Load-free enabled/disabled signal for the back/forward arrows. */
export function useHistoryNavState(): HistoryNavState {
  const router = useRouter();
  const controller = getHistoryController(router.history);
  const cacheRef = useRef<HistoryNavState>(DISABLED_STATE);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // The history's own subscription is what a plain backend has in place of the controller store: it fires on every push, replace and pop, which covers every way the index this snapshot reads can move.
      if (controller === null) return router.history.subscribe(onStoreChange);
      const unsubscribeController = controller.subscribe(onStoreChange);
      const unsubscribeCanvas = useEpicCanvasStore.subscribe(onStoreChange);
      return () => {
        unsubscribeController();
        unsubscribeCanvas();
      };
    },
    [controller, router],
  );

  const getSnapshot = useCallback(() => {
    if (controller === null) {
      return router.history.canGoBack() ? BACK_ONLY_STATE : DISABLED_STATE;
    }
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
  }, [controller, router]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
