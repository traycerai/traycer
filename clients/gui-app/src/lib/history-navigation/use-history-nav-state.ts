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
 * What a history with no controller brand can report. Frozen module constants
 * rather than fresh objects, because `useSyncExternalStore` compares snapshots
 * by reference and would re-render forever on a new one per read.
 *
 * `canGoForward` is false in BOTH of them, and that is not a claim that there
 * is nothing ahead - a plain history cannot answer the question at all (see
 * `stepPlainHistory`). It is the honest reading of a signal that does not
 * exist: a control is only shown as available when something can prove it
 * leads somewhere. The ACTION stays attemptable regardless, which is the whole
 * asymmetry - a deliberate gesture may try and land nowhere, while a
 * permanently-lit affordance would be a standing lie.
 */
const BACK_ONLY_STATE: HistoryNavState = {
  canGoBack: true,
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
 * Under a history with no controller (browser/memory) it subscribes to that
 * history instead and reports the one thing it can prove: whether the session
 * has navigated at all, read off the index the router stamps into each entry.
 * See `BACK_ONLY_STATE` for why forward is reported unavailable rather than
 * unknown.
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
      // The history's own subscription is what a plain backend has in place of
      // the controller store: it fires on every push, replace and pop, which
      // covers every way the index this snapshot reads can move.
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
