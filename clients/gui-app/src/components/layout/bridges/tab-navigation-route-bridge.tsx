import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { tabNavigationController } from "@/lib/tab-navigation";
import { isStartupNavigationIntent } from "@/lib/host/startup-navigation-intent";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import {
  consumeDesktopRestoredRoute,
  updateDesktopTabsActiveRoute,
} from "@/stores/tabs/desktop-tabs-persistence";

export interface TabNavigationHistoryEvent {
  readonly location: {
    readonly pathname: string;
    readonly state: unknown;
    // `HistoryLocation.search` is the raw query string, never a parsed object.
    readonly search: string;
  };
  readonly action: {
    readonly type: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";
  };
}

/** Observes committed history entries for the whole app lifetime. IT does not see the whole launch, and must
 * not be "fixed" by mounting it earlier. */
export function TabNavigationRouteBridge(): null {
  const router = useRouter();
  const hydrationReady = useWindowsBridgeHydrated();
  const hydrationReadyRef = useRef(hydrationReady);
  const startupIntentBeforeHydrationRef = useRef(false);
  const skipRestoredRouteObservationRef = useRef(false);

  useEffect(() => {
    hydrationReadyRef.current = hydrationReady;
  }, [hydrationReady]);

  useEffect(() => {
    tabNavigationController.setNavigator(router.navigate);
    tabNavigationController.setLocationReader(() => ({
      pathname: router.state.location.pathname,
      state: router.state.location.state,
      search: router.state.location.search,
    }));
    const observe = (input: TabNavigationHistoryEvent): void => {
      if (skipRestoredRouteObservationRef.current) return;
      // Only a declared escape-hatch navigation counts as user intent here. Latching on that would veto the restore
      // below and strand the window on the landing page instead of the tab it was showing at shutdown.
      if (
        !hydrationReadyRef.current &&
        isStartupNavigationIntent(input.location.state)
      ) {
        startupIntentBeforeHydrationRef.current = true;
      }
      // Same serialization as the hydration writer below: the raw query string
      // straight through, including its leading `?`.
      updateDesktopTabsActiveRoute(
        `${input.location.pathname}${input.location.search}`,
      );
      tabNavigationController.observeLocation(
        {
          pathname: input.location.pathname,
          state: input.location.state,
          // History exposes the raw query string, but navigation restoration needs the same parsed values the router
          // uses.
          search: router.options.parseSearch(input.location.search),
        },
        input.action.type,
        router.navigate,
      );
    };
    const unsubscribe = router.history.subscribe(observe);
    return () => {
      unsubscribe();
      tabNavigationController.setLocationReader(null);
      tabNavigationController.setNavigator(null);
    };
  }, [router]);

  useEffect(() => {
    if (!hydrationReady) return;
    // Spend the launch's restored route unconditionally, then decide whether to apply it.
    const pendingRestoredRoute = consumeDesktopRestoredRoute();
    // The marker rides in history state, so a press taken in the gap between first paint and this bridge's passive
    // effects is honoured.
    const startupIntent =
      startupIntentBeforeHydrationRef.current ||
      isStartupNavigationIntent(router.state.location.state);
    const restoredRoute = startupIntent ? null : pendingRestoredRoute;
    if (restoredRoute !== null) {
      // The subscription deliberately ignores this one bookkeeping replacement, so the restored entry is queued as
      // startup work with `preserveStartupFocus = true` instead of an external commit.
      skipRestoredRouteObservationRef.current = true;
      try {
        // `ignoreBlocker` is what keeps the skip window honest, not a convenience: `tryNavigation` is `async`, and on
        // the blocker path it awaits before running the task that notifies subscribers.
        router.history.replace(restoredRoute, undefined, {
          ignoreBlocker: true,
        });
      } finally {
        // Resetting anywhere but a `finally` would latch the flag, and `observe` returns early on it - route
        // observation and persistence would stay silently dead for the rest of the session.
        skipRestoredRouteObservationRef.current = false;
      }
    }
    // Subscribe before synchronizing so no committed entry can fall into the
    // setup window. This bridge remains mounted outside HostReadyGate.
    tabNavigationController.synchronizeInitialLocation();
    updateDesktopTabsActiveRoute(
      `${router.state.location.pathname}${router.state.location.searchStr}`,
    );
    tabNavigationController.setHydrationReady(true, router.navigate);
  }, [hydrationReady, router]);

  return null;
}
