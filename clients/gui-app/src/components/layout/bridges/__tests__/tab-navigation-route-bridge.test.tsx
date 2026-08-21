import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";

import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import {
  __resetTabNavigationControllerForTesting,
  activateTabIntent,
  historyTabIntent,
  settingsTabIntent,
  tabNavigationController,
} from "@/lib/tab-navigation";
import { STARTUP_NAVIGATION_INTENT_KEY } from "@/lib/host/startup-navigation-intent";
import { withOverlayCleared } from "@/lib/system-tab-overlay-search";
import { useTabsStore } from "@/stores/tabs/store";
import * as DesktopTabsPersistence from "@/stores/tabs/desktop-tabs-persistence";

interface HistoryObserverInput {
  readonly location: {
    readonly pathname: string;
    readonly state: unknown;
    readonly search: string;
  };
  readonly action: {
    readonly type: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";
  };
}

interface ReplaceCall {
  readonly path: string;
  readonly ignoreBlocker: boolean;
}

function parseCanonicalSearch(rawSearch: string): Record<string, unknown> {
  const parsed = Object.fromEntries(new URLSearchParams(rawSearch));
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => {
      try {
        return [key, JSON.parse(value)];
      } catch {
        return [key, value];
      }
    }),
  );
}

// Only the history is faked, and only because the notification TIMING is the
// subject under test: `@tanstack/history`'s `tryNavigation` is `async` and
// reaches the notifying task without executing an `await` only when blockers
// are skipped or none are registered. The controller and the persistence
// module are the real ones.
const testState = vi.hoisted(() => ({
  hydrated: true,
  subscriber: null as ((input: HistoryObserverInput) => void) | null,
  replaceCalls: [] as Array<ReplaceCall>,
  blockerRegistered: false,
  navigate: vi.fn<(options: NavigateOptions) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  parseSearch: vi.fn<(rawSearch: string) => Record<string, unknown>>(),
  routerLocation: {
    pathname: "/live",
    search: {},
    searchStr: "",
    state: {},
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: testState.navigate,
    options: { parseSearch: testState.parseSearch },
    // A GETTER, because the real router's `state.location` is live: reading it
    // twice across a navigation must not hand back the first value. Capturing
    // the object once let a test mutate `testState.routerLocation` and still be
    // served the stale location - a shape production cannot produce, and one
    // that hid whether the marker below was really being read off the current
    // location.
    get state() {
      return { location: testState.routerLocation };
    },
    history: {
      subscribe: (listener: (input: HistoryObserverInput) => void) => {
        testState.subscriber = listener;
        return () => undefined;
      },
      replace: (
        path: string,
        _state: unknown,
        navigateOpts: { readonly ignoreBlocker: boolean } | undefined,
      ): void => {
        const ignoreBlocker = navigateOpts?.ignoreBlocker ?? false;
        testState.replaceCalls.push({ path, ignoreBlocker });
        const notify = (): void => {
          testState.subscriber?.({
            location: { pathname: path, state: {}, search: "" },
            action: { type: "REPLACE" },
          });
        };
        if (ignoreBlocker || !testState.blockerRegistered) {
          notify();
          return;
        }
        void Promise.resolve().then(notify);
      },
    },
  }),
}));

vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridgeHydrated: () => testState.hydrated,
}));

beforeEach(() => {
  testState.hydrated = true;
  testState.subscriber = null;
  testState.replaceCalls = [];
  testState.blockerRegistered = false;
  testState.navigate.mockClear();
  testState.parseSearch.mockReset();
  testState.parseSearch.mockImplementation(parseCanonicalSearch);
  testState.routerLocation = {
    pathname: "/live",
    search: {},
    searchStr: "",
    state: {},
  };
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  __resetTabNavigationControllerForTesting();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetTabNavigationControllerForTesting();
});

/**
 * Models the real module's ONE-SHOT semantics: `consumeDesktopRestoredRoute`
 * nulls `pendingRestoredRoute` as it reads it. A stub that answered the same
 * route on every call could not tell "the token was spent" from "the token is
 * still pending", which is exactly the distinction the remount case below is
 * about.
 */
function seedRestoredRoute(route: string | null): void {
  let pending = route;
  vi.spyOn(
    DesktopTabsPersistence,
    "consumeDesktopRestoredRoute",
  ).mockImplementation(() => {
    const value = pending;
    pending = null;
    return value;
  });
}

