import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { EpicAccessCoordinator } from "@/providers/epic-access-coordinator";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import { DELETED_EPIC_NOTIFICATION_STORAGE_KEY } from "@/lib/epics/deleted-epic-events";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState, EpicViewTab } from "@/stores/epics/canvas/types";

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

const NOOP_CANVAS: EpicCanvasState = createEmptyCanvas();
const TEST_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const fakeFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => {},
  awareness: () => {},
  applyArtifactRoomUpdate: () => {},
  artifactRoomAwareness: () => {},
  retryMigration: () => {},
  close: () => {},
});

function registerSession(epicId: string): OpenEpicStoreHandle {
  const handle = createOpenEpicStore({
    epicId,
    streamClientFactory: fakeFactory,
    userId: null,
    onAuthError: null,
  });
  __getOpenEpicRegistryForTests().acquire(epicId, () => handle);
  return handle;
}

function seedTabs(
  tabs: ReadonlyArray<{ tabId: string; epicId: string; name: string }>,
  activeTabId: string,
): void {
  const tabsById: Record<string, EpicViewTab> = {};
  const canvasByTabId: Record<string, EpicCanvasState> = {};
  const mostRecent: Record<string, string> = {};
  const trees: Record<string, []> = {};
  for (const tab of tabs) {
    tabsById[tab.tabId] = {
      tabId: tab.tabId,
      epicId: tab.epicId,
      name: tab.name,
    };
    canvasByTabId[tab.tabId] = NOOP_CANVAS;
    mostRecent[tab.epicId] = tab.tabId;
    trees[tab.epicId] = [];
  }
  useEpicCanvasStore.setState({
    tabsById,
    canvasByTabId,
    openTabOrder: tabs.map((tab) => tab.tabId),
    activeTabId,
    mostRecentTabIdByEpicId: mostRecent,
    artifactTreeByEpicId: trees,
  });
}

function renderCoordinatorAt(pathname: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <EpicAccessCoordinator />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="landing" />,
  });
  const epicListRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics",
    component: () => <div data-testid="epic-list" />,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => <div data-testid="epic" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicListRoute, epicRoute]),
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

