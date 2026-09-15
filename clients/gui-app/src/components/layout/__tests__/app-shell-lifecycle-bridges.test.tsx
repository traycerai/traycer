import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
  type UsageControlsPlacement,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const windowHost = window as { runnerHost?: unknown };
const DESKTOP_VIEWPORT_WIDTH = 1280;
const MOBILE_VIEWPORT_WIDTH = 500;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div data-testid="tab-strip" />,
}));

// Router-dependent like TabStrip: the app-variant header mounts these arrows
// inside the router tree, but this AppShell unit test renders without a
// RouterProvider, so stub them out the same way.
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => <div data-testid="history-nav-buttons" />,
}));

vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => <button type="button">History</button>,
}));

vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));

// Router-dependent like TabStrip, but only on the mobile path: the swipe
// transition reads `useRouter`, which throws in this provider-light shell.
// Desktop self-gates it to nothing, so the stub changes nothing there and lets
// the mobile-app build render here at all.
vi.mock("@/components/layout/shell/use-mobile-history-swipes", () => ({
  useMobileHistorySwipes: () => null,
}));

vi.mock("@/components/open-folder-dialog", () => ({
  OpenFolderDialog: () => <div data-testid="open-folder-dialog" />,
}));

vi.mock("@/components/layout/bridges/quit-intercept-bridge", () => ({
  QuitInterceptBridge: () => <div data-testid="quit-intercept-bridge" />,
}));

vi.mock("@/components/layout/find-in-page-bar", () => ({
  FindInPageBar: () => <div data-testid="legacy-find-in-page-bar" />,
}));

vi.mock("@/components/epic-canvas/tile-find/tile-find-owner-bridge", () => ({
  TileFindOwnerBridge: () => <div data-testid="tile-find-owner-bridge" />,
}));

vi.mock("@/components/layout/bridges/reserved-browser-chords-bridge", () => ({
  ReservedBrowserChordsBridge: () => (
    <div data-testid="reserved-browser-chords" />
  ),
}));

vi.mock("@/components/migration/migration-run-controller", () => ({
  MigrationRunController: () => null,
}));

vi.mock("@/components/layout/dialogs/migration-blocking-modal-host", () => ({
  MigrationBlockingModalHost: () => null,
}));

vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => <div data-testid="notifications-bell" />,
}));

vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => <div data-testid="rate-limit-header-button" />,
}));

// The Windows menu strip routes its popup through a TanStack mutation; this
// provider-light AppShell test has no QueryClient, so stub it like the other
// host/query-backed header children above.
vi.mock("@/components/layout/header/windows-menu-bar", () => ({
  WindowsMenuBar: () => null,
}));

// NOTE: there is deliberately NO stub for `use-epic-open-in-new-window` here.
// `RootDndProvider` used to call that flow, which reaches `useRouterState` and
// throws without a router, so this provider-light test needed a stub. The flow
// now lives in `TabDetachOwner`, mounted in the ROUTE tree - so it never mounts
// here at all. If a stub for it ever becomes necessary again, the dependency
// has moved back into the provider and the fix has regressed.
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => (
    <div data-testid="resource-monitor-header-button" />
  ),
}));

// The real strip resolves a host scope and re-provides two runtime contexts;
// this provider-light test is about WHERE the shell mounts it and under which
// placement, so it stands in for the whole surface the same way the two header
// controls above do.
vi.mock("@/components/layout/status-bar/app-status-bar", () => ({
  AppStatusBar: () => <div data-testid="app-status-bar" />,
}));

vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

// Router-dependent like TabStrip, and only mounted on the mobile path: an OPEN
// drawer renders a recent-task list that reads `useRouterState`. What this
// suite asks of the drawer is its open STATE, which lives in
// `mobile-nav-store` and is untouched by this stub.
vi.mock("@/components/layout/shell/mobile-nav-drawer", () => ({
  MobileNavDrawer: () => <div data-testid="mobile-nav-drawer-stub" />,
}));

