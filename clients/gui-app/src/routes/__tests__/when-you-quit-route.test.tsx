// The "When you quit Traycer" card (`HostLifecycleSettingsSection`) is
// reachable SIGNED OUT on desktop through a top-level route `/when-you-quit`.
// While the shell is not admitted, `app.openSettings` navigates there; once
// the session becomes admitted, the route hands off to the SAME tab-controller
// Settings intent the admitted command uses. This file pins that behavior.
//
// Sibling-bridge stubs mirror `routes/__tests__/epics-tab-route.test.tsx`
// (same boundary: keep the router and its root route real, stub everything
// that would otherwise need its own provider tree) - EXCEPT
// `MenuCommandListener` stays REAL here, since it is the thing under test.
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: (props: { readonly children: ReactNode }) => (
    <div data-testid="app-shell">{props.children}</div>
  ),
}));

vi.mock("@/hooks/organization/organization-provider", () => ({
  OrganizationProvider: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("@/components/layout/header/desktop-menu-bar", () => ({
  DesktopMenuBar: () => null,
}));

vi.mock("@/components/layout/dialogs/desktop-dialog-host", () => ({
  DesktopDialogHost: () => null,
}));

vi.mock("@/components/layout/host-ready-gate", () => ({
  HostReadyGate: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/layout/bridges/host-tray-command-listener", () => ({
  HostTrayCommandListener: () => null,
}));

vi.mock("@/components/layout/bridges/notification-focus-bridge", () => ({
  NotificationFocusBridge: () => null,
}));
vi.mock("@/components/layout/bridges/notification-emission-controller", () => ({
  NotificationEmissionController: () => null,
}));

vi.mock("@/components/layout/dialogs/system-tab-modal-host", () => ({
  SystemTabModalHost: () => null,
}));

vi.mock("@/components/layout/bridges/tray-open-epic-bridge", () => ({
  TrayOpenEpicBridge: () => null,
}));

vi.mock("@/components/layout/bridges/host-lifecycle-analytics-bridge", () => ({
  HostLifecycleAnalyticsBridge: () => null,
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
}));

vi.mock("@/hooks/epic/use-epic-record-viewed-mutation", () => ({
  useEpicRecordViewed: () => ({ mutate: () => undefined }),
}));

vi.mock("@/hooks/migration/use-phase-migrate-to-epic-mutation", () => ({
  usePhaseMigrateToEpic: () => ({
    data: undefined,
    error: null,
    isError: false,
    isPending: true,
    mutate: () => undefined,
  }),
}));

vi.mock("@/components/onboarding/onboarding-page", () => ({
  OnboardingPage: () => <div data-testid="onboarding-page-stub" />,
}));

vi.mock("@/providers/epic-session-provider", () => ({
  EpicSessionProvider: (props: {
    readonly children: ReactNode;
    readonly epicId: string;
  }) => (
    <div data-epic-id={props.epicId} data-testid="epic-session-provider">
      {props.children}
    </div>
  ),
}));

vi.mock("@/components/epic-canvas/epic-route-session-body", () => ({
  EpicRouteSessionBody: (props: {
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
      data-testid="epic-route-session-body"
    />
  ),
}));

// The real `AuthLandingPage` already carries `data-testid="auth-landing-page"`
// itself, but stubbing keeps this suite from also standing up whatever THAT
// page needs (auth actions, marketing copy) - the mechanism under test is
// which route body mounts, not what the sign-in page renders.
vi.mock("@/components/auth/auth-landing-page", () => ({
  AuthLandingPage: () => <div data-testid="auth-landing-page-stub" />,
}));

const authServiceMock = vi.hoisted(() => ({
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useAuthService: () => authServiceMock };
});

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
  type Router,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { SystemTab } from "@/stores/tabs/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../__tests__/create-fake-runner-host";
import {
  __resetTabNavigationControllerForTesting,
  __resetTabNavigationHydrationForTesting,
  tabNavigationController,
} from "@/lib/tab-navigation";

interface FakeDesktopMenu {
  handler: ((payload: DesktopMenuCommandPayload) => void) | null;
  onCommand(handler: (payload: DesktopMenuCommandPayload) => void): {
    dispose(): void;
  };
  emit(command: DesktopMenuCommandPayload["command"]): void;
}

function createMenu(): FakeDesktopMenu {
  return {
    handler: null,
    onCommand(handler) {
      this.handler = handler;
      return {
        dispose: () => {
          this.handler = null;
        },
      };
    },
    emit(command) {
      this.handler?.({ command, windowId: "window-1" });
    },
  };
}

function lifecycleView(): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: "enforcing",
      admittedAs: null,
    },
    pending: "none",
  };
}

function buildLifecycleHost(): IHostLifecycleHost {
  const view = lifecycleView();
  return {
    get: () => Promise.resolve(view),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view,
      } satisfies HostLifecycleSetResult),
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
}

