import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import type { AuthStatus } from "@/stores/auth/auth-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { getCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
import { Route as EpicTabRoute } from "@/routes/epics.$epicId.$tabId";

const recordViewed = vi.hoisted(() => vi.fn());

vi.mock("@/components/layout/app-shell", () => ({
  AppShell: (props: { readonly children: ReactNode }) => (
    <div data-testid="app-shell">{props.children}</div>
  ),
}));

// The standalone sign-in / onboarding surfaces render the Windows menu strip
// in a title-bar band, and the strip routes its popup through a TanStack
// mutation. This routing test wraps RootComponent in only a router queryClient
// (no QueryClientProvider), so stub the module like AppShell above.
vi.mock("@/components/layout/header/windows-menu-bar", () => ({
  WindowsMenuBar: () => null,
}));

vi.mock("@/components/layout/dialogs/desktop-dialog-host", () => ({
  DesktopDialogHost: () => null,
}));

vi.mock("@/components/layout/bridges/menu-command-listener", () => ({
  MenuCommandListener: () => null,
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

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
}));

vi.mock("@/hooks/epic/use-epic-record-viewed-mutation", () => ({
  useEpicRecordViewed: () => ({ mutate: recordViewed }),
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
  // Note: epic-route-session-body stays at root, not moved
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

const EPIC_ID = "epic-route-loop";
const TAB_ID = "tab-route-existing";
const STALE_TAB_ID = "tab-route-stale";

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

function seedOpenEpicTab(): void {
  const canvas: EpicCanvasState = createEmptyCanvas();
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: {
        tabId: TAB_ID,
        epicId: EPIC_ID,
        name: "Loop Test Epic",
      },
    },
    canvasByTabId: { [TAB_ID]: canvas },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
    mostRecentTabIdByEpicId: { [EPIC_ID]: TAB_ID },
    artifactTreeByEpicId: { [EPIC_ID]: [] },
  });
}

function renderAt(pathname: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [pathname] }),
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("/epics/$epicId/$tabId route", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    recordViewed.mockReset();
    seedSignedInAuth();
    // Past the one-time tour, so RootComponent's global onboarding gate is inert.
    useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useOnboardingStore.setState({ completedAt: null });
  });

  it("adapts an existing tab route without creating another tab body", async () => {
    seedOpenEpicTab();

    const router = renderAt(`/epics/${EPIC_ID}/${TAB_ID}`);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/epics/${EPIC_ID}/${TAB_ID}`,
      );
    });
    expect(screen.queryByTestId("epic-route-session-body")).toBeNull();
    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual([TAB_ID]);
    expect(Object.keys(state.tabsById)).toEqual([TAB_ID]);
    expect(recordViewed).toHaveBeenCalledWith({ epicId: EPIC_ID });
  });

  it("repairs a stale tab route to a sibling tab without carrying nested focus params", async () => {
    seedOpenEpicTab();

    const router = renderAt(
      `/epics/${EPIC_ID}/${STALE_TAB_ID}?focusPaneId=pane-stale&focusTileInstanceId=tile-stale&focusArtifactId=artifact-1&focusThreadId=thread-1&focusedAt=123&migrationSource=phase`,
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/epics/${EPIC_ID}/${TAB_ID}`,
      );
    });
    expect(router.state.location.search).toEqual({
      focusedAt: 123,
      focusArtifactId: "artifact-1",
      focusThreadId: "thread-1",
    });
  });

  it("shows the onboarding tour (not the epic) for an un-onboarded user on a deep route", async () => {
    // The tour renders over whatever route resolved, with no navigation, so a
    // user who boots into a deep route (e.g. a restored epic) still sees it.
    seedOpenEpicTab();
    useOnboardingStore.setState({ completedAt: null });

    const router = renderAt(`/epics/${EPIC_ID}/${TAB_ID}`);

    await screen.findByTestId("onboarding-page-stub");
    expect(screen.queryByTestId("epic-route-session-body")).toBeNull();
    expect(router.state.location.pathname).toBe(`/epics/${EPIC_ID}/${TAB_ID}`);
  });

  it("renders replay onboarding outside the app shell without clearing completion", async () => {
    const router = renderAt("/onboarding?replay=true");

    await screen.findByTestId("onboarding-page-stub");
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(useOnboardingStore.getState().completedAt).toBe(1_700_000_000_000);
  });
});

