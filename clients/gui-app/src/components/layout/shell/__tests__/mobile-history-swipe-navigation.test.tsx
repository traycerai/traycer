// The whole chain the mobile back swipe rides, end to end. The pieces are all
// real - the tab-navigation controller, its route bridge, the tabs store and
// the shared `goBack` action - because the claim under test is that they
// compose, not that any one of them works.
//
// TWO HISTORIES, and the split is the point. The suites below build a PLAIN
// history to pin the unbranded fallback, which is still what a browser tab
// gets and what `goBack` must keep answering on. The last suite asks the
// question none of them can: which history the installed mobile app actually
// BOOTS with. Every fixture here constructs its own, so all of them would hold
// against a shell whose real history nothing ever writes to - and that is the
// shape this feature shipped in, recognizing perfectly and navigating nowhere.
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  RouterContextProvider,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouter,
  type RouterHistory,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { createAppRouter, type AppRouter } from "@/router";
import {
  getHistoryController,
  historyNavChromeAvailable,
} from "@/lib/history-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { setMobileApp } from "@/lib/mobile-app";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import {
  __resetTabNavigationControllerForTesting,
  activateTabIntent,
  historyTabIntent,
  settingsTabIntent,
} from "@/lib/tab-navigation";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import * as DesktopTabsPersistence from "@/stores/tabs/desktop-tabs-persistence";

vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridgeHydrated: () => true,
}));

// The bridge mounts at the signed-in root on every shell, phone included.
// `navigate` is published from inside the router so activations run against the
// same instance the history under test belongs to.
const navigateProbe: {
  current: UseNavigateResult<string> | null;
} = { current: null };

function ShellLike() {
  const router = useRouter();
  useEffect(() => {
    navigateProbe.current = router.navigate;
  });
  return (
    <>
      <TabNavigationRouteBridge />
      <Outlet />
    </>
  );
}

function buildRouter() {
  const rootRoute = createRootRoute({ component: ShellLike });
  // A splat child rather than the app's real route tree: this suite is about
  // where navigation LANDS, and every landing here is a top-level surface whose
  // component would only add loaders to wait on.
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => <div data-testid="surface" />,
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  return {
    history,
    router: createRouter({
      routeTree: rootRoute.addChildren([anyRoute]),
      history,
    }),
  };
}

function focusedKind(): string | null {
  return selectHostFocusedRef(useTabsStore.getState())?.kind ?? null;
}

/**
 * Two CROSS-ITEM activations, which is what makes them pushes rather than
 * focus-replaces - the same shape as a phone leaving one top-level surface for
 * another.
 */
async function activateSettingsThenHistory(): Promise<void> {
  const navigate = navigateProbe.current;
  if (navigate === null) throw new Error("router never published navigate");
  await act(async () => {
    activateTabIntent(navigate, settingsTabIntent("general"), undefined);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(focusedKind()).toBe("settings");
  });
  await act(async () => {
    activateTabIntent(navigate, historyTabIntent(), undefined);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(focusedKind()).toBe("history");
  });
}

/**
 * The app's real route tree, for the suite that only needs router CONTEXT -
 * the swipe hook reads `useRouter().history` and never renders a route.
 */
