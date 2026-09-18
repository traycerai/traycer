/**
 * Review S2 + acceptance gap - the sample workspace inside the REAL AppShell +
 * TopLevelTabHost + CustomizeOverlay, with the real sample surface and body.
 *
 * WHAT IS REAL vs STUBBED (report this exactly; do not claim full header
 * coverage):
 *   REAL:    AppShell (incl. its own `main`, banner and status-bar
 *            `data-customize-inert` markers), AppHeader (incl. its own three
 *            `data-customize-inert` wrappers), TopLevelTabHost + surface
 *            retention, SampleWorkspaceSurface + SampleWorkspaceBody,
 *            SampleSceneProvider, CustomizeOverlay (the real Done button and
 *            Esc handler), useCustomizeInert, all stores, enter/exit, the tab
 *            coordinator.
 *   STUBBED: exactly the leaves app-shell-lifecycle-bridges.test.tsx already
 *            stubs because this harness has no router: TabStrip,
 *            HistoryNavButtons, HistoryButton, SignInButton, DesktopMenuBar,
 *            NotificationsBell, RateLimitIconButton, ResourceMonitorPopover,
 *            UserMenu, AppStatusBar (so the status-bar WRAPPER is real, the
 *            strip inside it is a stub), OpenFolderDialog, QuitInterceptBridge,
 *            FindInPageBar, TileFindOwnerBridge, ReservedBrowserChordsBridge,
 *            MigrationRunController/Modal host, MobileNavDrawer,
 *            LandingTerminalHost, the History surface, and the mobile swipe
 *            hook. `@tanstack/react-router` keeps its real exports except
 *            `useNavigate` (the overlay bar navigates).
 *   NOT COVERED: actual layout/scrolling (jsdom has no layout) - the test
 *            proves the viewport is a non-inert descendant chain and keeps a
 *            scroll-driven minimap updates with simulated turn geometry,
 *            not that a native wheel/scrollbar drag works.
 *
 * Tree order mirrors root-route-components.tsx: the overlay is a SIBLING of
 * <SampleSceneProvider><AppShell/></SampleSceneProvider>.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

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
vi.mock("@/components/layout/header/desktop-menu-bar", () => ({
  DesktopMenuBar: () => null,
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
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import {
  enterCustomize,
  ensureSampleWorkspaceTab,
  exitCustomize,
} from "@/lib/customize/enter-exit";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";

const HISTORY_REF: TabRef = { kind: "history", id: "history" };
const HISTORY_ITEM_ID = tabItemId(HISTORY_REF);
const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };
const SAMPLE_ITEM_ID = tabItemId(SAMPLE_REF);
const SAMPLE_SURFACE = "top-level-surface-sample-workspace-sample-workspace";
const HISTORY_SURFACE = "top-level-surface-history-history";
const PERSISTENT_LINE = "Sample content. Changes apply to your layout.";

let queryClient: QueryClient | undefined;

function renderShell(): void {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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
              requestId: () => "app-shell-sample-request",
              handlers: {},
            })
          }
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback" />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              <SampleSceneProvider>
                <AppShell>
                  <div data-testid="app-shell-child" />
                </AppShell>
              </SampleSceneProvider>
              <CustomizeOverlay />
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

/** A retained History tab, and the sample tab selected on top of it. */
function seedSampleOverHistory(): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [{ kind: "tab", id: HISTORY_ITEM_ID, ref: HISTORY_REF }],
    activeItemId: HISTORY_ITEM_ID,
    stripOrder: [HISTORY_REF],
    systemTabs: {
      history: {
        id: "history",
        kind: "history",
        name: "History",
        lastPath: null,
      },
      settings: null,
    },
  });
  ensureSampleWorkspaceTab({ kind: "none" });
  useTabsStore.setState({ activeItemId: SAMPLE_ITEM_ID });
}

function mainElement(): HTMLElement {
  const main = document.querySelector("main");
  if (main === null) throw new Error("AppShell rendered no <main>");
  return main;
}

function sampleItemCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

async function shellWithSampleSession(): Promise<void> {
  seedSampleOverHistory();
  renderShell();
  await screen.findByTestId("app-shell-child");
  await screen.findByTestId(SAMPLE_SURFACE);
  await waitFor(() =>
    expect(useCustomizeStore.getState().session?.scene).toBe("sample"),
  );
}

beforeEach(() => {
  Object.defineProperty(window, "runnerHost", {
    configurable: true,
    writable: true,
    value: {},
  });
  localStorage.clear();
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
    visualLayoutEditorEnabled: true,
  });
  useCustomizeStore.setState({ session: null, instances: new Map() });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
});

afterEach(() => {
  if (useCustomizeStore.getState().session) exitCustomize("done");
  cleanup();
  queryClient?.clear();
  queryClient = undefined;
  Reflect.deleteProperty(window, "runnerHost");
  useAuthStore.getState().setSignedOut();
  localStorage.clear();
  useTabsStore.setState(useTabsStore.getInitialState(), true);
});

