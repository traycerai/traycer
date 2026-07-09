import type { RouterHistory } from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * The single function every back/forward surface calls. Takes the **current**
 * router (the live instance in `<RouterProvider>`), never the module-level
 * `router` singleton from `@/router` - that throwaway carries a different,
 * inert history stack.
 *
 * Narrowed to the one field these helpers read (`history`) so callers pass
 * `useRouter()` directly and tests supply a tiny fake without an unsafe cast to
 * `AnyRouter`.
 */
export interface HistoryNavRouter {
  readonly history: RouterHistory;
}

/**
 * Step one entry back in the current router's persistent history. No-op when
 * the history carries no controller brand (browser/web build), so the feature
 * is wholly inert outside Electron, AND no-op at the start of the stack: a
 * boundary `go(-1)` still notifies → `router.load()` re-runs the current route
 * for nothing. Guarding on `canGoBack()` keeps every input path (keyboard,
 * mouse, palette) from firing that same-route load. Otherwise delegates to the
 * built-in `history.go(-1)`, which notifies the router and runs a real load.
 */
export function goBack(router: HistoryNavRouter): void {
  const controller = getHistoryController(router.history);
  if (controller === null) {
    return;
  }
  if (!controller.canGoBack()) {
    return;
  }
  router.history.go(-1);
  trackHistoryNavigationUsed("back");
}

/**
 * Step one entry forward in the current router's persistent history. No-op when
 * the history carries no controller brand, AND at the end of the stack (a
 * boundary `go(1)` would notify → re-load the current route). Otherwise
 * delegates to the built-in `history.go(1)`.
 */
export function goForward(router: HistoryNavRouter): void {
  const controller = getHistoryController(router.history);
  if (controller === null) {
    return;
  }
  if (!controller.canGoForward()) {
    return;
  }
  router.history.go(1);
  trackHistoryNavigationUsed("forward");
}

type HistoryNavigationDirection = "back" | "forward";

function trackHistoryNavigationUsed(
  direction: HistoryNavigationDirection,
): void {
  globalThis.setTimeout(() => {
    try {
      Analytics.getInstance().track(AnalyticsEvent.HistoryNavigationUsed, {
        direction,
      });
    } catch {
      // Analytics is best-effort and must never affect navigation.
    }
  }, 0);
}