function makeRunnerHost(options: {
  readonly menu: FakeDesktopMenu;
  readonly hostLifecycle: IHostLifecycleHost | null;
}): IRunnerHost {
  return Object.assign(
    createFakeRunnerHost({ hostLifecycle: options.hostLifecycle }),
    { menu: options.menu },
  );
}

function mountApp(input: {
  readonly pathname: string;
  readonly runnerHost: IRunnerHost;
}): Router<typeof routeTree> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [input.pathname] }),
    context: {
      queryClient,
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  render(
    <RunnerHostProvider runnerHost={input.runnerHost}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
  return router;
}

function seedSignedInAuth(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-1",
      userName: "User One",
      email: "user@example.com",
    },
    { userId: "user-1", username: "User One" },
    [],
  );
}

interface SettingsHandoffSnapshot {
  readonly pathname: string;
  readonly settingsTab: SystemTab | null;
  readonly activeItemId: string | null;
}

function settingsHandoffSnapshot(pathname: string): SettingsHandoffSnapshot {
  const state = useTabsStore.getState();
  return {
    pathname,
    settingsTab: state.systemTabs.settings,
    activeItemId: state.activeItemId,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetTabNavigationControllerForTesting();
  __resetTabNavigationHydrationForTesting();
  useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().setSignedOut();
  useOnboardingStore.setState({ completedAt: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
});

describe("Settings ▸ General ▸ When you quit Traycer - reachable signed out", () => {
  it("signed out, direct navigation to /when-you-quit renders the card and nothing else", async () => {
    const runnerHost = makeRunnerHost({
      menu: createMenu(),
      hostLifecycle: buildLifecycleHost(),
    });
    const router = mountApp({ pathname: "/when-you-quit", runnerHost });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/when-you-quit");
    });
    const wrapper = screen.getByTestId("signed-out-quit-settings");
    expect(
      wrapper.querySelector('[data-testid="host-lifecycle-card"]'),
    ).not.toBeNull();
    // No sign-in page, no AppShell, no other General group (settings nav
    // never even mounts here - this is not `/settings/general`).
    expect(screen.queryByTestId("auth-landing-page-stub")).toBeNull();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.queryByTestId("settings-danger-zone")).toBeNull();
    // No settings section-nav or "General"/"Host" nav links at all - the
    // whole standalone shell has zero <a>/role="link" elements, so there is
    // no "Back to sign in" escape hatch either.
    const standaloneShell = document.querySelector(
      '[data-full-bleed-surface=""]',
    );
    expect(standaloneShell).not.toBeNull();
    expect(
      within(standaloneShell as HTMLElement).queryAllByRole("link"),
    ).toHaveLength(0);
  });

  it("signed out, an unavailable card (no hostLifecycle bridge) ends on / with sign-in", async () => {
    // With no lifecycle bridge the card is unavailable, so the route sends
    // the user to `/` with the sign-in page.
    const runnerHost = makeRunnerHost({
      menu: createMenu(),
      hostLifecycle: null,
    });
    const router = mountApp({ pathname: "/when-you-quit", runnerHost });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    await screen.findByTestId("auth-landing-page-stub");
  });

  it("on a cold launch, signed out, hydration never set, app.openSettings never calls activateTabIntent and lands on /when-you-quit", async () => {
    const activateSpy = vi.spyOn(tabNavigationController, "activate");
    const menu = createMenu();
    const runnerHost = makeRunnerHost({
      menu,
      hostLifecycle: buildLifecycleHost(),
    });
    const router = mountApp({ pathname: "/", runnerHost });
    await screen.findByTestId("auth-landing-page-stub");

    menu.emit("app.openSettings");

    // Not admitted, so the command must never reach the tab-controller
    // choke point at all. Checked synchronously right after `emit`, since
    // queueing an activation happens inline.
    expect(activateSpy).toHaveBeenCalledTimes(0);
    // Landing: the command navigates to `/when-you-quit` with the card
    // visible. Navigation is async, so this has to be awaited.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/when-you-quit");
    });
    expect(screen.queryByTestId("host-lifecycle-card")).not.toBeNull();
  });

  it("after an in-session sign-out, app.openSettings never calls activateTabIntent and lands on /when-you-quit", async () => {
    seedSignedInAuth();
    const menu = createMenu();
    const runnerHost = makeRunnerHost({
      menu,
      hostLifecycle: buildLifecycleHost(),
    });
    // Mounted at a stable admitted route with no `beforeLoad` of its own
    // (`/settings/appearance`), not `/`: the index route's own redirect for
    // an empty window (`/` -> `/draft/new` -> a fresh `/draft/$id`) is
    // unrelated to this command and, worse, mutates the landing-draft store
    // in a way that leaks into later tests in this file (an "open" draft
    // stays open past `cleanup()`, silently skipping that redirect for
    // whichever test runs next and making outcomes order-dependent).
    const router = mountApp({ pathname: "/settings/appearance", runnerHost });
    // No manual `setHydrationReady`: this harness has no
    // `WindowsBridgeProvider`, so `useWindowsBridgeHydrated()` reads the
    // context default `hasHydrated: true`
    // (providers/windows-bridge-context.ts:16-19), and the REAL, unmocked
    // `TabNavigationRouteBridge` hydrates itself once admitted
    // (tab-navigation-route-bridge.tsx:167). Wait for that real hydration -
    // the settings system tab existing is proof the bridge resolved the
    // current location - before doing anything that depends on it.
    await waitFor(() => {
      expect(useTabsStore.getState().systemTabs.settings).not.toBeNull();
    });

    const activateSpy = vi.spyOn(tabNavigationController, "activate");
    useAuthStore.getState().setSignedOut();
    menu.emit("app.openSettings");

    expect(activateSpy).toHaveBeenCalledTimes(0);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/when-you-quit");
    });
    expect(screen.queryByTestId("host-lifecycle-card")).not.toBeNull();
    expect(screen.queryByTestId("auth-landing-page-stub")).toBeNull();
  });

  it("signed in and hydrated, emitting app.openSettings reaches /settings/general and never visits /when-you-quit", async () => {
    seedSignedInAuth();
    const menu = createMenu();
    const runnerHost = makeRunnerHost({
      menu,
      hostLifecycle: buildLifecycleHost(),
    });
    const router = mountApp({ pathname: "/settings/appearance", runnerHost });
    // As in the sign-out-then-Settings case above: no manual hydration, wait for the real
    // `TabNavigationRouteBridge` to have resolved this location itself.
    await waitFor(() => {
      expect(useTabsStore.getState().systemTabs.settings).not.toBeNull();
    });

    const visited: string[] = [];
    router.subscribe("onResolved", () => {
      visited.push(router.state.location.pathname);
    });

    menu.emit("app.openSettings");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });
    expect(visited).not.toContain("/when-you-quit");
  });

  it("admission during /when-you-quit hands off through the SAME settings tab intent the admitted command uses", async () => {
    // Run 1: build the expected value from the real admitted command -
    // never a literal, so this can't drift from what the command actually
    // produces.
    seedSignedInAuth();
    const menuRun1 = createMenu();
    const runnerHostRun1 = makeRunnerHost({
      menu: menuRun1,
      hostLifecycle: buildLifecycleHost(),
    });
    const routerRun1 = mountApp({
      pathname: "/settings/appearance",
      runnerHost: runnerHostRun1,
    });
    // No manual hydration, as in the signed-in Settings case above: wait for the real
    // `TabNavigationRouteBridge` to have resolved this location itself.
    await waitFor(() => {
      expect(useTabsStore.getState().systemTabs.settings).not.toBeNull();
    });

    menuRun1.emit("app.openSettings");
    await waitFor(() => {
      expect(routerRun1.state.location.pathname).toBe("/settings/general");
    });
    const expected = settingsHandoffSnapshot(
      routerRun1.state.location.pathname,
    );

    cleanup();
    useAuthStore.getState().setSignedOut();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    __resetTabNavigationControllerForTesting();
    __resetTabNavigationHydrationForTesting();

    // Run 2: start signed out on /when-you-quit, then admit the session.
    const menuRun2 = createMenu();
    const runnerHostRun2 = makeRunnerHost({
      menu: menuRun2,
      hostLifecycle: buildLifecycleHost(),
    });
    // Cold, signed-out mount on `/when-you-quit` - no manual hydration call.
    // Admitting the session below is what must mount the real
    // `TabNavigationRouteBridge` and drive the hand-off; hydrating manually
    // here, before admission, would model a state a cold launch can never
    // reach.
    const routerRun2 = mountApp({
      pathname: "/when-you-quit",
      runnerHost: runnerHostRun2,
    });
    seedSignedInAuth();

    // `/when-you-quit` isn't a tab-controller-routed target
    // (`routedTabTarget` returns null for it), so the controller must leave
    // it alone once admitted; a generic landing correction (the empty-strip
    // fallback, ending on a freshly minted `/draft/$id`) would bypass the
    // settings intent and never reach `/settings/general`.
    await waitFor(() => {
      expect(routerRun2.state.location.pathname).toBe("/settings/general");
    });
    const actual = settingsHandoffSnapshot(routerRun2.state.location.pathname);

    expect(actual).toEqual(expected);
  });

  it("the admitted hand-off replaces /when-you-quit, leaving no back-trap", async () => {
    // Same setup as the sign-in hand-off case's second run: signed-out cold
    // mount on /when-you-quit, then admit with no manual hydration and no
    // explicit emit.
    const menu = createMenu();
    const runnerHost = makeRunnerHost({
      menu,
      hostLifecycle: buildLifecycleHost(),
    });
    const router = mountApp({ pathname: "/when-you-quit", runnerHost });
    seedSignedInAuth();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });
    // The memory history starts with the single entry /when-you-quit
    // (index 0). A REPLACE keeps that as the only entry (still index 0, so
    // `canGoBack()` reads false); a PUSH would land on index 1, and Back
    // would return to /when-you-quit, which hands off again and traps the
    // user.
    expect(router.history.canGoBack()).toBe(false);
  });

  it("admission drives exactly one navigation to /settings/general, with no landing-correction race and no stray draft", async () => {
    // Same setup as the sign-in hand-off case's second run: signed-out cold
    // mount on /when-you-quit, then admit with no manual hydration and no
    // explicit emit.
    const menu = createMenu();
    const runnerHost = makeRunnerHost({
      menu,
      hostLifecycle: buildLifecycleHost(),
    });
    const router = mountApp({ pathname: "/when-you-quit", runnerHost });

    const committed: string[] = [];
    router.history.subscribe(() => {
      committed.push(router.history.location.pathname);
    });

    seedSignedInAuth();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });
    // The route's hand-off must be the ONLY navigation admission drives: a
    // controller landing correction would commit extra legs (`/` and then a
    // freshly minted `/draft/$id`) into this list.
    expect(committed).toEqual(["/settings/general"]);
    // And nothing should have been created along the way: the landing
    // correction's fallback mints a fresh draft tab, which the strip records
    // as a `{kind: "tab", ref: {kind: "draft", ...}}` item.
    const hasDraftTab = useTabsStore
      .getState()
      .items.some((item) => item.kind === "tab" && item.ref.kind === "draft");
    expect(hasDraftTab).toBe(false);
  });
});
