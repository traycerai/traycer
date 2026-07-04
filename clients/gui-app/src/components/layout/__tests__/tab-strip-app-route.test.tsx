import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useTabsStore } from "@/stores/tabs/store";

// Reconciliation install is owned by `WindowsBridgeProvider` in
// production. Test mounts skip the provider, so install once here.
installTabSyncCoordinator({ readyPromise: Promise.resolve() });

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

vi.mock("@/components/layout/bridges/tray-open-epic-bridge", () => ({
  TrayOpenEpicBridge: () => null,
}));

vi.mock("@/components/layout/host-status-footer", () => ({
  HostStatusFooter: () => null,
}));

vi.mock("@/components/migration/migration-run-controller", () => ({
  MigrationRunController: () => null,
}));

vi.mock("@/components/open-folder-dialog", () => ({
  OpenFolderDialog: () => null,
}));

vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => null,
}));

vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));

vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
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

vi.mock("@/components/settings/panels/general-settings-panel", () => ({
  GeneralSettingsPanel: () => <div data-testid="settings-general-route" />,
}));

vi.mock("@/components/epics/epics-route", () => ({
  EpicsRoute: () => <div data-testid="epics-history-route" />,
}));

vi.mock("@/components/layout/root-landing-page", () => ({
  RootLandingPage: () => <div data-testid="landing-route" />,
}));

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-1",
      userName: "User One",
      email: "user@example.com",
    },
    { userId: "user-1", username: "User One" },
    [],
  );
  // Past the one-time tour, so RootComponent's onboarding render gate is inert.
  useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
}

function renderAppAt(initialPath: string) {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: {
      queryClient,
      getAuthSnapshot: () => useAuthStore.getState(),
      getActiveHostId: () => null,
      getHostClient: () => null,
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function flushNav(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("app route tab-strip navigation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetStores();
  });

  it("switches from an epic tab to open settings, history, and draft tabs", async () => {
    const epicTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-current", "Current Epic");
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: "/settings/general",
    });
    useTabsStore.getState().openSystemTab({
      kind: "history",
      name: "History",
      lastPath: "/epics",
    });
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const router = renderAppAt(`/epics/epic-current/${epicTabId}`);
    await screen.findByTestId("epic-route-session-body");

    fireEvent.click(screen.getByTestId("tab-settings-settings"));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });

    await router.navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-current", tabId: epicTabId },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
    });
    await flushNav();
    fireEvent.click(screen.getByTestId("tab-history-history"));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/epics");
    });

    await router.navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-current", tabId: epicTabId },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
    });
    await flushNav();
    fireEvent.click(screen.getByTestId(`tab-draft-${draftId}`));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/draft/${draftId}`);
    });
  });
});
