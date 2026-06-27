import { useCallback, useRef, useSyncExternalStore } from "react";
import { useRouter } from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";

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
 * Subscribes to the CURRENT router history's controller store via
 * `useSyncExternalStore`, so it recomputes on prune AND on every real
 * navigation (the history callbacks poke the same controller store) WITHOUT
 * ever reading `router.stores.location` — it never forces a `router.load()`
 * (tech plan §3.5).
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
      return controller.subscribe(onStoreChange);
    },
    [controller],
  );

  const getSnapshot = useCallback(() => {
    if (controller === null) return DISABLED_STATE;
    const previous = cacheRef.current;
    const canGoBack = controller.canGoBack();
    const canGoForward = controller.canGoForward();
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