describe("EpicAccessCoordinator", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useAuthStore.getState().setSignedOut();
    useComposerRunSettingsStore.getState().resetForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    toastInfo.mockClear();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useComposerRunSettingsStore.getState().resetForTests();
  });

  it("force-closes the active tab and redirects to landing when the epic is deleted", async () => {
    const handle = registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", TEST_SETTINGS, 1);

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    handle.store.setState({
      epicDeleted: {
        deletedByDisplayName: "Alice",
        deletedByTraycerUserId: "user-alice",
      },
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    expect(
      useComposerRunSettingsStore.getState().getEpicRunSettings("epic-1"),
    ).toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith(
      'Epic "Epic One" was deleted by Alice',
      { id: "epic-access:epic-1", cancel: null },
    );
  });

  it("force-closes the active tab and redirects to landing on a full revoke", async () => {
    const handle = registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", TEST_SETTINGS, 1);

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    handle.store.setState({ accessLost: true });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    expect(
      useComposerRunSettingsStore.getState().getEpicRunSettings("epic-1"),
    ).toEqual(TEST_SETTINGS);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("no longer have access"),
      { id: "epic-access:epic-1", cancel: null },
    );
  });

  it("silently closes a deleted background tab without leaving the active epic", async () => {
    const background = registerSession("epic-bg");
    registerSession("epic-active");
    seedTabs(
      [
        { tabId: "tab-active", epicId: "epic-active", name: "Active" },
        { tabId: "tab-bg", epicId: "epic-bg", name: "Background" },
      ],
      "tab-active",
    );

    const { router } = renderCoordinatorAt("/epics/epic-active/tab-active");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/epics/epic-active/tab-active",
      ),
    );

    background.store.setState({
      epicDeleted: { deletedByDisplayName: null, deletedByTraycerUserId: null },
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
        "tab-active",
      ]),
    );
    // The background close must NOT navigate the user away from what they are
    // viewing.
    expect(router.state.location.pathname).toBe(
      "/epics/epic-active/tab-active",
    );
    expect(toastInfo).toHaveBeenCalledWith('Epic "Background" was deleted', {
      id: "epic-access:epic-bg",
      cancel: null,
    });
  });

  it("closes an active tab with a neutral toast when the room is unavailable on open", async () => {
    const handle = registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", TEST_SETTINGS, 1);

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    // A revoke or delete discovered on (re)open surfaces indistinguishably as
    // an unreadable room; the toast must not claim either cause.
    handle.store.setState({
      snapshotFetchError: {
        code: "UNAUTHORIZED",
        message: "null roomInfo",
        upgradeGuidance: null,
      },
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    expect(
      useComposerRunSettingsStore.getState().getEpicRunSettings("epic-1"),
    ).toEqual(TEST_SETTINGS);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("no longer available"),
      { id: "epic-access:epic-1", cancel: null },
    );
  });

  it("does nothing on a downgrade to viewer (downgrade != close)", async () => {
    const handle = registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    handle.store.setState({ permissionRole: "viewer" });
    // Give any erroneous microtask-deferred close a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-1"]);
    expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1");
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("closes and prunes history when another window broadcasts a same-user delete", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "Test User",
        email: "test@example.com",
        avatarUrl: null,
      },
      { userId: "user-1", username: "test-user" },
      [],
    );
    registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", TEST_SETTINGS, 1);

    const { queryClient, router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    const queryKey = cloudEpicTasksQueryKey(
      "host-other",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(queryKey, {
      tasks: [
        taskLight("epic-1", "Epic One", "traycer/gui-app"),
        taskLight("epic-2", "Epic Two", "traycer/server"),
      ],
      hasMore: false,
      facets: {
        repos: [
          {
            repoIdentifier: { owner: "traycer", repo: "gui-app" },
            count: 1,
          },
          { repoIdentifier: { owner: "traycer", repo: "server" }, count: 1 },
        ],
        workspaces: [],
        ownershipScopes: [{ value: "mine", count: 2 }],
      },
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    dispatchDeletedEpicStorageEvent("user-1", ["epic-1"], {
      "epic-1": "Broadcast Title",
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(
      useComposerRunSettingsStore.getState().getEpicRunSettings("epic-1"),
    ).toBeNull();
    const response = queryClient.getQueryData<ListTasksResponse>(queryKey);
    expect(response?.tasks.map((task) => task.epic?.light?.id)).toEqual([
      "epic-2",
    ]);
    expect(response?.facets?.repos).toEqual([
      { repoIdentifier: { owner: "traycer", repo: "server" }, count: 1 },
    ]);
    expect(response?.facets?.ownershipScopes).toEqual([
      { value: "mine", count: 1 },
    ]);
    expect(toastInfo).toHaveBeenCalledWith(
      'Epic "Broadcast Title" was deleted',
      { id: "epic-access:epic-1", cancel: null },
    );
  });
});

function dispatchDeletedEpicStorageEvent(
  userId: string,
  epicIds: ReadonlyArray<string>,
  epicTitlesById: Readonly<Record<string, string>>,
): void {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
      newValue: JSON.stringify({
        type: "epic-deleted",
        version: 1,
        originId: "other-window",
        sequence: 1,
        createdAt: Date.now(),
        hostId: "host-source",
        userId,
        epicIds,
        epicTitlesById,
      }),
    }),
  );
}

function taskLight(id: string, title: string, repo: string): TaskLight {
  const [owner, repoName] = repo.split("/");
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
        updatedAt: Date.parse("2026-04-22T11:00:00.000Z"),
        createdBy: "user-1",
        version: "1.0.0",
      },
      permission: null,
      repos: [
        {
          task: { taskId: id, taskType: "epic" },
          repoIdentifier: {
            owner,
            repo: repoName,
          },
          createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
          createdBy: "user-1",
        },
      ],
      workspaces: [],
      roomInfo: null,
    },
  };
}
