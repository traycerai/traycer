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
        readonly search: string | Readonly<Record<string, unknown>>;
      };
      readonly action: {
        readonly type: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";
      };
    }): void => {
      if (skipRestoredRouteObservationRef.current) return;
      if (!hydrationReadyRef.current) {
        observedBeforeHydrationRef.current = true;
      }
      const search = locationSearch(input.location.search);
      updateDesktopTabsActiveRoute(`${input.location.pathname}${search}`);
      tabNavigationController.observeLocation(
        {
          pathname: input.location.pathname,
          state: input.location.state,
          search:
            typeof input.location.search === "string"
              ? Object.fromEntries(new URLSearchParams(input.location.search))
              : input.location.search,
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
      router.history.replace(restoredRoute);
      skipRestoredRouteObservationRef.current = false;
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

function locationSearch(
  search: string | Readonly<Record<string, unknown>>,
): string {
  if (typeof search === "string") return search;
  const params = new URLSearchParams();
  Object.entries(search).forEach(([key, value]) => {
    if (typeof value === "string") params.set(key, value);
  });
  const serialized = params.toString();
  return serialized.length === 0 ? "" : `?${serialized}`;
}
