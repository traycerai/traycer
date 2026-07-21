import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { tabNavigationController } from "@/lib/tab-navigation";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";

/**
 * Observes committed history entries once at the signed-in root. The
 * controller, rather than route render effects, distinguishes an internal
 * activation envelope from an external route (including Back and Forward).
 */
export function TabNavigationRouteBridge(): null {
  const router = useRouter();
  const hydrationReady = useWindowsBridgeHydrated();

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
    // Subscribe before synchronizing so no committed entry can fall into the
    // setup window. This bridge remains mounted outside HostReadyGate.
    tabNavigationController.synchronizeInitialLocation();
    return () => {
      unsubscribe();
      tabNavigationController.setLocationReader(null);
      tabNavigationController.setNavigator(null);
    };
  }, [router]);

  useEffect(() => {
    tabNavigationController.setHydrationReady(hydrationReady, router.navigate);
  }, [hydrationReady, router]);

  return null;
}