describe("Sample workspace inside the real AppShell + TopLevelTabHost", () => {
  it("renders the body exactly once, inside the tab host's sample surface", async () => {
    await shellWithSampleSession();

    expect(document.querySelectorAll("[data-sample-workspace]")).toHaveLength(
      1,
    );
    expect(
      document.querySelectorAll("[data-sample-workspace-body]"),
    ).toHaveLength(1);
    expect(screen.getAllByText(PERSISTENT_LINE)).toHaveLength(1);
    expect(
      screen
        .getByTestId(SAMPLE_SURFACE)
        .contains(document.querySelector("[data-sample-workspace]")),
    ).toBe(true);
    expect(screen.getByTestId(SAMPLE_SURFACE).dataset.visible).toBe("true");
    // The routed child is still the shell's, not a second sample.
    expect(screen.getAllByTestId("app-shell-child")).toHaveLength(1);
  });

  it("leaves <main> live, and makes the live header/status chrome inert", async () => {
    await shellWithSampleSession();

    // S2: main is NOT inert for the sample scene...
    expect(mainElement().hasAttribute("inert")).toBe(false);
    // ...but the real shell's other markers are.
    expect(
      screen.getByTestId("app-status-bar").closest("[inert]"),
    ).not.toBeNull();
    expect(screen.getByTestId("user-menu").closest("[inert]")).not.toBeNull();
    const markers = Array.from(
      document.querySelectorAll("[data-customize-inert]"),
    );
    const others = markers.filter((node) => node.tagName !== "MAIN");
    expect(others.length).toBeGreaterThanOrEqual(2);
    for (const node of others) expect(node.hasAttribute("inert")).toBe(true);
    // The tab strip is NOT under a marker: it must stay operable in the studio.
    expect(screen.getByTestId("tab-strip").closest("[inert]")).toBeNull();
  });

  it("keeps the transcript viewport out of every inert ancestor, and a real scroll moves the minimap's active tick", async () => {
    await shellWithSampleSession();

    const viewport = screen.getByLabelText("Sample conversation");
    expect(viewport.closest("[inert]")).toBeNull();
    expect(viewport.className).toContain("overflow-y-auto");
    expect(
      document.querySelector("[data-sample-turn]")?.closest("[inert]"),
    ).not.toBeNull();
    expect(
      screen.getByText("Describe the next change…").closest("[inert]"),
    ).not.toBeNull();

    // Model scroll geometry.
    let scrollTop = 0;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next;
      },
    });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);
    const turns = Array.from(
      document.querySelectorAll<HTMLElement>("[data-sample-turn]"),
    );
    expect(turns.length).toBeGreaterThan(5);
    turns.forEach((turn, index) => {
      turn.getBoundingClientRect = () =>
        new DOMRect(0, index * 100 - scrollTop, 800, 100);
    });

    const activeTurn = (): string | null =>
      screen
        .getAllByTestId("chat-turn-minimap-tick")
        .find((tick) => tick.getAttribute("data-active") === "true")
        ?.getAttribute("data-message-id") ?? null;

    // Re-measure at the model's starting position, then scroll for real.
    fireEvent.scroll(viewport);
    await waitFor(() => expect(activeTurn()).toBe("sample-turn-0"));

    scrollTop = 250;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(activeTurn()).toBe("sample-turn-2"));

    scrollTop = 520;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(activeTurn()).toBe("sample-turn-5"));

    // And back: the wiring is two-way, not a one-shot.
    scrollTop = 0;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(activeTurn()).toBe("sample-turn-0"));
  });

  it.each(["Done", "Escape"] as const)(
    "%s ends the session, closes the sample, returns to the previous selection and un-inerts the shell",
    async (how) => {
      await shellWithSampleSession();

      if (how === "Done") {
        fireEvent.click(await screen.findByRole("button", { name: "Done" }));
      } else {
        await screen.findByRole("button", { name: "Done" });
        fireEvent.keyDown(document.body, { key: "Escape" });
      }

      expect(useCustomizeStore.getState().session).toBeNull();
      await waitFor(() => expect(sampleItemCount()).toBe(0));
      expect(useTabsStore.getState().activeItemId).toBe(HISTORY_ITEM_ID);
      const history = await screen.findByTestId(HISTORY_SURFACE);
      expect(history.dataset.visible).toBe("true");
      expect(screen.queryByTestId(SAMPLE_SURFACE)?.dataset.visible).not.toBe(
        "true",
      );
      for (const node of document.querySelectorAll("[data-customize-inert]"))
        expect(node.hasAttribute("inert")).toBe(false);
    },
  );

  it("control: an ordinary in-place session still makes <main> inert", async () => {
    useTabsStore.setState({
      ...emptyTabStripLayout(),
      items: [{ kind: "tab", id: HISTORY_ITEM_ID, ref: HISTORY_REF }],
      activeItemId: HISTORY_ITEM_ID,
      stripOrder: [HISTORY_REF],
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: null,
        },
        settings: null,
      },
    });
    renderShell();
    await screen.findByTestId("app-shell-child");

    act(() => {
      expect(
        enterCustomize({
          scene: "in-place",
          opener: { kind: "none" },
          target: null,
        }),
      ).toBe(true);
    });

    await waitFor(() => expect(mainElement().hasAttribute("inert")).toBe(true));
    expect(
      screen.getByTestId("app-status-bar").closest("[inert]"),
    ).not.toBeNull();

    act(() => exitCustomize("done"));
    await waitFor(() =>
      expect(mainElement().hasAttribute("inert")).toBe(false),
    );
  });
});
