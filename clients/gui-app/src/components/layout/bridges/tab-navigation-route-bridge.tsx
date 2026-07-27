import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { tabNavigationController } from "@/lib/tab-navigation";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import {
  consumeDesktopRestoredRoute,
  updateDesktopTabsActiveRoute,
} from "@/stores/tabs/desktop-tabs-persistence";

/**
 * Observes committed history entries once at the signed-in root. The
 * controller, rather than route render effects, distinguishes an internal
 * activation envelope from an external route (including Back and Forward).
 */
export function TabNavigationRouteBridge(): null {
  const router = useRouter();
  const hydrationReady = useWindowsBridgeHydrated();
  const hydrationReadyRef = useRef(hydrationReady);
  const observedBeforeHydrationRef = useRef(false);
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
    const observe = (input: {
      readonly location: {
        readonly pathname: string;
        readonly state: unknown;
        // `HistoryLocation.search` is the raw query string, never a parsed
        // object. Declaring the wider union invited a lossy re-serializer that
        // dropped every non-string param (`focusedAt` and friends), while the
        // hydration writer below persisted `searchStr` intact - so the stored
        // route depended on which writer ran last.
        readonly search: string;
      };
      readonly action: {
        readonly type: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";
      };
    }): void => {
      if (skipRestoredRouteObservationRef.current) return;
      if (!hydrationReadyRef.current) {
        observedBeforeHydrationRef.current = true;
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
          search: Object.fromEntries(
            new URLSearchParams(input.location.search),
          ),
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
    const restoredRoute = observedBeforeHydrationRef.current
      ? null
      : consumeDesktopRestoredRoute();
    if (restoredRoute !== null) {
      // Replace the current persisted entry BEFORE T3's first startup
      // synchronization. The subscription deliberately ignores this one
      // bookkeeping replacement, so T3 queues the restored entry as startup
      // work with `preserveStartupFocus = true` instead of an external commit.
      skipRestoredRouteObservationRef.current = true;
      try {
        // `ignoreBlocker` is what keeps the skip window honest, not a
        // convenience: `tryNavigation` is `async`, and on the blocker path it
        // awaits before running the task that notifies subscribers. `replace`
        // would then return - resetting the flag below - and the REPLACE
        // notification would land a microtask later with the flag already
        // down, so this bookkeeping entry would be observed as an external
        // commit and lose `preserveStartupFocus`. Skipping blockers takes the
        // synchronous path, and is right on its own terms too: re-establishing
        // the route this window already showed at shutdown is not a user
        // navigation away from anything, so no guard should prompt on it.
        router.history.replace(restoredRoute, undefined, {
          ignoreBlocker: true,
        });
      } finally {
        // The synchronous path runs the persistent-history write and the
        // subscriber notification inside this call, both of which can throw
        // (a quota-exceeded persist, an observer fault). Resetting anywhere
        // but a `finally` would latch the flag, and `observe` returns early on
        // it - route observation and persistence would stay silently dead for
        // the rest of the session, long after the throw was handled upstream.
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