function makeRouter(history: RouterHistory): AppRouter {
  return createRouter({
    routeTree,
    history,
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
}

const activeUnmounts: Array<() => void> = [];

beforeEach(() => {
  navigateProbe.current = null;
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  vi.spyOn(
    DesktopTabsPersistence,
    "consumeDesktopRestoredRoute",
  ).mockReturnValue(null);
  __resetTabNavigationControllerForTesting();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setMobileApp(false);
  __resetTabNavigationControllerForTesting();
});

describe("mobile back navigation over a plain history", () => {
  it("re-activates the previous surface on a back step", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    await activateSettingsThenHistory();

    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });

    // The history moved, the bridge observed a BACK, and the controller
    // resolved the landed location back onto the surface that owns it.
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });
  });

  // The step every phone journey ends with and no case above takes: back to
  // HOME. The suites here hop between two tabs, so they never land on the
  // landing path - which is resolved by a different branch entirely, and is the
  // one a user reaches by opening one thing from Home and swiping back.
  it("returns to the landing surface on a back step out of the first tab", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    const navigate = navigateProbe.current;
    if (navigate === null) throw new Error("router never published navigate");

    expect(router.state.location.pathname).toBe("/");
    await act(async () => {
      activateTabIntent(navigate, settingsTabIntent("general"), undefined);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });

    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });

    // The route is back at the landing; the SURFACE has to follow it. A
    // resolver that moves the location and leaves Settings active is the frozen
    // screen the device reports.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("draft");
    });
    // Home is not the absence of a tab: a populated strip always has exactly
    // one active item, and on this shell Home IS the landing draft surface.
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  // The hazard of activating on every step: each press could stack another
  // Home. The landing draft is named rather than minted, so the second press
  // re-activates the one that exists.
  it("re-activates the one Home rather than stacking a draft per step", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    const navigate = navigateProbe.current;
    if (navigate === null) throw new Error("router never published navigate");

    await act(async () => {
      activateTabIntent(navigate, settingsTabIntent("general"), undefined);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });
    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("draft");
    });
    const firstHome = selectHostFocusedRef(useTabsStore.getState())?.id ?? null;
    expect(firstHome).not.toBeNull();

    // Forward into Settings, then back to Home a second time.
    await act(async () => {
      goForward({ history });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });
    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("draft");
    });

    expect(selectHostFocusedRef(useTabsStore.getState())?.id).toBe(firstHome);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it("returns to the later surface on a forward step", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    await activateSettingsThenHistory();
    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });

    await act(async () => {
      goForward({ history });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(focusedKind()).toBe("history");
    });
  });

  // The gesture fires wherever the user is, including on a session that has
  // never navigated. Nothing to step to is not an error state - it is the
  // ordinary case on a freshly-launched app, and it has to leave the surface
  // exactly as it found it.
  it("leaves a fresh session untouched when there is nothing behind it", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    const before = router.state.location.pathname;

    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe(before);
    expect(focusedKind()).toBeNull();
  });
});

/**
 * The seam between the recognizer and the navigation: that an edge swipe
 * reaches the SHARED action rather than a second implementation of "go back".
 * The recognizer's own arbitration is pinned in the shell-gesture suite; what
 * is asserted here is only which call it lands on.
 */
