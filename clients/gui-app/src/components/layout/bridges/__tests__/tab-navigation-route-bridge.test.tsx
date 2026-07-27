import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";

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

const testState = vi.hoisted(() => ({
  subscriber: null as ((input: HistoryObserverInput) => void) | null,
  replaceCalls: [] as Array<ReplaceCall>,
  restoredRoute: null as string | null,
  blockerRegistered: false,
  observeLocation: vi.fn(),
  updateActiveRoute: vi.fn(),
  synchronizeInitialLocation: vi.fn(),
  setHydrationReady: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(),
    state: {
      location: {
        pathname: "/live",
        search: {},
        searchStr: "",
        state: {},
      },
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
        // Mirrors `@tanstack/history`'s `tryNavigation`, which is an `async`
        // function: it reaches the task that notifies subscribers WITHOUT
        // executing an `await` only when blockers are skipped or none are
        // registered. On the blocker path it awaits the blocker first, so the
        // notification lands a microtask after `replace` has already returned.
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

vi.mock("@/stores/tabs/desktop-tabs-persistence", () => ({
  consumeDesktopRestoredRoute: () => testState.restoredRoute,
  updateDesktopTabsActiveRoute: (route: string) => {
    testState.updateActiveRoute(route);
  },
}));

vi.mock("@/lib/tab-navigation", () => ({
  tabNavigationController: {
    setNavigator: vi.fn(),
    setLocationReader: vi.fn(),
    observeLocation: (...args: Array<unknown>) => {
      testState.observeLocation(...args);
    },
    synchronizeInitialLocation: () => {
      testState.synchronizeInitialLocation();
    },
    setHydrationReady: (...args: Array<unknown>) => {
      testState.setHydrationReady(...args);
    },
  },
}));

beforeEach(() => {
  testState.subscriber = null;
  testState.replaceCalls = [];
  testState.restoredRoute = "/restored?tab=1";
  testState.blockerRegistered = false;
  testState.observeLocation.mockClear();
  testState.updateActiveRoute.mockClear();
  testState.synchronizeInitialLocation.mockClear();
  testState.setHydrationReady.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("TabNavigationRouteBridge restored-route replacement", () => {
  it("keeps the bookkeeping replace unobserved even with a navigation blocker registered", async () => {
    // The skip flag is a synchronous window: raised, `replace` called, lowered.
    // A registered blocker makes `tryNavigation` await before it notifies, so
    // an unguarded replace would deliver REPLACE after the window closed and
    // the restored entry would be observed as an external commit - losing the
    // `preserveStartupFocus` handling T3 gives startup work.
    testState.blockerRegistered = true;

    render(<TabNavigationRouteBridge />);
    await Promise.resolve();
    await Promise.resolve();

    expect(testState.replaceCalls).toEqual([
      { path: "/restored?tab=1", ignoreBlocker: true },
    ]);
    expect(testState.observeLocation).not.toHaveBeenCalled();
  });

  it("still observes a genuine post-hydration entry", async () => {
    // Novelty guard for the assertion above: the subscription has to be live
    // and observing, or "never observed" would hold against a bridge that
    // simply never subscribed.
    testState.blockerRegistered = true;

    render(<TabNavigationRouteBridge />);
    await Promise.resolve();
    testState.updateActiveRoute.mockClear();

    testState.subscriber?.({
      location: { pathname: "/epics/e1", state: {}, search: "?focusedAt=7" },
      action: { type: "PUSH" },
    });

    expect(testState.observeLocation).toHaveBeenCalledTimes(1);
    expect(testState.updateActiveRoute).toHaveBeenCalledWith(
      "/epics/e1?focusedAt=7",
    );
  });

  it("does not replace at all when nothing was restored", async () => {
    testState.restoredRoute = null;

    render(<TabNavigationRouteBridge />);
    await Promise.resolve();

    expect(testState.replaceCalls).toEqual([]);
    expect(testState.setHydrationReady).toHaveBeenCalled();
  });
});
