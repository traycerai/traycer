import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
  GetTaskContextsResponse,
  ListTaskLight,
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { EpicAccessCoordinator } from "@/providers/epic-access-coordinator";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import { DELETED_EPIC_NOTIFICATION_STORAGE_KEY } from "@/lib/epics/deleted-epic-events";
import {
  deletedCloudEpicTasksPageEpicIdsForScope,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  clearSessionCreatedEpics,
  CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS,
  markEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState, EpicViewTab } from "@/stores/epics/canvas/types";
import { useTabsStore } from "@/stores/tabs/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { flattenLayoutRefs } from "@/stores/tabs/layout";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";

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
// Arbitrary fixed host: these tests exercise clearEpicRunSettings's ACROSS-
// HOST clearing, not host scoping itself, so any single consistent id works.
const TEST_HOST_ID = "host-1";

const fakeFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => {},
  awareness: () => {},
  applyArtifactRoomUpdate: () => {},
  artifactRoomAwareness: () => {},
  retryMigration: () => {},
  close: () => {},
});

function registerSession(epicId: string): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: epicId,
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped
    // constructing a runtime, so a `streamClientFactory` has nowhere
    // else to go.
    factories: {
      streamClientFactory: fakeFactory,
      laneSelection: null,
    },
    writeCommand: null,
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
  // `handleEpicAccessLoss` derives its affected refs from the coordinator's
  // OWN layout (`useTabsStore`), not from the canvas store - keep the two in
  // sync here exactly as `installSourceReconciliation` keeps them in sync in
  // the real app, or the access-loss command finds nothing to do.
  const refs: ReadonlyArray<TabRef> = tabs.map((tab) => ({
    kind: "epic",
    id: tab.tabId,
  }));
  useTabsStore.setState({
    version: 2,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: `tab:${ref.kind}:${ref.id}`,
      ref,
    })),
    activeItemId: `tab:epic:${activeTabId}`,
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
  });
}

/** Pairs two epic refs into one split item spanning the whole strip. */
function seedSplitOfEpics(
  left: TabRef,
  right: TabRef,
  focusedRef: TabRef,
): void {
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "split-shared",
        left: { kind: "tab", ref: left },
        right: { kind: "tab", ref: right },
        focusedSide: focusedRef.id === left.id ? "left" : "right",
        routeBackingSide: focusedRef.id === left.id ? "left" : "right",
        leftRatio: 0.5,
      },
    ],
    activeItemId: "split-shared",
    stripOrder: [left, right],
    systemTabs: { history: null, settings: null },
  });
}

/**
 * The key `useEpicChatRecords` reads an epic's chat records under: the host
 * method key plus the viewer and session-generation identity elements the hook
 * appends after it.
 */
function chatRecordsQueryKey(epicId: string) {
  return [
    ...hostQueryKeys.method<HostRpcRegistry, "epic.listChatRecords">(
      TEST_HOST_ID,
      "epic.listChatRecords",
      { epicId, hasDocReplica: false, knownRevision: null },
    ),
    "user-1",
    1,
  ] as const;
}

const FORBIDDEN_ERROR = {
  code: "FORBIDDEN" as const,
  message: "access to this epic was removed",
  upgradeGuidance: null,
};

async function failChatRecordsRead(
  queryClient: QueryClient,
  epicId: string,
): Promise<void> {
  await expect(
    queryClient.fetchQuery({
      queryKey: chatRecordsQueryKey(epicId),
      queryFn: () => Promise.reject(new Error("host unreachable")),
      retry: false,
    }),
  ).rejects.toThrow("host unreachable");
}