/**
 * T3: the `/epics/$epicId/$tabId` loader's History first-page prefetch moved
 * from `auth.status !== "signed-in"` to `!admitsLocalPlane(auth.status)`, on
 * the same reading as the `/epics` loader (`epics-route.test.tsx`) - this
 * warms the History overlay so it opens populated from inside an epic tab,
 * and `beforeLoad`'s `requireSignedIn` already admits `unverified` here.
 *
 * Invoked directly against `Route.options.loader`, same idiom as
 * `epics-route.test.tsx`'s loader block and `draft-entry-routes.test.ts`'s
 * `beforeLoad` invocation.
 */
describe("/epics/$epicId/$tabId loader prefetch admission", () => {
  afterEach(() => {
    resetNegotiatedManifests();
  });

  interface FakeHostClient {
    getActiveHostId(): string | null;
    getRequestContextUserId(): string | null;
  }

  interface FakeLoaderContext {
    getHostClient: () => FakeHostClient | null;
    getAuthSnapshot: () => {
      readonly status: AuthStatus;
      readonly contextMetadata: { readonly userId: string } | null;
    };
    queryClient: { prefetchQuery: (options: unknown) => Promise<void> };
  }

  function invokeEpicTabLoader(args: {
    readonly authStatus: AuthStatus;
    readonly contextMetadataUserId: string | null;
    readonly hostId: string;
    readonly requestContextUserId: string | null;
  }): { readonly prefetchCalls: number } {
    const prefetchQuery = vi.fn(() => Promise.resolve());
    const loader = EpicTabRoute.options.loader as (loaderArgs: {
      context: FakeLoaderContext;
    }) => unknown;
    loader({
      context: {
        getHostClient: () => ({
          getActiveHostId: () => args.hostId,
          getRequestContextUserId: () => args.requestContextUserId,
        }),
        getAuthSnapshot: () => ({
          status: args.authStatus,
          contextMetadata:
            args.contextMetadataUserId === null
              ? null
              : { userId: args.contextMetadataUserId },
        }),
        queryClient: { prefetchQuery },
      },
    });
    return { prefetchCalls: prefetchQuery.mock.calls.length };
  }

  it("prefetches the History first page for an unverified session with a matching request-context user", () => {
    const hostId = "host-epic-tab-unverified";
    recordNegotiatedHostManifest(hostId, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    const result = invokeEpicTabLoader({
      authStatus: "unverified",
      contextMetadataUserId: "user-1",
      hostId,
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(1);
    expect(getCloudEpicTasksClient(hostId)).not.toBeNull();
  });

  it("does not prefetch for an unverified session on a host below epic.listTasks@1.6", () => {
    // Same gate as `/epics`: a pre-1.6 host would run the cloud-backed list
    // on the retained credential.
    const hostId = "host-epic-tab-unverified-legacy";
    recordNegotiatedHostManifest(hostId, {
      "epic.listTasks": { major: 1, minor: 5 },
    });
    const result = invokeEpicTabLoader({
      authStatus: "unverified",
      contextMetadataUserId: "user-1",
      hostId,
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(0);
  });

  it("still prefetches for a signed-in session on a host below epic.listTasks@1.6", () => {
    const hostId = "host-epic-tab-signed-in-legacy";
    recordNegotiatedHostManifest(hostId, {
      "epic.listTasks": { major: 1, minor: 5 },
    });
    const result = invokeEpicTabLoader({
      authStatus: "signed-in",
      contextMetadataUserId: "user-1",
      hostId,
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(1);
  });

  it("does not prefetch for a signed-out session", () => {
    const result = invokeEpicTabLoader({
      authStatus: "signed-out",
      contextMetadataUserId: "user-1",
      hostId: "host-epic-tab-signed-out",
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(0);
  });

  it("does not prefetch when the auth snapshot has no context user id", () => {
    const result = invokeEpicTabLoader({
      authStatus: "unverified",
      contextMetadataUserId: null,
      hostId: "host-epic-tab-null-user",
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(0);
  });

  it("does not prefetch when the client's request-context user does not match", () => {
    const result = invokeEpicTabLoader({
      authStatus: "unverified",
      contextMetadataUserId: "user-1",
      hostId: "host-epic-tab-mismatch",
      requestContextUserId: "user-2",
    });
    expect(result.prefetchCalls).toBe(0);
  });
});