// Rendered unconditionally so the surface row's clipping contract can be
// asserted; the real host self-gates on a focused/visible draft surface.
vi.mock("@/components/home/terminal-panel/landing-terminal-host", () => ({
  LandingTerminalHost: () => <div data-testid="landing-terminal-host" />,
}));

// Lazily loaded by the "history" tab kind's descriptor; stubbed the same way
// `top-level-tab-host.test.tsx` stubs it, so a real History tab can be seeded
// here without pulling its full router-backed surface into this
// provider-light shell test.
vi.mock("@/components/epics/history-surface", () => ({
  HistorySurface: () => <div data-testid="history-surface-body" />,
}));

import { AppShell } from "@/components/layout/app-shell";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { setMobileApp } from "@/lib/mobile-app";
import { setNativeKeyboardState } from "@/lib/native-keyboard";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useTabsStore } from "@/stores/tabs/store";

// The status-bar toggle is a dynamic handler, and dynamic dispatch never
// touches the router - every field here just satisfies the parameter type.
const NOOP_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

function renderAppShell(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });

  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={(args: { registry: HostRpcRegistry }) =>
            new MockHostMessenger<HostRpcRegistry>({
              registry: args.registry,
              requestId: () => "app-shell-lifecycle-request",
              handlers: {},
            })
          }
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback" />}
        >
          <AppShell>
            <div data-testid="app-shell-child" />
          </AppShell>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );

  return queryClient;
}

