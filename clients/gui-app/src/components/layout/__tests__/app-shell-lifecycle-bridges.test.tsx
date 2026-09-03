import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
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

vi.mock("@/components/epic-canvas/browser-overlay-coordinator-bridge", () => ({
  BrowserOverlayCoordinatorBridge: () => (
    <div data-testid="browser-overlay-coordinator" />
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

// Rendered unconditionally so the surface row's clipping contract can be
// asserted; the real host self-gates on a focused/visible draft surface.
vi.mock("@/components/home/terminal-panel/landing-terminal-host", () => ({
  LandingTerminalHost: () => <div data-testid="landing-terminal-host" />,
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
import { RunnerHostProvider } from "@/providers/runner-host-provider";

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
    useSettingsStore.setState({ showGlobalResourceMonitor: true });
  });

  afterEach(() => {
    cleanup();
    queryClient?.clear();
    queryClient = undefined;
    delete windowHost.runnerHost;
    setMobileApp(false);
    useAuthStore.getState().setSignedOut();
    useSettingsStore.setState({ showGlobalResourceMonitor: true });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
  });

  function selectStatusBarPlacement(): void {
    useLayoutStore.setState({
      statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "status-bar" },
    });
  }

  it("renders the signed-in app shell around routed children", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.getByTestId("user-menu")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-header-button")).not.toBeNull();
    expect(screen.getByTestId("app-shell-child")).not.toBeNull();
    expect(screen.getByTestId("tile-find-owner-bridge")).not.toBeNull();
    expect(screen.getByTestId("browser-overlay-coordinator")).not.toBeNull();
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
    const surfaceRow = screen.getByTestId("route-adapter-layer").parentElement;
    expect(surfaceRow).not.toBeNull();
    expect(
      surfaceRow?.contains(screen.getByTestId("landing-terminal-host")),
    ).toBe(true);
    expect(surfaceRow?.className).toContain("overflow-hidden");
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
    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
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
    expect(useLayoutStore.getState().statusBar.placement).toBe("header");
  });

  it("hides the global resource monitor button when the preference is off", async () => {
    useSettingsStore.setState({ showGlobalResourceMonitor: false });

    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.queryByTestId("resource-monitor-header-button")).toBeNull();
  });

  it("keeps the usage controls in the header at the default placement", async () => {
    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.queryByTestId("app-status-bar")).toBeNull();
    expect(screen.getByTestId("rate-limit-header-button")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-header-button")).not.toBeNull();
  });

  it("moves the usage controls to the strip under the status-bar placement", async () => {
    selectStatusBarPlacement();

    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    // Exactly one surface is live at a time — the whole point of a single
    // `placement` rather than a footer toggle beside the header's controls.
    expect(screen.queryByTestId("rate-limit-header-button")).toBeNull();
    expect(screen.queryByTestId("resource-monitor-header-button")).toBeNull();
  });

  it("mounts the strip after the content viewport and before the shell's tail", async () => {
    selectStatusBarPlacement();

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
    // the mobile header keeps its own controls — so respecting `placement`
    // here would leave that viewport with neither surface.
    selectStatusBarPlacement();
    setViewportWidth(MOBILE_VIEWPORT_WIDTH);

    queryClient = renderAppShell();

    await screen.findByTestId("app-shell-child");

    expect(screen.queryByTestId("app-status-bar")).toBeNull();
    expect(screen.getByTestId("rate-limit-header-button")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-header-button")).not.toBeNull();
  });
});
