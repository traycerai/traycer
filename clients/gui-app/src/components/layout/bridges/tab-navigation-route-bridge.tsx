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
}

/**
 * Observes committed history entries for the whole app lifetime. The
 * controller, rather than route render effects, distinguishes an internal
 * activation envelope from an external route (including Back and Forward).
 *
 * IT DOES NOT SEE THE WHOLE LAUNCH, and must not be "fixed" by mounting it
 * earlier. It mounts in `RootComponent`, inside `RouterProvider`, so it does
 * not exist during the first boot surface (`HostRuntimeBootFallback` renders
 * as `HostRuntimeProvider`'s fallback, above the router). A navigation made
 * there - the boot card's `Open settings` escape hatch is the only one a user
 * can make - is therefore never observed, and the restored-route replay below
 * used to overwrite it: measured, an explicit `/settings/host` replaced by
 * `/epics/<id>/<tab>` on every warm launch, so the escape hatch appeared to do
 * nothing.
 *
 * The fix is NOT earlier mounting. That navigation DECLARES itself in history
 * state (`startup-navigation-intent.ts`) and the hydration effect reads the
 * marker off the CURRENT location, so it survives whether or not this bridge
 * was subscribed when the commit landed. Mounting above `HostRuntimeProvider`
 * was tried and reverted: from up there this observer also sees the transient
 * `/` a cold launch redirects ITSELF to - `requireSignedIn` fires while stored
 * tokens are still validating - and treating that as user intent vetoes the
 * restore, stranding the window on the landing page.
 */
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
      // ONLY a DECLARED escape-hatch navigation counts as user intent here.
      // This used to latch on any pre-hydration commit, which was safe only
      // while this bridge mounted too late to see startup traffic: a cold
      // launch REPLACES to `/` on its own, because every protected route runs
      // `requireSignedIn` while stored tokens are still validating. Latching on
      // that would veto the restore below and strand the window on the landing
      // page instead of the tab it was showing at shutdown.
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
          // History exposes the raw query string, but navigation restoration
          // needs the same parsed values the router uses. In particular, the
          // default parser JSON-decodes multi-select arrays; URLSearchParams
          // would leave them as JSON-looking strings and double-encode them on
          // reactivation.
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
    // SPEND the launch's restored route unconditionally, then decide whether to
    // apply it. It is a one-shot for THIS launch, and leaving it pending when
    // the user's intent wins is not inert: only `WindowsBridgeProvider`'s
    // cleanup clears it, and that provider outlives auth changes, while THIS
    // bridge is unmounted and remounted by `RootComponent` on sign-out/sign-in.
    // A later mount - by which point the current location no longer carries the
    // marker - would then spend the stale token and replace whatever the user
    // was looking at with an epic from the previous session.
    const pendingRestoredRoute = consumeDesktopRestoredRoute();
    // Read the marker off the CURRENT location as well as the observed commit,
    // so this does not depend on the subscription having been live when the
    // commit landed. The marker rides in history state, so a press taken in the
    // gap between first paint and this bridge's passive effects is honoured.
    const startupIntent =
      startupIntentBeforeHydrationRef.current ||
      isStartupNavigationIntent(router.state.location.state);
    const restoredRoute = startupIntent ? null : pendingRestoredRoute;
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