async function succeedChatRecordsRead(
  queryClient: QueryClient,
  epicId: string,
): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: chatRecordsQueryKey(epicId),
    queryFn: () => Promise.resolve([]),
    retry: false,
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
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useAuthStore.getState().setSignedOut();
    useComposerRunSettingsStore.getState().resetForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    clearSessionCreatedEpics();
    toastInfo.mockClear();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useComposerRunSettingsStore.getState().resetForTests();
    useSelectionAuthorityStore.getState().reset();
    clearSessionCreatedEpics();
    vi.restoreAllMocks();
  });

  it("force-closes the active tab and redirects to landing when the epic is deleted", async () => {
    const handle = registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", TEST_HOST_ID, TEST_SETTINGS, 1);

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
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings("epic-1", TEST_HOST_ID),
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
      .setEpicRunSettings("epic-1", TEST_HOST_ID, TEST_SETTINGS, 1);

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    handle.store.setState({ accessLost: true });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings("epic-1", TEST_HOST_ID),
    ).toEqual(TEST_SETTINGS);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("no longer have access"),
      { id: "epic-access:epic-1", cancel: null },
    );
  });

  it("marks a revoked task out of reach in the title lookups that named it", async () => {
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
    const handle = registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    const { queryClient } = renderCoordinatorAt("/epics/epic-1/tab-1");
    const lookupKey = hostQueryKeys.taskReferenceLookup(
      TEST_HOST_ID,
      "user-1",
      "epic-1",
    );
    queryClient.setQueryData<GetTaskContextsResponse>(lookupKey, {
      tasks: {
        "epic-1": { status: "found", task: listTaskLight("epic-1") },
      },
    });

    handle.store.setState({ accessLost: true });

    await waitFor(() =>
      expect(
        queryClient.getQueryData<GetTaskContextsResponse>(lookupKey)?.tasks[
          "epic-1"
        ],
      ).toEqual({ status: "unknown", reason: "denied" }),
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
      .setEpicRunSettings("epic-1", TEST_HOST_ID, TEST_SETTINGS, 1);

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    // A revoke or delete discovered on (re)open surfaces indistinguishably as
    // an unreadable room; the toast must not claim either cause.
    handle.store.setState({
      snapshotFetchError: {
        code: "NOT_FOUND",
        message: "room lookup is unavailable",
        upgradeGuidance: null,
      },
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings("epic-1", TEST_HOST_ID),
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
      .setEpicRunSettings("epic-1", TEST_HOST_ID, TEST_SETTINGS, 1);

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

    dispatchDeletedEpicStorageEvent(
      "user-1",
      ["epic-1"],
      { "epic-1": "Broadcast Title" },
      1,
    );

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings("epic-1", TEST_HOST_ID),
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

  it("scopes a broadcast's host-scoped deletion to the host that deleted it: caches, settings, announcement, teardown and navigation", async () => {
    // Codex thread 4303240636 on d74e2198 and the round-7 cold review: a
    // local-homed Task deleted on one host must stay open, announced as
    // nothing and with its settings, where this window holds it on another.
    useCloudEpicTasksPagesStore.setState({ deletedEpicIdsByScope: {} });
    // This window holds its epics on "test-host" (`openStoreForTest`'s).
    useSelectionAuthorityStore.setState({ effectiveHostId: "test-host" });
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
    registerSession("epic-local");
    seedTabs(
      [{ tabId: "tab-local", epicId: "epic-local", name: "Local Epic" }],
      "tab-local",
    );
    const settings = useComposerRunSettingsStore.getState();
    settings.setEpicRunSettings("epic-local", "test-host", TEST_SETTINGS, 1);
    settings.setEpicRunSettings("epic-local", "host-source", TEST_SETTINGS, 1);
    settings.setEpicRunSettings("epic-cloud", "test-host", TEST_SETTINGS, 1);
    const { router } = renderCoordinatorAt("/epics/epic-local/tab-local");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/epics/epic-local/tab-local",
      ),
    );

    dispatchScopedDeletedEpicStorageEvent({
      hostId: "host-source",
      epicIds: ["epic-local", "epic-cloud"],
      hostScopedEpicIds: ["epic-local"],
      sequence: 41,
    });

    await waitFor(() =>
      expect([
        ...deletedCloudEpicTasksPageEpicIdsForScope("host-source", "user-1"),
      ]).toEqual(expect.arrayContaining(["epic-local", "epic-cloud"])),
    );
    expect([
      ...deletedCloudEpicTasksPageEpicIdsForScope("host-sibling", "user-1"),
    ]).toEqual(["epic-cloud"]);
    // The account-wide one is gone everywhere; the host-scoped one only on
    // the host that deleted it.
    const after = useComposerRunSettingsStore.getState();
    expect(after.getEpicRunSettings("epic-cloud", "test-host")).toBeNull();
    expect(after.getEpicRunSettings("epic-local", "host-source")).toBeNull();
    expect(after.getEpicRunSettings("epic-local", "test-host")).toEqual(
      TEST_SETTINGS,
    );
    // This window's copy is on "test-host", which did not delete it.
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-local"]);
    expect(router.state.location.pathname).toBe("/epics/epic-local/tab-local");
    expect(toastInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("was deleted"),
      { id: "epic-access:epic-local", cancel: null },
    );

    // The same scoped deletion by the host this window holds it on is this
    // window's loss.
    dispatchScopedDeletedEpicStorageEvent({
      hostId: "test-host",
      epicIds: ["epic-local"],
      hostScopedEpicIds: ["epic-local"],
      sequence: 42,
    });
    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("was deleted"),
      { id: "epic-access:epic-local", cancel: null },
    );
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings("epic-local", "test-host"),
    ).toBeNull();
  });

  it("T10: routes a multi-epic delete notification through ONE coordinated handleEpicAccessLoss call, not a per-epic loop", async () => {
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
    registerSession("epic-left");
    registerSession("epic-right");
    seedTabs(
      [
        { tabId: "tab-left", epicId: "epic-left", name: "Left" },
        { tabId: "tab-right", epicId: "epic-right", name: "Right" },
      ],
      "tab-left",
    );
    const left: TabRef = { kind: "epic", id: "tab-left" };
    const right: TabRef = { kind: "epic", id: "tab-right" };
    seedSplitOfEpics(left, right, left);

    const { router } = renderCoordinatorAt("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));

    const handleEpicAccessLossSpy = vi.spyOn(
      tabCommandCoordinator,
      "handleEpicAccessLoss",
    );

    // Both epics behind the split are deleted together, in ONE notification -
    // exactly the shape a real batch delete produces. Plan §9 requires this
    // routed through ONE coordinated command, not one `handleEpicAccessLoss`
    // call per epic: firing a separate coordinator transaction (and a
    // separate persistence flush) per epic for what is semantically one
    // event is exactly the bypass this ticket closes.
    dispatchDeletedEpicStorageEvent(
      "user-1",
      ["epic-left", "epic-right"],
      { "epic-left": "Left", "epic-right": "Right" },
      2,
    );

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    // The whole split must be gone.
    expect(flattenLayoutRefs(useTabsStore.getState())).toEqual([]);
    expect(useTabsStore.getState().items).toEqual([]);
    // The real discriminator: ONE call carrying both ids, not two single-id
    // calls looped over the notification's array.
    expect(handleEpicAccessLossSpy).toHaveBeenCalledTimes(1);
    expect(handleEpicAccessLossSpy).toHaveBeenCalledWith(
      ["epic-left", "epic-right"],
      "user-1",
    );
  });

  it("removes a split whole when its sides fall in different deletion scopes of one batch", async () => {
    // This window holds its epics on "test-host" (`openStoreForTest`'s).
    useSelectionAuthorityStore.setState({ effectiveHostId: "test-host" });
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
    registerSession("epic-left");
    registerSession("epic-right");
    seedTabs(
      [
        { tabId: "tab-left", epicId: "epic-left", name: "Left" },
        { tabId: "tab-right", epicId: "epic-right", name: "Right" },
      ],
      "tab-left",
    );
    const left: TabRef = { kind: "epic", id: "tab-left" };
    const right: TabRef = { kind: "epic", id: "tab-right" };
    seedSplitOfEpics(left, right, left);

    const { router } = renderCoordinatorAt("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    const handleEpicAccessLossSpy = vi.spyOn(
      tabCommandCoordinator,
      "handleEpicAccessLoss",
    );

    // One batch, deleted on this window's host: the left Task from the
    // account, the right one on this host alone. Published as the deleting
    // window does, a version 2 for this window and a version 1 copy.
    dispatchScopedDeletedEpicStorageEvent({
      hostId: "test-host",
      epicIds: ["epic-left", "epic-right"],
      hostScopedEpicIds: ["epic-right"],
      sequence: 51,
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    // One transaction over both sides, so the split goes, not two
    // placeholders.
    expect(useTabsStore.getState().items).toEqual([]);
    expect(handleEpicAccessLossSpy).toHaveBeenCalledTimes(1);
    expect(handleEpicAccessLossSpy).toHaveBeenCalledWith(
      ["epic-left", "epic-right"],
      "user-1",
    );
  });

  it("starts the next test from the selection-authority store's initial state", () => {
    // The test above sets `effectiveHostId` and leaves it set; the suite's
    // `afterEach` resets it, so a later deletion notice is not scoped
    // against a window host leaked from an earlier test.
    expect(useSelectionAuthorityStore.getState()).toEqual(
      useSelectionAuthorityStore.getInitialState(),
    );
  });

  it("T10: clears composer run settings for every batch epicId, including one without a resident tab", async () => {
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
    registerSession("epic-open");
    seedTabs(
      [{ tabId: "tab-open", epicId: "epic-open", name: "Open" }],
      "tab-open",
    );
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-open", TEST_HOST_ID, TEST_SETTINGS, 1);
    // "epic-ghost" was deleted but never had a resident tab in this window -
    // it must not silently keep its stale run settings just because it
    // never reaches `announceEpicLoss`'s per-resident-epic loop.
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-ghost", TEST_HOST_ID, TEST_SETTINGS, 1);

    const { router } = renderCoordinatorAt("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));

    dispatchDeletedEpicStorageEvent(
      "user-1",
      ["epic-open", "epic-ghost"],
      { "epic-open": "Open", "epic-ghost": "Ghost" },
      3,
    );

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings("epic-open", TEST_HOST_ID),
    ).toBeNull();
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings("epic-ghost", TEST_HOST_ID),
    ).toBeNull();
  });

  it("holds a created-this-session epic open on 'unavailable' and retries via requestFreshSnapshot after the first grace delay", async () => {
    vi.useFakeTimers();
    try {
      markEpicCreatedThisSession("epic-1", "host-x");
      const handle = registerSession("epic-1");
      seedTabs(
        [{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }],
        "tab-1",
      );
      const requestFreshSnapshotSpy = vi.spyOn(handle, "requestFreshSnapshot");

      const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
      await act(async () => {
        await Promise.resolve();
      });
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1");

      act(() => {
        handle.store.setState({
          snapshotFetchError: {
            code: "NOT_FOUND",
            message: "room lookup is unavailable",
            upgradeGuidance: null,
          },
        });
      });
      // Flush the `evaluate` microtask the store subscription queues.
      await act(async () => {
        await Promise.resolve();
      });

      // Neither ejected nor toasted while the grace's first retry is pending.
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-1"]);
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1");
      expect(toastInfo).not.toHaveBeenCalled();
      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(requestFreshSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-1"]);
      expect(toastInfo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ejects a created-this-session epic once every grace retry is spent and 'unavailable' lands again", async () => {
    vi.useFakeTimers();
    try {
      markEpicCreatedThisSession("epic-1", "host-x");
      const handle = registerSession("epic-1");
      seedTabs(
        [{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }],
        "tab-1",
      );
      const requestFreshSnapshotSpy = vi.spyOn(handle, "requestFreshSnapshot");
      const unavailableError = {
        code: "NOT_FOUND" as const,
        message: "room lookup is unavailable",
        upgradeGuidance: null,
      };

      const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
      await act(async () => {
        await Promise.resolve();
      });

      // Driven by the PRODUCTION schedule rather than a copy of it: this test
      // asserts "every slot, then eject", and hardcoding the delays here made
      // that claim silently wrong the moment the schedule was resized.
      act(() => {
        handle.store.setState({ snapshotFetchError: unavailableError });
      });
      await act(async () => {
        await Promise.resolve();
      });

      let attempt = 0;
      for (const delay of CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
        attempt += 1;
        expect(requestFreshSnapshotSpy).toHaveBeenCalledTimes(attempt);
        // Still open: a spent slot is not a verdict.
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-1"]);
        expect(toastInfo).not.toHaveBeenCalled();
        // Simulate the retry itself failing the same way the real reconnect
        // would, so the next slot is taken by a genuine re-ARRIVAL. The
        // arrival is the point: the coordinator arms the next slot on the
        // error TRANSITIONING back in, not on its presence.
        //
        // Cleared explicitly first, and that is what the relocation changed.
        // `snapshotFetchError` is the WORKER's state now, projected to main,
        // and `requestFreshSnapshot` clears it by publishing a change-gated
        // patch. The worker never saw the direct `setState` below, so after the
        // first cycle its own value is already null and it emits nothing for
        // this field - main keeps the error the test wrote, the re-seed is a
        // no-op transition, and the loop stalls one slot short with the third
        // retry never fired. Only the first iteration worked, on a clear the
        // worker still had a reason to publish.
        //
        // Writing both halves here keeps the simulation at ONE layer instead of
        // depending on the worker to supply half of it.
        act(() => {
          handle.store.setState({ snapshotFetchError: null });
        });
        await act(async () => {
          await Promise.resolve();
        });
        act(() => {
          handle.store.setState({ snapshotFetchError: unavailableError });
        });
        await act(async () => {
          await Promise.resolve();
        });
      }

      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
      expect(router.state.location.pathname).toBe("/");
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("no longer available"),
        { id: "epic-access:epic-1", cancel: null },
      );
      // No retry beyond the schedule was scheduled - the eject ran instead.
      expect(requestFreshSnapshotSpy).toHaveBeenCalledTimes(
        CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS.length,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ejects a created-this-session epic immediately on a 'deleted' signal - the grace applies only to 'unavailable'", async () => {
    markEpicCreatedThisSession("epic-1", "host-x");
    const handle = registerSession("epic-1");
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    handle.store.setState({
      epicDeleted: { deletedByDisplayName: null, deletedByTraycerUserId: null },
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith('Epic "Epic One" was deleted', {
      id: "epic-access:epic-1",
      cancel: null,
    });
  });

  it("does not grace an epic created outside the create-race window", async () => {
    vi.useFakeTimers();
    try {
      markEpicCreatedThisSession("epic-1", "host-x");
      const handle = registerSession("epic-1");
      // Freshly built, so this cannot be mistaken for the dirty-replica guard
      // below - the eject here must be explained purely by the window having
      // elapsed.
      handle.store.setState({ isDirty: false, unsyncedQueueSize: 0 });
      seedTabs(
        [{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }],
        "tab-1",
      );
      const requestFreshSnapshotSpy = vi.spyOn(handle, "requestFreshSnapshot");

      const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
      await act(async () => {
        await Promise.resolve();
      });
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1");

      // Past the 2-minute create-race window - a NOT_FOUND now means what it
      // says, so this must NOT get the silent-retry grace the tests above
      // exercise for a genuinely fresh create.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1);
      });

      act(() => {
        handle.store.setState({
          snapshotFetchError: {
            code: "NOT_FOUND",
            message: "room lookup is unavailable",
            upgradeGuidance: null,
          },
        });
      });
      // Flush the `evaluate` microtask the store subscription queues.
      await act(async () => {
        await Promise.resolve();
      });

      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
      expect(router.state.location.pathname).toBe("/");
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("no longer available"),
        { id: "epic-access:epic-1", cancel: null },
      );
      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not grace a replica that holds unsynced work (isDirty)", async () => {
    markEpicCreatedThisSession("epic-1", "host-x");
    const handle = registerSession("epic-1");
    // Explicit, not incidental: a freshly built handle from `fakeFactory`
    // starts clean, so this is what actually exercises the guard rather than
    // some setup side effect.
    handle.store.setState({ isDirty: true, unsyncedQueueSize: 0 });
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    const requestFreshSnapshotSpy = vi.spyOn(handle, "requestFreshSnapshot");

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    handle.store.setState({
      snapshotFetchError: {
        code: "NOT_FOUND",
        message: "room lookup is unavailable",
        upgradeGuidance: null,
      },
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("no longer available"),
      { id: "epic-access:epic-1", cancel: null },
    );
    expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
  });

  it("does not grace a replica that holds unsynced work (unsyncedQueueSize)", async () => {
    markEpicCreatedThisSession("epic-1", "host-x");
    const handle = registerSession("epic-1");
    handle.store.setState({ isDirty: false, unsyncedQueueSize: 1 });
    seedTabs([{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }], "tab-1");
    const requestFreshSnapshotSpy = vi.spyOn(handle, "requestFreshSnapshot");

    const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
    );

    handle.store.setState({
      snapshotFetchError: {
        code: "NOT_FOUND",
        message: "room lookup is unavailable",
        upgradeGuidance: null,
      },
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("no longer available"),
      { id: "epic-access:epic-1", cancel: null },
    );
    expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
  });

  it("closes instead of rebuilding when local work appears while a grace retry is pending", async () => {
    vi.useFakeTimers();
    try {
      markEpicCreatedThisSession("epic-1", "host-x");
      const handle = registerSession("epic-1");
      handle.store.setState({ isDirty: false, unsyncedQueueSize: 0 });
      seedTabs(
        [{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }],
        "tab-1",
      );
      const requestFreshSnapshotSpy = vi.spyOn(handle, "requestFreshSnapshot");

      const { router } = renderCoordinatorAt("/epics/epic-1/tab-1");
      await act(async () => {
        await Promise.resolve();
      });
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1");

      // Schedules the first grace retry (clean handle, inside the window).
      act(() => {
        handle.store.setState({
          snapshotFetchError: {
            code: "NOT_FOUND",
            message: "room lookup is unavailable",
            upgradeGuidance: null,
          },
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-1"]);
      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();

      // Local work appears while that retry is still pending on its timer.
      act(() => {
        handle.store.setState({ isDirty: true });
      });

      // Advance past the first grace delay - the timer's re-check must see
      // the now-dirty state and hand the verdict to the ordinary close
      // instead of calling the destructive `requestFreshSnapshot`.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
      expect(router.state.location.pathname).toBe("/");
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining("no longer available"),
        { id: "epic-access:epic-1", cancel: null },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("FORBIDDEN recovery", () => {
    async function openForbiddenEpic(workState: {
      isDirty: boolean;
      unsyncedQueueSize: number;
    }) {
      const handle = registerSession("epic-1");
      handle.store.setState(workState);
      seedTabs(
        [{ tabId: "tab-1", epicId: "epic-1", name: "Epic One" }],
        "tab-1",
      );
      const requestFreshSnapshotSpy = vi.spyOn(handle, "requestFreshSnapshot");
      const { queryClient, router } = renderCoordinatorAt(
        "/epics/epic-1/tab-1",
      );
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1"),
      );
      act(() => {
        handle.store.setState({ snapshotFetchError: FORBIDDEN_ERROR });
      });
      // Flush the coordinator's store subscription.
      await act(async () => {
        await Promise.resolve();
      });
      return { queryClient, requestFreshSnapshotSpy };
    }

    it("re-opens the session once when the epic's chat-records read succeeds after failing", async () => {
      const { queryClient, requestFreshSnapshotSpy } = await openForbiddenEpic({
        isDirty: false,
        unsyncedQueueSize: 0,
      });

      await act(async () => {
        await failChatRecordsRead(queryClient, "epic-1");
      });
      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
      await act(async () => {
        await succeedChatRecordsRead(queryClient, "epic-1");
      });
      // Flush the microtask the coordinator defers the re-open to.
      await act(async () => {
        await Promise.resolve();
      });

      expect(requestFreshSnapshotSpy).toHaveBeenCalledTimes(1);

      // The watch disarmed on that first recovery: a later fail-then-succeed
      // cycle does not re-open again.
      await act(async () => {
        await failChatRecordsRead(queryClient, "epic-1");
        await succeedChatRecordsRead(queryClient, "epic-1");
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(requestFreshSnapshotSpy).toHaveBeenCalledTimes(1);
    });

    it("does not re-open when the read succeeds without having failed since the error landed", async () => {
      const { queryClient, requestFreshSnapshotSpy } = await openForbiddenEpic({
        isDirty: false,
        unsyncedQueueSize: 0,
      });

      await act(async () => {
        await succeedChatRecordsRead(queryClient, "epic-1");
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
    });

    it("does not re-open a replica that holds unsynced work", async () => {
      const { queryClient, requestFreshSnapshotSpy } = await openForbiddenEpic({
        isDirty: true,
        unsyncedQueueSize: 0,
      });

      await act(async () => {
        await failChatRecordsRead(queryClient, "epic-1");
        await succeedChatRecordsRead(queryClient, "epic-1");
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
    });

    it("does not re-open on another epic's chat-records recovery", async () => {
      const { queryClient, requestFreshSnapshotSpy } = await openForbiddenEpic({
        isDirty: false,
        unsyncedQueueSize: 0,
      });

      await act(async () => {
        await failChatRecordsRead(queryClient, "epic-2");
        await succeedChatRecordsRead(queryClient, "epic-2");
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(requestFreshSnapshotSpy).not.toHaveBeenCalled();
    });
  });
});

function dispatchDeletedEpicStorageEvent(
  userId: string,
  epicIds: ReadonlyArray<string>,
  epicTitlesById: Readonly<Record<string, string>>,
  sequence: number,
): void {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
      newValue: JSON.stringify({
        type: "epic-deleted",
        version: 1,
        originId: "other-window",
        sequence,
        createdAt: Date.now(),
        hostId: "host-source",
        userId,
        epicIds,
        epicTitlesById,
      }),
    }),
  );
}

function dispatchScopedDeletedEpicStorageEvent(notice: {
  readonly hostId: string;
  readonly epicIds: ReadonlyArray<string>;
  readonly hostScopedEpicIds: ReadonlyArray<string>;
  readonly sequence: number;
}): void {
  // As the deleting window publishes it: the whole batch as version 2, then
  // the account-wide ids as a version 1 tagged with the same batch, for
  // windows that predate version 2 (this window skips it).
  const hostScoped = new Set(notice.hostScopedEpicIds);
  const batchId = `other-window:batch:${String(notice.sequence)}`;
  const common = {
    type: "epic-deleted",
    originId: "other-window",
    createdAt: Date.now(),
    hostId: notice.hostId,
    userId: "user-1",
    batchId,
    epicTitlesById: {},
  };
  const accountWideIds = notice.epicIds.filter((id) => !hostScoped.has(id));
  const messages = [
    {
      ...common,
      version: 2,
      sequence: notice.sequence,
      epicIds: notice.epicIds,
      hostScopedEpicIds: [...hostScoped],
    },
    ...(accountWideIds.length > 0
      ? [
          {
            ...common,
            version: 1,
            sequence: notice.sequence + 1000,
            epicIds: accountWideIds,
          },
        ]
      : []),
  ];
  for (const message of messages) {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
        newValue: JSON.stringify(message),
      }),
    );
  }
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

function listTaskLight(epicId: string): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: "Epic One",
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "user-1",
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
  };
}
