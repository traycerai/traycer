// Pins how `SettingsLayout` treats the desktop menu's "Settings…" marker: when
// NOT admitted AND the marker is present on the current location AND the tab
// controller has never hydrated in this window, it renders
// `<Navigate to="/when-you-quit" replace/>` instead of falling through to the
// sign-in page. Every other combination keeps the sign-in page (or nothing,
// when admitted).
//
// Harness mirrors `routes/__tests__/when-you-quit-route.test.tsx` (same
// boundary: keep the router and its root route real, stub everything that
// would otherwise need its own provider tree) - not imported from, so the two
// files stay independent.
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

// Not under test here (unlike in the sibling file, which drives menu
// commands): stubbing it avoids needing a fake `runnerHost.menu`.
vi.mock("@/components/layout/bridges/menu-command-listener", () => ({
  MenuCommandListener: () => null,
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
// page needs - the mechanism under test is which route body mounts, not what
// the sign-in page renders.
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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { routeTree } from "@/routeTree.gen";
import { setMobileApp } from "@/lib/mobile-app";
import { STARTUP_NAVIGATION_INTENT_KEY } from "@/lib/host/startup-navigation-intent";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useTabsStore } from "@/stores/tabs/store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../__tests__/create-fake-runner-host";
import {
  __resetTabNavigationControllerForTesting,
  __resetTabNavigationHydrationForTesting,
} from "@/lib/tab-navigation";

/**
 * Both boot-escape markers, exactly as the desktop menu's "Settings…" item
 * writes them. The menu-specific key is a literal here on purpose: this test
 * pins the wire key itself, not an exported constant.
 */
function bothMarkers(): Record<string, unknown> {
  return {
    [STARTUP_NAVIGATION_INTENT_KEY]: true,
    __traycerStartupMenuSettingsIntent: true,
  };
}

/** What the boot card's OWN "Open settings" button writes - no menu key. */
function startupMarkerOnly(): Record<string, unknown> {
  return { [STARTUP_NAVIGATION_INTENT_KEY]: true };
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

function makeRunnerHost(): IRunnerHost {
  return createFakeRunnerHost({ hostLifecycle: buildLifecycleHost() });
}

/**
 * Mounts the real route tree at `pathname`, with `state` on that FIRST
 * history entry - set on a bare, unsubscribed history before the router (and
 * so before `TabNavigationRouteBridge` or anything else) exists, so nothing
 * observes it as a commit. `createMemoryHistory`'s own `initialEntries` takes
 * plain path strings only; this is how a route-level test seeds state on the
 * entry the app boots into.
 */
function mountApp(input: {
  readonly pathname: string;
  readonly state: Record<string, unknown>;
  readonly runnerHost: IRunnerHost;
}): Router<typeof routeTree> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const history = createMemoryHistory({ initialEntries: [input.pathname] });
  history.replace(input.pathname, input.state);
  const router = createRouter({
    routeTree,
    history,
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

beforeEach(() => {
  window.localStorage.clear();
  setMobileApp(false);
  __resetTabNavigationControllerForTesting();
  __resetTabNavigationHydrationForTesting();
  useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setMobileApp(false);
  useAuthStore.getState().setSignedOut();
  useOnboardingStore.setState({ completedAt: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  __resetTabNavigationControllerForTesting();
  __resetTabNavigationHydrationForTesting();
});

describe("SettingsLayout - the desktop menu's Settings… marker", () => {
  it("signed out, never hydrated, both markers land on /when-you-quit with the card", async () => {
    const router = mountApp({
      pathname: "/settings/host",
      state: bothMarkers(),
      runnerHost: makeRunnerHost(),
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/when-you-quit");
    });
    const wrapper = screen.getByTestId("signed-out-quit-settings");
    expect(
      wrapper.querySelector('[data-testid="host-lifecycle-card"]'),
    ).not.toBeNull();
    expect(screen.queryByTestId("auth-landing-page-stub")).toBeNull();
  });

  it("only the boot card's own startup marker keeps sign-in in place, with no card", async () => {
    const router = mountApp({
      pathname: "/settings/host",
      state: startupMarkerOnly(),
      runnerHost: makeRunnerHost(),
    });

    await screen.findByTestId("auth-landing-page-stub");
    expect(router.state.location.pathname).toBe("/settings/host");
    expect(screen.queryByTestId("signed-out-quit-settings")).toBeNull();
    expect(screen.queryByTestId("host-lifecycle-card")).toBeNull();
  });

  it("a stale marker after this window's hydration - a later sign-out still shows sign-in, not the card", async () => {
    seedSignedInAuth();
    const router = mountApp({
      pathname: "/settings/host",
      state: bothMarkers(),
      runnerHost: makeRunnerHost(),
    });
    // Admitted: `SettingsLayout` renders nothing (settings lives in the tab
    // host, not the router, while signed in). `TabNavigationRouteBridge` is
    // real here (not mocked) and mounts because admission is true; nothing in
    // this harness wraps a `WindowsBridgeProvider`, so `useWindowsBridgeHydrated()`
    // resolves via `WindowsBridgeContext`'s own default (`hasHydrated: true`)
    // and the bridge's hydration-gated effect fires from its own mount - no
    // manual `setHydrationReady` needed. Wait on that effect's observable
    // result: it resolves `/settings/host` into the settings tab, which is
    // what spends the hydration latch this case depends on.
    await screen.findByTestId("app-shell");
    await waitFor(() => {
      expect(useTabsStore.getState().systemTabs.settings).not.toBeNull();
    });

    // The marker rides in history state and outlives this - the same entry,
    // now signed out. The latch (spent at THIS admission, above) is what must
    // keep it from being read again as fresh intent.
    useAuthStore.getState().setSignedOut();

    await screen.findByTestId("auth-landing-page-stub");
    expect(router.state.location.pathname).toBe("/settings/host");
    expect(screen.queryByTestId("signed-out-quit-settings")).toBeNull();
    expect(screen.queryByTestId("host-lifecycle-card")).toBeNull();
  });
});
