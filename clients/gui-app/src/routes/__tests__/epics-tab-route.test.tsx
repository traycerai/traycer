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
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";

vi.mock("@/components/layout/app-shell", () => ({
  AppShell: (props: { readonly children: ReactNode }) => (
    <div data-testid="app-shell">{props.children}</div>
  ),
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

vi.mock("@/stores/tabs/use-deep-link-tab-sync", () => ({
  useDeepLinkTabSync: () => undefined,
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
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
      getActiveHostId: () => null,
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

  it("renders an existing tab route without the parent creating another tab", async () => {
    seedOpenEpicTab();

    const router = renderAt(`/epics/${EPIC_ID}/${TAB_ID}`);

    await screen.findByTestId("epic-route-session-body");
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/epics/${EPIC_ID}/${TAB_ID}`,
      );
    });
    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual([TAB_ID]);
    expect(Object.keys(state.tabsById)).toEqual([TAB_ID]);
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
      migrationSource: "phase",
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
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
