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
    state: { location: testState.routerLocation },
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
  useWindowsBridgeHydrated: () => true,
}));

beforeEach(() => {
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

function seedRestoredRoute(route: string | null): void {
  vi.spyOn(
    DesktopTabsPersistence,
    "consumeDesktopRestoredRoute",
  ).mockReturnValue(route);
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