describe("useMobileHistorySwipes", () => {
  function dispatchPointer(
    type: "pointerdown" | "pointermove",
    options: {
      readonly clientX: number;
      readonly timeStamp: number;
    },
  ): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({
      clientX: options.clientX,
      clientY: 300,
      pointerId: 1,
      isPrimary: true,
      target: document.body,
      timeStamp: options.timeStamp,
    })) {
      Object.defineProperty(event, key, { value, configurable: true });
    }
    document.dispatchEvent(event);
  }

  function swipeFromEdge(edge: "leading" | "trailing"): void {
    const from = edge === "leading" ? 8 : window.innerWidth - 8;
    const to = edge === "leading" ? 80 : window.innerWidth - 80;
    act(() => {
      dispatchPointer("pointerdown", { clientX: from, timeStamp: 0 });
      dispatchPointer("pointermove", { clientX: to, timeStamp: 100 });
    });
  }

  function mountSwipes(history: RouterHistory): AppRouter {
    const router = makeRouter(history);
    const { unmount } = renderHook(() => useMobileHistorySwipes(), {
      wrapper: ({ children }) => (
        <RouterContextProvider router={router}>
          {children}
        </RouterContextProvider>
      ),
    });
    activeUnmounts.push(unmount);
    return router;
  }

  beforeEach(() => {
    setMobileApp(true);
  });

  afterEach(() => {
    setMobileApp(false);
    useMobileNavStore.setState({ open: false });
    for (const unmount of activeUnmounts.splice(0)) unmount();
  });

  it("sends a leading-edge swipe to the shared back action", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    mountSwipes(history);

    swipeFromEdge("leading");

    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("sends a trailing-edge swipe to the shared forward action", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const forwardSpy = vi.spyOn(history, "forward");
    mountSwipes(history);

    swipeFromEdge("trailing");

    expect(forwardSpy).toHaveBeenCalledTimes(1);
  });

  // The drawer covers both edges while it is out, and its own panel is already
  // tracking the finger.
  it("stands down while the navigation drawer is open", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    mountSwipes(history);
    useMobileNavStore.setState({ open: true });

    swipeFromEdge("leading");

    expect(backSpy).not.toHaveBeenCalled();
  });

  /**
   * Driven through a REAL sheet rather than by writing the barrier style
   * directly, because the claim is that the signal the hook reads is the one
   * the app's modal surfaces actually raise. Setting the style by hand would
   * pass against a signal no surface ever produces.
   */
  describe("with a modal layer covering the app", () => {
    function SwipeUnderSheet(props: { readonly sheetOpen: boolean }) {
      useMobileHistorySwipes();
      return (
        <Sheet open={props.sheetOpen}>
          <SheetContent side="bottom">
            <SheetTitle>Confirm</SheetTitle>
          </SheetContent>
        </Sheet>
      );
    }

    function renderUnderSheet(
      history: RouterHistory,
      sheetOpen: boolean,
    ): { rerender: (open: boolean) => void } {
      const router = makeRouter(history);
      const view = render(
        <RouterContextProvider router={router}>
          <SwipeUnderSheet sheetOpen={sheetOpen} />
        </RouterContextProvider>,
      );
      return {
        rerender: (open: boolean) => {
          view.rerender(
            <RouterContextProvider router={router}>
              <SwipeUnderSheet sheetOpen={open} />
            </RouterContextProvider>,
          );
        },
      };
    }

    // Navigating the surface beneath an open sheet would take the user
    // somewhere they cannot see while the sheet is still on top of it.
    it("fires neither action while a sheet is open", async () => {
      const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
      const backSpy = vi.spyOn(history, "back");
      const forwardSpy = vi.spyOn(history, "forward");
      renderUnderSheet(history, true);
      await waitFor(() => {
        expect(document.body.style.pointerEvents).toBe("none");
      });

      swipeFromEdge("leading");
      swipeFromEdge("trailing");

      expect(backSpy).not.toHaveBeenCalled();
      expect(forwardSpy).not.toHaveBeenCalled();
    });

    // The novelty guard for the case above: a stand-down that never lifted
    // would satisfy it just as well as one that keys off the sheet.
    it("navigates again once the sheet closes", async () => {
      const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
      const backSpy = vi.spyOn(history, "back");
      const view = renderUnderSheet(history, true);
      await waitFor(() => {
        expect(document.body.style.pointerEvents).toBe("none");
      });

      act(() => {
        view.rerender(false);
      });
      await waitFor(() => {
        expect(document.body.style.pointerEvents).not.toBe("none");
      });
      swipeFromEdge("leading");

      expect(backSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// The half every suite above was handed for free: a stack with something in it.
// Each one CONSTRUCTS its history, so all of them would pass unchanged on a
// shell whose real history nothing ever writes to - which is exactly the shape
// the feature shipped in. What is pinned here is the boot decision itself:
// which history the installed mobile app gets, and that ordinary surface
// changes make it grow.
describe("the history the mobile app actually boots with", () => {
  function mobileAppHistory(): RouterHistory {
    setMobileApp(true);
    return createAppRouter(null, null).history;
  }

  /** The lightweight tree from this file's other suites, over a given history. */
  function renderShellOver(history: RouterHistory) {
    const rootRoute = createRootRoute({ component: ShellLike });
    const anyRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "$",
      component: () => <div data-testid="surface" />,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([anyRoute]),
      history,
    });
  }

  it("owns its back stack, which the browser build still does not", () => {
    const mobile = mobileAppHistory();
    expect(getHistoryController(mobile)).not.toBeNull();

    setMobileApp(false);
    expect(
      getHistoryController(createAppRouter(null, null).history),
    ).toBeNull();
  });

  // The stack is the phone's, the CHROME is not: the same brand that lights up
  // the desktop's arrows, mouse buttons and palette rows must stay dark on a
  // header with no room for them.
  it("carries the stack without carrying the desktop's chrome", () => {
    const mobile = mobileAppHistory();
    expect(historyNavChromeAvailable(mobile)).toBe(false);
  });

  it("grows an entry when the user changes surface", async () => {
    const history = mobileAppHistory();
    const controller = getHistoryController(history);
    if (controller === null) throw new Error("mobile history lost its brand");
    // A cold launch starts at the landing with nothing behind it - the state
    // every one of these surfaces is reached FROM, and the state that makes a
    // seeded fixture unable to see this bug.
    expect(controller.getIndex()).toBe(0);
    expect(history.canGoBack()).toBe(false);

    render(<RouterProvider router={renderShellOver(history)} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    await activateSettingsThenHistory();

    // Two cross-item activations, two entries. Without them the recognizer
    // fires, every gate passes, and `goBack` lands on an index that cannot move.
    expect(controller.getIndex()).toBe(2);
    expect(history.canGoBack()).toBe(true);

    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });
    expect(controller.getIndex()).toBe(1);

    // The next COLD LAUNCH, through the same boot path that produced the stack
    // above: a second router, same arguments, and none of it carried over. The
    // stack is the session's, and the session ends with the process.
    const relaunched = getHistoryController(mobileAppHistory());
    if (relaunched === null) throw new Error("mobile history lost its brand");
    expect(relaunched.getIndex()).toBe(0);
    expect(relaunched.getEntries()).toEqual(["/"]);
  });
});
