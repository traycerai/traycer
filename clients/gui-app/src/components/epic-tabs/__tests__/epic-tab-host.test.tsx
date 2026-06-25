import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import {
  EpicTabHost,
  MAX_RETAINED_EPIC_TAB_PANES,
} from "@/components/epic-tabs/epic-tab-host";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";

// Keep the app shell + cross-cutting bridges out of the way; we only care
// about the keep-alive pane host under the `/epics` layout.
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
// The epic-list body has its own data deps we don't exercise here; stub it so
// navigating to `/epics` only verifies the host's keep-alive behavior.
vi.mock("@/components/epics/epics-route", () => ({
  EpicsRoute: () => <div data-testid="epics-list" />,
}));
vi.mock("@/components/epic-canvas/epic-shell", () => ({
  EpicShell: (props: {
    readonly active: boolean;
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-active={props.active ? "true" : "false"}
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
      data-testid="epic-shell-skeleton"
    />
  ),
}));

// Lightweight session pane: the host wires one of these per mounted tab. No
// host/stream needed - we assert on mounting + the host's visibility data.
vi.mock("@/providers/epic-session-provider", () => ({
  EpicSessionProvider: (props: {
    readonly children: ReactNode;
    readonly epicId: string;
  }) => <div data-epic-id={props.epicId}>{props.children}</div>,
}));
vi.mock("@/components/epic-canvas/epic-route-session-body", async () => {
  const { SidebarKeybindingBridge } = await vi.importActual<
    typeof import("@/components/epic-canvas/sidebar/sidebar-keybinding-bridge")
  >("@/components/epic-canvas/sidebar/sidebar-keybinding-bridge");
  const { useMainPanelCollapsed } = await vi.importActual<
    typeof import("@/stores/epics/left-panel-store")
  >("@/stores/epics/left-panel-store");

  function SidebarStateProbe(props: { readonly tabId: string }) {
    const collapsed = useMainPanelCollapsed(props.tabId);
    return (
      <div
        data-collapsed={collapsed ? "true" : "false"}
        data-testid={`sidebar-state-${props.tabId}`}
      />
    );
  }

  return {
    EpicRouteSessionBody: (props: {
      readonly active: boolean;
      readonly epicId: string;
      readonly tabId: string;
    }) => (
      <>
        <SidebarKeybindingBridge tabId={props.tabId} />
        <SidebarStateProbe tabId={props.tabId} />
        <div
          data-active-prop={props.active ? "true" : "false"}
          data-epic-id={props.epicId}
          data-tab-id={props.tabId}
          data-testid="epic-route-session-body"
        />
      </>
    ),
  };
});

const KEYBINDING_ROUTER: KeybindingRouter = {
  getPathname: () => "/epics/epic-a/tab-a",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
};

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

function tab(tabId: string, epicId: string) {
  const canvas: EpicCanvasState = createEmptyCanvas();
  return { tabId, epicId, name: `Epic ${epicId}`, canvas, lastSeenAt: 1 };
}

function seedTabs(tabIds: ReadonlyArray<readonly [string, string]>): void {
  useEpicCanvasStore.setState({
    tabsById: Object.fromEntries(
      tabIds.map(([tabId, epicId]) => [tabId, tab(tabId, epicId)]),
    ),
    openTabOrder: tabIds.map(([tabId]) => tabId),
    activeTabId: tabIds[0]?.[0] ?? null,
    mostRecentTabIdByEpicId: Object.fromEntries(
      tabIds.map(([tabId, epicId]) => [epicId, tabId]),
    ),
    artifactTreeByEpicId: Object.fromEntries(
      tabIds.map(([, epicId]) => [epicId, []]),
    ),
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

function paneFor(tabId: string): HTMLElement | null {
  return screen.queryByTestId(`epic-pane-${tabId}`);
}

function sidebarStateFor(tabId: string): HTMLElement {
  return screen.getByTestId(`sidebar-state-${tabId}`);
}

function normalizedEpicSearch() {
  return {
    focusedAt: undefined,
    focusArtifactId: undefined,
    focusThreadId: undefined,
    migrationSource: undefined,
  };
}

describe("EpicTabHost keep-alive", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLeftPanelStore.setState({ mainCollapsedByTabId: {} });
    seedSignedInAuth();
    // Past the one-time tour, so RootComponent's onboarding render gate is inert.
    useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLeftPanelStore.setState({ mainCollapsedByTabId: {} });
    useOnboardingStore.setState({ completedAt: null, step: 0 });
  });

  it("keeps the previous tab mounted but hidden when switching tabs", async () => {
    seedTabs([
      ["tab-a", "epic-a"],
      ["tab-b", "epic-b"],
    ]);

    const router = renderAt("/epics/epic-a/tab-a");
    await waitFor(() => {
      expect(paneFor("tab-a")?.getAttribute("data-active")).toBe("true");
    });

    await act(async () => {
      await router.navigate({
        to: "/epics/$epicId/$tabId",
        params: { epicId: "epic-b", tabId: "tab-b" },
        search: {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: undefined,
        },
      });
    });

    await waitFor(() => {
      expect(paneFor("tab-b")?.getAttribute("data-active")).toBe("true");
    });
    // The previously-active pane survives the switch: still in the DOM, only
    // hidden. This is the whole point - no unmount/remount, no blank frame.
    const paneA = paneFor("tab-a");
    expect(paneA).not.toBeNull();
    expect(paneA?.getAttribute("data-active")).toBe("false");
    expect(paneA?.classList.contains("hidden")).toBe(true);

    // Back to A: still mounted, just re-shown.
    await act(async () => {
      await router.navigate({
        to: "/epics/$epicId/$tabId",
        params: { epicId: "epic-a", tabId: "tab-a" },
        search: {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: undefined,
        },
      });
    });
    await waitFor(() => {
      expect(paneFor("tab-a")?.getAttribute("data-active")).toBe("true");
    });
    expect(paneFor("tab-b")?.getAttribute("data-active")).toBe("false");
  });

  it("caps mounted panes at MAX_RETAINED_EPIC_TAB_PANES, evicting the least-recently-visited", async () => {
    const tabIds = Array.from(
      { length: MAX_RETAINED_EPIC_TAB_PANES + 1 },
      (_unused, i) => [`tab-${i}`, `epic-${i}`] as const,
    );
    seedTabs(tabIds);

    const router = renderAt(`/epics/${tabIds[0][1]}/${tabIds[0][0]}`);
    await waitFor(() => {
      expect(paneFor(tabIds[0][0])?.getAttribute("data-active")).toBe("true");
    });

    // Visit every tab in order so each enters the MRU set.
    for (const [tabId, epicId] of tabIds.slice(1)) {
      await act(async () => {
        await router.navigate({
          to: "/epics/$epicId/$tabId",
          params: { epicId, tabId },
          search: {
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            migrationSource: undefined,
          },
        });
      });
      await waitFor(() => {
        expect(paneFor(tabId)?.getAttribute("data-active")).toBe("true");
      });
    }

    // Exactly the cap is mounted, and the first-visited tab was evicted.
    expect(screen.getAllByTestId(/^epic-pane-/)).toHaveLength(
      MAX_RETAINED_EPIC_TAB_PANES,
    );
    expect(paneFor(tabIds[0][0])).toBeNull();
  });

  it("does not activate a pane when the route tab id belongs to a different epic", async () => {
    seedTabs([["tab-a", "epic-a"]]);

    renderAt("/epics/epic-b/tab-a");

    await waitFor(() => {
      expect(paneFor("tab-a")?.getAttribute("data-active")).toBe("false");
    });
    expect(paneFor("tab-a")?.getAttribute("data-epic-id")).toBe("epic-a");
  });

  it("shows no active pane on the epic list route but keeps visited panes mounted", async () => {
    seedTabs([["tab-a", "epic-a"]]);

    const router = renderAt("/epics/epic-a/tab-a");
    await waitFor(() => {
      expect(paneFor("tab-a")?.getAttribute("data-active")).toBe("true");
    });

    await act(async () => {
      await router.navigate({ to: "/epics", search: {} });
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/epics");
    });
    // Pane is kept alive across the list visit, just not active.
    const paneA = paneFor("tab-a");
    expect(paneA).not.toBeNull();
    expect(paneA?.getAttribute("data-active")).toBe("false");
  });

  it("does not mount the active pane during phase migration", () => {
    seedTabs([["tab-a", "epic-a"]]);

    render(
      <EpicTabHost
        activeRoute={{
          epicId: "epic-a",
          tabId: "tab-a",
          search: {
            ...normalizedEpicSearch(),
            migrationSource: "phase",
          },
        }}
      />,
    );

    expect(paneFor("tab-a")).toBeNull();
    expect(screen.queryByTestId("epic-route-session-body")).toBeNull();
  });

  it("routes the sidebar toggle shortcut to the visible retained pane", async () => {
    seedTabs([
      ["tab-a", "epic-a"],
      ["tab-b", "epic-b"],
    ]);

    const router = renderAt("/epics/epic-a/tab-a");
    await waitFor(() => {
      expect(paneFor("tab-a")?.getAttribute("data-active")).toBe("true");
    });
    expect(sidebarStateFor("tab-a").dataset.collapsed).toBe("false");

    await act(async () => {
      await router.navigate({
        to: "/epics/$epicId/$tabId",
        params: { epicId: "epic-b", tabId: "tab-b" },
        search: normalizedEpicSearch(),
      });
    });
    await waitFor(() => {
      expect(paneFor("tab-b")?.getAttribute("data-active")).toBe("true");
    });

    act(() => {
      expect(dispatchAction("app.sidebar.toggle", KEYBINDING_ROUTER)).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(sidebarStateFor("tab-b").dataset.collapsed).toBe("true");
    });
    expect(sidebarStateFor("tab-a").dataset.collapsed).toBe("false");

    await act(async () => {
      await router.navigate({
        to: "/epics/$epicId/$tabId",
        params: { epicId: "epic-a", tabId: "tab-a" },
        search: normalizedEpicSearch(),
      });
    });
    await waitFor(() => {
      expect(paneFor("tab-a")?.getAttribute("data-active")).toBe("true");
    });

    act(() => {
      expect(dispatchAction("app.sidebar.toggle", KEYBINDING_ROUTER)).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(sidebarStateFor("tab-a").dataset.collapsed).toBe("true");
    });
    expect(sidebarStateFor("tab-b").dataset.collapsed).toBe("true");
  });

  it("creates a new tab for the same stale route tab id under a different epic", async () => {
    const router = renderAt("/epics/epic-a/stale-tab");

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().resolveTabIdForEpic("epic-a"),
      ).not.toBeNull();
    });
    const firstCreatedTabId = useEpicCanvasStore
      .getState()
      .resolveTabIdForEpic("epic-a");
    if (firstCreatedTabId === null) {
      throw new Error("expected first created tab");
    }
    expect(router.state.location.pathname).toBe(
      `/epics/epic-a/${firstCreatedTabId}`,
    );

    await act(async () => {
      await router.navigate({
        to: "/epics/$epicId/$tabId",
        params: { epicId: "epic-b", tabId: "stale-tab" },
        search: normalizedEpicSearch(),
      });
    });

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().resolveTabIdForEpic("epic-b"),
      ).not.toBeNull();
    });
    const secondCreatedTabId = useEpicCanvasStore
      .getState()
      .resolveTabIdForEpic("epic-b");
    if (secondCreatedTabId === null) {
      throw new Error("expected second created tab");
    }
    expect(secondCreatedTabId).not.toBe(firstCreatedTabId);
    expect(
      useEpicCanvasStore.getState().tabsById[secondCreatedTabId]?.epicId,
    ).toBe("epic-b");
    expect(router.state.location.pathname).toBe(
      `/epics/epic-b/${secondCreatedTabId}`,
    );
  });

  it("restores the most recent tab when the same stale route is revisited after close", async () => {
    renderAt("/epics/epic-a/stale-tab");

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().resolveTabIdForEpic("epic-a"),
      ).not.toBeNull();
    });
    const firstCreatedTabId = useEpicCanvasStore
      .getState()
      .resolveTabIdForEpic("epic-a");
    if (firstCreatedTabId === null) {
      throw new Error("expected first created tab");
    }

    act(() => {
      useEpicCanvasStore.getState().closeTab(firstCreatedTabId);
    });
    expect(useEpicCanvasStore.getState().resolveTabIdForEpic("epic-a")).toBe(
      firstCreatedTabId,
    );
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);

    cleanup();
    const revisitedRouter = renderAt("/epics/epic-a/stale-tab");

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().resolveTabIdForEpic("epic-a"),
      ).not.toBeNull();
    });
    const secondCreatedTabId = useEpicCanvasStore
      .getState()
      .resolveTabIdForEpic("epic-a");
    expect(secondCreatedTabId).toBe(firstCreatedTabId);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      firstCreatedTabId,
    ]);
    expect(revisitedRouter.state.location.pathname).toBe(
      `/epics/epic-a/${firstCreatedTabId}`,
    );
  });
});
