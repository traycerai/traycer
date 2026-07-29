import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import {
  __resetTabNavigationControllerForTesting,
  tabNavigationController,
} from "@/lib/tab-navigation";
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

// Only the history is faked, and only because the notification TIMING is the
// subject under test: `@tanstack/history`'s `tryNavigation` is `async` and
// reaches the notifying task without executing an `await` only when blockers
// are skipped or none are registered. The controller and the persistence
// module are the real ones.
const testState = vi.hoisted(() => ({
  subscriber: null as ((input: HistoryObserverInput) => void) | null,
  replaceCalls: [] as Array<ReplaceCall>,
  blockerRegistered: false,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(),
    state: {
      location: { pathname: "/live", search: {}, searchStr: "", state: {} },
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
  useWindowsBridgeHydrated: () => true,
}));

beforeEach(() => {
  testState.subscriber = null;
  testState.replaceCalls = [];
  testState.blockerRegistered = false;
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
      search: { focusedAt: "7", tab: "b" },
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
});