describe("<AppShell />", () => {
  // Undefined until a test renders, and reset after every one: a teardown that
  // dereferences this unconditionally throws over the top of the assertion
  // error that stopped the render, and a binding that survived the test would
  // let a test that forgets to render clear the PREVIOUS test's client.
  let queryClient: QueryClient | undefined;

  beforeEach(() => {
    windowHost.runnerHost = {};
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "Test User", email: "test@example.com" },
        { userId: "user-1", username: "test-user" },
        [],
      );
    useSettingsStore.setState({
      showGlobalResourceMonitor: true,
      homeTabEnabled: false,
    });
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    queryClient?.clear();
    queryClient = undefined;
    delete windowHost.runnerHost;
    setMobileApp(false);
    useAuthStore.getState().setSignedOut();
    useSettingsStore.setState({
      showGlobalResourceMonitor: true,
      homeTabEnabled: false,
    });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    setNativeKeyboardState({ open: false, transitioning: false });
    useMobileNavStore.getState().setOpen(false);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  // The footer is the default, so the strip-drawing cases need no setup at
  // all; the HEADER is the placement a test has to ask for now.
  function selectHeaderPlacement(): void {
    useLayoutStore.setState({
      statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "header" },
    });
  }

  // Its counterpart, for a case that has to NAME the footer placement rather
  // than inherit it: a test whose whole point is that some other gate decides
  // the strip must not go quiet the day the default moves again.
  function selectFooterPlacement(): void {
    useLayoutStore.setState({
      statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "status-bar" },
    });
  }

  it("renders the signed-in app shell around routed children", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.getByTestId("user-menu")).not.toBeNull();
    expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    expect(screen.getByTestId("app-shell-child")).not.toBeNull();
    expect(screen.getByTestId("tile-find-owner-bridge")).not.toBeNull();
    expect(screen.getByTestId("reserved-browser-chords")).not.toBeNull();
    const routeLayer = screen.getByTestId("route-adapter-layer");
    expect(routeLayer.className).toContain("pointer-events-none");
    expect(routeLayer.className).toContain("[&>*]:pointer-events-auto");
    expect(routeLayer.className).toContain("flex");
    expect(routeLayer.className).toContain("h-full");
    expect(routeLayer.className).toContain("min-h-0");
    expect(screen.queryByTestId("legacy-find-in-page-bar")).toBeNull();
    // Host status footer was removed; the combined chip on the
    // composer is now the host-state surface.
    expect(screen.queryByTestId("host-status-footer")).toBeNull();
  });

  it("clips the surface row that hosts the landing terminal panel", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    // The terminal panel sits in this row as a sibling of the tab host, and its
    // 1px resize handle carries a 10px `::after` hit area centred on it. With
    // the panel collapsed the handle is pinned to the row's right edge, so half
    // that hit area lands outside the viewport. The panel used to be nested
    // inside the landing page's own `overflow-hidden` box, which absorbed the
    // overhang; hoisted up here it needs the row to clip, or the overhang
    // becomes document-level scrollable width and the landing page grows a
    // horizontal scrollbar. `TopLevelTabHost` already clips itself for the same
    // reason - this covers everything mounted beside it.
    //
    // `overflow-clip` specifically, not `overflow-hidden`: hidden still makes
    // the row a scroll container that a stray `focus()` / `scrollIntoView` can
    // scroll and never scroll back (the epic toolbar rows once vanished under
    // the header this way). Clip has no scroll offset at all.
    const surfaceRow = screen.getByTestId("route-adapter-layer").parentElement;
    expect(surfaceRow).not.toBeNull();
    expect(
      surfaceRow?.contains(screen.getByTestId("landing-terminal-host")),
    ).toBe(true);
    expect(surfaceRow?.className).toContain("overflow-clip");
    expect(surfaceRow?.className).not.toContain("overflow-hidden");
  });

  it("makes the capped tab strip leftover a desktop drag region", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    const tabRegion = screen.getByTestId("tab-strip").parentElement;
    expect(tabRegion).not.toBeNull();
    expect(tabRegion?.className).toContain("[-webkit-app-region:drag]");
  });

  it("registers the status-bar placement toggle on desktop", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    let fired = false;
    act(() => {
      fired = dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    expect(fired).toBe(true);
    // Off the default footer, which is where an untouched store starts.
    expect(useLayoutStore.getState().statusBar.placement).toBe("header");
  });

  it("does not register the status-bar placement toggle in the installed mobile app", async () => {
    setMobileApp(true);

    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    // The bridge mounts but registers nothing there (it reads the action's
    // `desktopOnly` flag), so the action has no handler and the placement it
    // would flip stays where it was - a mobile build cannot move usage
    // controls into a footer it never draws.
    let fired = true;
    act(() => {
      fired = dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    expect(fired).toBe(false);
    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
  });

  // Under the HEADER placement, since that is the only placement where this
  // preference has a button to hide - the strip has its own switch.
  it("hides the global resource monitor button when the preference is off", async () => {
    selectHeaderPlacement();
    useSettingsStore.setState({ showGlobalResourceMonitor: false });

    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.queryByTestId("resource-monitor-header-button")).toBeNull();
  });

  it("draws the usage controls in the strip at the default placement", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    // Exactly one surface is live at a time — the whole point of a single
    // `placement` rather than a footer toggle beside the header's controls.
    expect(screen.queryByTestId("rate-limit-header-button")).toBeNull();
    expect(screen.queryByTestId("resource-monitor-header-button")).toBeNull();
  });

  it("moves the usage controls to the header under the header placement", async () => {
    selectHeaderPlacement();

    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.queryByTestId("app-status-bar")).toBeNull();
    expect(screen.getByTestId("rate-limit-header-button")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-header-button")).not.toBeNull();
  });

  it("mounts the strip after the content viewport and before the shell's tail", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    const statusBar = screen.getByTestId("app-status-bar");
    const main = screen.getByTestId("route-adapter-layer").closest("main");
    if (main === null) throw new Error("the shell rendered no <main>");
    // After `</main>`, so the strip spans the full window rather than sitting
    // inside the content column.
    expect(
      main.compareDocumentPosition(statusBar) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And NOT appended last: `historySwipeTransition` has to stay the final
    // child so a frozen screen covers everything it was copied from. The probe
    // span sits after the dialog/bridge tail, so a strip that precedes it
    // cannot have been pushed to the end.
    const probe = screen.getByTestId("active-host-probe");
    expect(
      statusBar.compareDocumentPosition(probe) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("ignores the status-bar placement on a mobile viewport", async () => {
    // Not an `isMobileApp` gate: a narrow DESKTOP window behaves the same, and
    // the mobile header keeps its own controls — so `placement` is not the
    // question there at all. `mobileFooter` is, and it is off. Set explicitly
    // rather than left to the default: the placement being ignored here is the
    // one an untouched install is on, which is the whole point.
    selectFooterPlacement();
    setViewportWidth(MOBILE_VIEWPORT_WIDTH);

    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.queryByTestId("app-status-bar")).toBeNull();
    expect(screen.getByTestId("rate-limit-header-button")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-header-button")).not.toBeNull();
  });

  // The opt-in footer. Every case here is about the ONE question `AppShell`
  // asks on a narrow viewport - is there a strip - so they all assert the
  // mount and never the strip's contents, which the strip's own suite owns.
  describe("mobile footer", () => {
    /**
     * The switch on, with `placement` NAMED rather than inherited. Most of
     * these cases exist to show that the two answers are independent, and a
     * fixture resting on whichever placement happens to be the default cannot
     * show that - it also silently changes meaning the day the default moves.
     */
    function selectMobileFooter(placement: UsageControlsPlacement): void {
      useLayoutStore.setState({
        statusBar: {
          ...DEFAULT_STATUS_BAR_LAYOUT,
          mobileFooter: true,
          placement,
        },
      });
    }

    it("draws the strip on a mobile viewport once the switch is on", async () => {
      selectMobileFooter("status-bar");
      setViewportWidth(MOBILE_VIEWPORT_WIDTH);

      queryClient = renderAppShell();

      await screen.findByTestId("app-shell-child");

      expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    });

    it("draws it under the header placement, which withholds the strip everywhere else", async () => {
      // `placement` names which of two surfaces hosts the gauge, and this
      // viewport has only one of them: the mobile header keeps its controls
      // either way, so a strip gated on `placement` here would be off for
      // every phone whose device-local store happens to say `header`.
      selectMobileFooter("header");
      setViewportWidth(MOBILE_VIEWPORT_WIDTH);
      expect(useLayoutStore.getState().statusBar.placement).toBe("header");

      queryClient = renderAppShell();

      await screen.findByTestId("app-shell-child");

      expect(screen.getByTestId("app-status-bar")).not.toBeNull();
      // And the header keeps both of its own controls beside it - the strip
      // does not displace them the way it does under desktop `placement`.
      expect(screen.getByTestId("rate-limit-header-button")).not.toBeNull();
      expect(
        screen.getByTestId("resource-monitor-header-button"),
      ).not.toBeNull();
    });

    it("unmounts the strip while the software keyboard is up", async () => {
      selectMobileFooter("status-bar");
      setViewportWidth(MOBILE_VIEWPORT_WIDTH);

      queryClient = renderAppShell();
      await screen.findByTestId("app-shell-child");
      expect(screen.getByTestId("app-status-bar")).not.toBeNull();

      act(() => {
        setNativeKeyboardState({ open: true, transitioning: false });
      });

      expect(screen.queryByTestId("app-status-bar")).toBeNull();

      // And back when it goes down: a React gate, so the strip returns rather
      // than a hidden one being revealed.
      act(() => {
        setNativeKeyboardState({ open: false, transitioning: false });
      });

      expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    });

    it("unmounts the strip while the nav drawer is open", async () => {
      selectMobileFooter("status-bar");
      setViewportWidth(MOBILE_VIEWPORT_WIDTH);

      queryClient = renderAppShell();
      await screen.findByTestId("app-shell-child");
      expect(screen.getByTestId("app-status-bar")).not.toBeNull();

      act(() => {
        useMobileNavStore.getState().setOpen(true);
      });

      expect(screen.queryByTestId("app-status-bar")).toBeNull();

      act(() => {
        useMobileNavStore.getState().setOpen(false);
      });

      expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    });

    it("leaves the desktop shell alone, whatever the switch says", async () => {
      // The switch is about a viewport the desktop is not in. Placement stays
      // the only thing that moves the strip there, and it is `header` here -
      // so the switch being ON is not enough to draw one.
      selectMobileFooter("header");

      queryClient = renderAppShell();
      await screen.findByTestId("app-shell-child");

      expect(screen.queryByTestId("app-status-bar")).toBeNull();

      act(() => {
        useLayoutStore.setState({
          statusBar: {
            ...DEFAULT_STATUS_BAR_LAYOUT,
            mobileFooter: true,
            placement: "status-bar",
          },
        });
      });

      expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    });
  });

  // `TopLevelTabHost` mounts the whole time - `AppShell` renders it directly,
  // not through the routed `children` this suite otherwise stubs out - so the
  // Home surface's mount/visibility contract can be exercised through a real
  // signed-in shell render exactly like every other assertion in this file.
  describe("Home tab surface", () => {
    function homeSurface(): HTMLElement {
      return screen.getByTestId("top-level-surface-home-home");
    }

    it("mounts the Home surface when the flag is on and Home holds the selection", async () => {
      useSettingsStore.setState({ homeTabEnabled: true });

      queryClient = renderAppShell();
      await screen.findByTestId("app-shell-child");

      expect(homeSurface()).not.toBeNull();
    });

    it("shows the Home surface as visible when Home is the active tab", async () => {
      useSettingsStore.setState({ homeTabEnabled: true });
      // `activeItemId: null` is the tabs store's own default (no tabs open
      // yet), which is exactly what "Home is active" means while the flag is
      // on - see `layoutHomeIsActive` in `stores/tabs/store.ts`. Set it
      // explicitly so the test does not depend on that default staying
      // unchanged.
      useTabsStore.setState((state) => ({ ...state, activeItemId: null }));

      queryClient = renderAppShell();
      await screen.findByTestId("app-shell-child");

      const surface = await screen.findByTestId("home-focus-view");
      expect(surface).not.toBeNull();
      expect(homeSurface().dataset.visible).toBe("true");
      expect(homeSurface().getAttribute("aria-hidden")).toBe("false");
    });

    it("keeps the Home surface mounted but hidden once it has been opened and a real other tab takes over", async () => {
      useSettingsStore.setState({ homeTabEnabled: true });
      // A real, non-Home strip tab - seeded the way `top-level-tab-host.test.tsx`
      // seeds a History tab (its own surface stubbed above, since this
      // provider-light shell has no router for the real one to run under).
      // Home holds the selection first, because the surface latches its mount
      // on that first activation: this is a window that HAS opened Home.
      useTabsStore.setState((state) => ({
        ...state,
        items: [
          {
            kind: "tab",
            id: "tab:history:history",
            ref: { kind: "history", id: "history" },
          },
        ],
        activeItemId: null,
        stripOrder: [{ kind: "history", id: "history" }],
        systemTabs: {
          history: {
            id: "history",
            kind: "history",
            name: "History",
            lastPath: null,
          },
          settings: null,
        },
      }));

      queryClient = renderAppShell();
      await screen.findByTestId("app-shell-child");
      expect(homeSurface()).not.toBeNull();

      act(() => {
        useTabsStore.setState((state) => ({
          ...state,
          activeItemId: "tab:history:history",
        }));
      });

      // The other tab is the one actually visible...
      const historySurface = await screen.findByTestId(
        "top-level-surface-history-history",
      );
      expect(historySurface.dataset.visible).toBe("true");

      // ...but Home stays in the DOM rather than unmounting - the whole point
      // of hosting it outside the MRU cap - it is just hidden.
      expect(homeSurface()).not.toBeNull();
      expect(homeSurface().dataset.visible).toBe("false");
      expect(homeSurface().getAttribute("aria-hidden")).toBe("true");
    });

    it("does not mount the Home surface when the flag is off", async () => {
      useSettingsStore.setState({ homeTabEnabled: false });

      queryClient = renderAppShell();
      await screen.findByTestId("app-shell-child");

      expect(screen.queryByTestId("top-level-surface-home-home")).toBeNull();
    });
  });
});