describe("TabNavigationRouteBridge restored-route replacement", () => {
  it("keeps the bookkeeping replace unobserved even with a navigation blocker registered", async () => {
    // The skip flag is a synchronous window: raised, `replace` called, lowered.
    // A registered blocker makes `tryNavigation` await before it notifies, so
    // an unguarded replace would deliver REPLACE after the window closed and
    // the restored entry would reach the controller as an external commit -
    // losing the `preserveStartupFocus` handling T3 gives startup work.
    testState.blockerRegistered = true;
    seedRestoredRoute("/restored?tab=1");
    const observed = vi.spyOn(tabNavigationController, "observeLocation");

    render(<TabNavigationRouteBridge />);
    await Promise.resolve();
    await Promise.resolve();

    expect(testState.replaceCalls).toEqual([
      { path: "/restored?tab=1", ignoreBlocker: true },
    ]);
    expect(observed).not.toHaveBeenCalled();
  });

  it("observes a genuine post-hydration entry with the parsed search shape", async () => {
    // Novelty guard for the assertion above - the subscription has to be live,
    // or "never observed" would hold against a bridge that never subscribed.
    // Also pins the shape contract: history hands the bridge a raw query
    // STRING, and the controller must receive a parsed object. A lossy
    // re-serializer here previously dropped every non-string param.
    testState.blockerRegistered = true;
    seedRestoredRoute(null);
    const observed = vi.spyOn(tabNavigationController, "observeLocation");
    const activeRoute = vi.spyOn(
      DesktopTabsPersistence,
      "updateDesktopTabsActiveRoute",
    );

    render(<TabNavigationRouteBridge />);
    await Promise.resolve();
    activeRoute.mockClear();

    testState.subscriber?.({
      location: {
        pathname: "/epics/e1",
        state: {},
        search: "?focusedAt=7&tab=b",
      },
      action: { type: "PUSH" },
    });

    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0][0]).toEqual({
      pathname: "/epics/e1",
      state: {},
      search: { focusedAt: 7, tab: "b" },
    });
    expect(observed.mock.calls[0][1]).toBe("PUSH");
    // The persisted route keeps the RAW query string, leading `?` included.
    expect(activeRoute).toHaveBeenCalledWith("/epics/e1?focusedAt=7&tab=b");
  });

  it("lets an escape-hatch navigation made before hydration outrank the desktop restored route", () => {
    // THE REGRESSION, in the arm where this bridge DOES see the commit: the
    // press landed after it mounted but before Windows hydration. The restored
    // route must stand down for a navigation that declares itself. (The arm
    // where the press happens on the first boot surface - before this bridge
    // exists at all - is the case below it, which never observes anything.)
    testState.hydrated = false;
    seedRestoredRoute("/epics/epic-1/tab-1?focusPaneId=p1");
    // `rerender`, never a second `render`: a second mount is a second bridge
    // with fresh refs, which would consume the restored route for reasons that
    // have nothing to do with the behaviour under test.
    const { rerender } = render(<TabNavigationRouteBridge />);

    // The press commits `/settings/host` while Windows hydration is still in
    // flight - the ordering a cold launch actually produces.
    act(() => {
      testState.routerLocation = {
        pathname: "/settings/host",
        search: {},
        searchStr: "",
        state: {},
      };
      testState.subscriber?.({
        location: {
          pathname: "/settings/host",
          // The escape hatch DECLARES itself (see `TraycerApp`); the marker is
          // what separates it from the routing traffic a launch makes on its
          // own, and it is why the restore below stands down.
          state: { [STARTUP_NAVIGATION_INTENT_KEY]: true },
          search: "",
        },
        action: { type: "PUSH" },
      });
    });

    // Hydration lands afterwards, carrying the restored route with it.
    act(() => {
      testState.hydrated = true;
      rerender(<TabNavigationRouteBridge />);
    });

    expect(
      testState.replaceCalls,
      "the restored route must not overwrite an explicit user navigation",
    ).toEqual([]);
    expect(
      useTabsStore.getState().systemTabs.settings,
      "the queued settings commit must materialize once hydration releases",
    ).not.toBeNull();
  });

  it("still restores the desktop route when a cold launch redirects itself to / before hydration", () => {
    // THE COUNTER-CASE, and the reason intent is DECLARED rather than inferred.
    // A cold launch REPLACES to `/` with no user input at all: every protected
    // route runs `requireSignedIn` (`src/lib/router-auth.ts`), which redirects
    // while the auth store is still `signed-out` and stored tokens validate.
    // An earlier attempt latched on ANY pre-hydration commit, which vetoed the
    // restore and stranded the window on the landing page instead of the tab it
    // had at shutdown. `persistent-history.ts` refuses to persist that same
    // transient `/` for exactly this reason.
    //
    // It is pinned here even though this bridge mounts too late to see that
    // redirect today, because "mount it earlier" is a standing temptation on
    // this file - and it is the change that makes this reachable.
    testState.hydrated = false;
    seedRestoredRoute("/epics/epic-1/tab-1?focusPaneId=p1");

    const { rerender } = render(<TabNavigationRouteBridge />);

    act(() => {
      testState.routerLocation = {
        pathname: "/",
        search: {},
        searchStr: "",
        state: {},
      };
      testState.subscriber?.({
        // No marker: nothing about this came from the user.
        location: { pathname: "/", state: {}, search: "" },
        action: { type: "REPLACE" },
      });
    });

    act(() => {
      testState.hydrated = true;
      rerender(<TabNavigationRouteBridge />);
    });

    expect(
      testState.replaceCalls,
      "an auth-fallback redirect must not be mistaken for user intent",
    ).toEqual([
      { path: "/epics/epic-1/tab-1?focusPaneId=p1", ignoreBlocker: true },
    ]);
  });

  it("honours the escape-hatch marker on the current location even if the commit was never observed", () => {
    // The subscription is installed in a passive effect, so there is a gap
    // between first paint and it going live. The marker rides in history
    // state, so the decision does not depend on having watched the commit go
    // by - it is read off the location itself.
    testState.hydrated = false;
    seedRestoredRoute("/epics/epic-1/tab-1");
    const { rerender } = render(<TabNavigationRouteBridge />);

    act(() => {
      // Location changed with NO subscriber notification at all.
      testState.routerLocation = {
        pathname: "/settings/host",
        search: {},
        searchStr: "",
        state: { [STARTUP_NAVIGATION_INTENT_KEY]: true },
      };
      testState.hydrated = true;
      rerender(<TabNavigationRouteBridge />);
    });

    expect(testState.replaceCalls).toEqual([]);
  });

  it("spends the launch route even when the escape hatch wins, so a later remount cannot replay it", () => {
    // Raised in review (#1328). Declining to APPLY the restored route is not a
    // reason to leave it PENDING: `pendingRestoredRoute` is cleared only by
    // `WindowsBridgeProvider`'s cleanup, and that provider outlives auth
    // changes, while `RootComponent` unmounts and remounts this bridge on
    // sign-out/sign-in. A stale token surviving that gap gets spent by the
    // later mount - after the location has lost the marker - and replaces
    // whatever the user is looking at with an epic from the previous session.
    seedRestoredRoute("/epics/stale-epic/stale-tab");
    testState.routerLocation = {
      pathname: "/settings/host",
      search: {},
      searchStr: "",
      state: { [STARTUP_NAVIGATION_INTENT_KEY]: true },
    };

    const { unmount } = render(<TabNavigationRouteBridge />);
    expect(
      testState.replaceCalls,
      "the escape hatch outranks the restore on this mount",
    ).toEqual([]);

    // Sign-out unmounts the bridge; sign-in remounts it. By then the user has
    // navigated on, so the current location carries no marker.
    unmount();
    testState.routerLocation = {
      pathname: "/epics/current-epic/current-tab",
      search: {},
      searchStr: "",
      state: {},
    };
    render(<TabNavigationRouteBridge />);

    expect(
      testState.replaceCalls,
      "a spent launch token must not be replayed onto a later session",
    ).toEqual([]);
  });

  it("does not replace at all when nothing was restored", async () => {
    seedRestoredRoute(null);

    render(<TabNavigationRouteBridge />);
    await Promise.resolve();

    expect(testState.replaceCalls).toEqual([]);
  });

  it("restores canonical multi-repo and multi-ownership filters after leaving History", async () => {
    seedRestoredRoute(null);
    testState.routerLocation = {
      pathname: "/epics",
      search: {},
      searchStr: "",
      state: { __TSR_key: "history-start", __TSR_index: 0 },
    };
    render(<TabNavigationRouteBridge />);
    await Promise.resolve();

    const rawHistorySearch =
      "?historyQuery=persistence" +
      "&historyRepos=%5B%22traycerai%2Ftraycer%22%2C%22traycerai%2Ftraycer-internal%22%5D" +
      "&historyOwnership=%5B%22mine%22%2C%22shared%22%5D";
    act(() => {
      testState.subscriber?.({
        location: {
          pathname: "/epics",
          state: { __TSR_key: "history-filtered", __TSR_index: 1 },
          search: rawHistorySearch,
        },
        action: { type: "PUSH" },
      });
    });
    expect(testState.parseSearch).toHaveBeenLastCalledWith(rawHistorySearch);

    const navigate = testState.navigate as UseNavigateResult<string>;
    act(() => {
      activateTabIntent(navigate, settingsTabIntent("general"), undefined);
    });
    act(() => {
      testState.subscriber?.({
        location: {
          pathname: "/settings/general",
          state: { __TSR_key: "settings", __TSR_index: 2 },
          search: "",
        },
        action: { type: "PUSH" },
      });
    });

    testState.navigate.mockClear();
    act(() => {
      activateTabIntent(navigate, historyTabIntent(), {
        search: (previous) => withOverlayCleared(previous),
      });
    });

    expect(testState.navigate).toHaveBeenCalledTimes(1);
    const reactivation = testState.navigate.mock.calls[0]?.[0];
    expect(reactivation.search).toEqual({
      historyQuery: "persistence",
      historyRepos: ["traycerai/traycer", "traycerai/traycer-internal"],
      historyOwnership: ["mine", "shared"],
    });
  });
});
