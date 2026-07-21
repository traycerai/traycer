import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import {
  ensureHistoryTab,
  ensureSettingsTab,
} from "@/lib/commands/actions/open-system-tab";
import { AGENT_WORKING_AWARENESS_FIELD } from "@traycer/protocol/host/epic/subscribe";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import type { PermissionRole } from "@/lib/epic-collaborator-roles";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { EMPTY_PROJECTED_SLICES } from "@/stores/epics/open-epic/types";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import "../../../../__tests__/test-browser-apis";

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

interface TestSetPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

interface TestSetPinnedOptions {
  readonly onSuccess: () => void;
}

interface TestToastOptions {
  readonly action: {
    readonly label: string;
    readonly onClick: () => void;
  };
}

const pinTestState = vi.hoisted(
  (): {
    pinnedByEpicId: Map<string, boolean>;
    pendingEpicIds: Set<string>;
    mutate: Mock<
      (
        variables: TestSetPinnedVariables,
        options: TestSetPinnedOptions | undefined,
      ) => void
    >;
  } => ({
    pinnedByEpicId: new Map(),
    pendingEpicIds: new Set(),
    mutate: vi.fn(),
  }),
);

const toastTestState = vi.hoisted(
  (): {
    messages: string[];
    actionLabel: string | null;
    undo: (() => void) | null;
  } => ({
    messages: [],
    actionLabel: null,
    undo: null,
  }),
);

vi.mock("@/hooks/epic/use-epic-task-pinned-states-query", () => ({
  useEpicTaskPinnedStates: () => pinTestState.pinnedByEpicId,
}));

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", () => ({
  useEpicSetPinned: () => ({ mutate: pinTestState.mutate }),
  usePendingSetPinnedEpicIds: () => pinTestState.pendingEpicIds,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options: TestToastOptions) => {
      toastTestState.messages.push(message);
      toastTestState.actionLabel = options.action.label;
      toastTestState.undo = options.action.onClick;
    },
    error: vi.fn(),
  },
}));

interface EpicTab {
  readonly id: string;
  readonly name: string;
  readonly draft: boolean;
}

const EPIC_A: EpicTab = { id: "e-a", name: "Alpha", draft: false };
const EPIC_B: EpicTab = { id: "e-b", name: "Beta", draft: false };
const SPEC_A: EpicNodeRef = {
  id: "spec-a",
  instanceId: "spec-a-instance",
  type: "spec",
  name: "Spec A",
  hostId: "host-a",
};
const SPEC_B: EpicNodeRef = {
  id: "spec-b",
  instanceId: "spec-b-instance",
  type: "spec",
  name: "Spec B",
  hostId: "host-a",
};
const EPIC_C: EpicTab = { id: "e-c", name: "Gamma", draft: false };
let queryClient: QueryClient;

function epicFixture(index: number): EpicTab {
  return {
    id: `e-${index}`,
    name: `Epic ${index}`,
    draft: false,
  };
}

function openEpicFixture(tab: EpicTab): string {
  useEpicCanvasStore
    .getState()
    .seedEpic(tab.id, { tabId: tab.id, name: tab.name }, []);
  return tab.id;
}

function canvasTabIds(tabId: string): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId] ?? null;
  if (canvas === null) return [];
  return collectPanes(canvas.root).flatMap((pane) =>
    paneTabRefs(canvas, pane).map((tab) => tab.id),
  );
}

function registerEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, [], []),
  );
}

function registerActiveEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
  activeAgentIds: ReadonlyArray<string>,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, activeAgentIds, activeAgentIds),
  );
}

function registerLiveEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
  liveAgentIds: ReadonlyArray<string>,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, [], liveAgentIds),
  );
}

function registerStaleActiveEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
  activeAgentIds: ReadonlyArray<string>,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, activeAgentIds, []),
  );
}

function buildHeaderEpicHandle(
  tab: EpicTab,
  permissionRole: PermissionRole,
  activeAgentIds: ReadonlyArray<string>,
  liveAgentIds: ReadonlyArray<string>,
): OpenEpicStoreHandle {
  const liveChatsById = Object.fromEntries(
    liveAgentIds.map((id) => [
      id,
      {
        id,
        title: id,
        parentId: null,
        createdAt: 1,
        updatedAt: 1,
        userId: null,
        hostId: "host-a",
        isTitleEditedByUser: false,
        settings: null,
      },
    ]),
  );
  const state = {
    ...EMPTY_PROJECTED_SLICES,
    epic: {
      title: tab.name,
      updatedAt: 1,
      isTitleEditedByUser: false,
    },
    chats: {
      byId: liveChatsById,
      allIds: liveAgentIds,
    },
    permissionRole,
    snapshotMeta: null,
    isDirty: false,
    unsyncedQueueSize: 0,
    bindingVersion: 0,
  };
  const storeCallable = (_selector: unknown): unknown => state;
  const storeBase: unknown = Object.assign(storeCallable, {
    getState: () => state as never,
    subscribe: () => () => undefined,
  });
  const awareness = {
    getStates: () =>
      new Map<number, Record<string, unknown>>([
        [
          1,
          {
            [AGENT_WORKING_AWARENESS_FIELD]: activeAgentIds,
          },
        ],
      ]),
    on: () => undefined,
    off: () => undefined,
  };
  return {
    epicId: tab.id,
    userId: null,
    doc: {} as never,
    awareness: awareness as never,
    store: storeBase as OpenEpicStoreHandle["store"],
    dispose: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => true,
  };
}

function registerChatSession(epicId: string, chatId: string): void {
  __getChatSessionRegistryForTests().acquire(
    epicId,
    chatId,
    `test:${epicId}:${chatId}`,
    (factoryEpicId, factoryChatId) =>
      createChatSessionStore({
        epicId: factoryEpicId,
        chatId: factoryChatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          close: () => undefined,
        }),
      }),
  );
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  __getOpenEpicRegistryForTests().disposeAll();
  __getChatSessionRegistryForTests().disposeAll();
}

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <TabStrip />
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="home" />,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId",
    validateSearch: (
      search: Record<string, unknown>,
    ): { focusedAt: number | undefined } => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
    }),
    component: () => <div data-testid="epic-body" />,
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    validateSearch: (
      search: Record<string, unknown>,
    ): { focusedAt: number | undefined } => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
    }),
    component: () => <div data-testid="epic-tab-body" />,
  });
  const epicsListRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics",
    component: () => <div data-testid="epics-list" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
    component: () => <div data-testid="settings-body" />,
  });
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/draft/$draftId",
    component: () => <div data-testid="draft-body" />,
  });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    epicRoute,
    epicTabRoute,
    epicsListRoute,
    settingsRoute,
    draftRoute,
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

async function flushNav(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((r) => setTimeout(r, 0));
}

// Reconciliation install is owned by `WindowsBridgeProvider` in
// production. Test mounts skip the provider, so install once here.
installTabSyncCoordinator({ readyPromise: Promise.resolve() });

describe("<TabStrip />", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    window.localStorage.clear();
    pinTestState.pinnedByEpicId.clear();
    pinTestState.pendingEpicIds.clear();
    pinTestState.mutate.mockReset();
    pinTestState.mutate.mockImplementation(
      (
        _variables: TestSetPinnedVariables,
        options: TestSetPinnedOptions | undefined,
      ) => options?.onSuccess(),
    );
    toastTestState.messages.length = 0;
    toastTestState.actionLabel = null;
    toastTestState.undo = null;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    resetStores();
  });

  it("renders one tab per open epic", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("tab-epic-e-a")).toBeDefined();
    expect(screen.getByTestId("tab-epic-e-b")).toBeDefined();
    expect(screen.getByTestId("tab-new")).toBeDefined();
  });

  it("caps header tab frames while preserving the shrink floor", async () => {
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const tab = await screen.findByTestId("tab-epic-e-a");
    const frame = tab.parentElement;
    if (frame === null) throw new Error("Expected tab frame");

    expect(frame.className).toContain("min-w-[120px]");
    expect(frame.className).toContain("w-56");
    expect(frame.className).toContain("max-w-56");
    expect(frame.className).toContain("flex-[1_1_14rem]");
    expect(frame.className).toContain("[container-type:inline-size]");
    expect(tab.className).toContain("[-webkit-app-region:no-drag]");
    expect(screen.getByTestId("tab-new").className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  it("renders a hover chrome layer for inactive header tabs", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-b/e-b");
    render(<RouterProvider router={router} />);

    const inactiveTab = await screen.findByTestId("tab-epic-e-a");
    const activeTab = screen.getByTestId("tab-epic-e-b");
    const hoverChrome = inactiveTab.firstElementChild;

    expect(inactiveTab.getAttribute("aria-selected")).toBe("false");
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
    const closeSlot = screen.getByTestId("tab-close-epic-e-a").parentElement;
    if (closeSlot === null) throw new Error("Expected tab close slot");

    expect(closeSlot.className).toContain("header-tab-trailing-slot");
    expect(closeSlot.className).not.toContain("group-hover/tab:w-5");
    expect(hoverChrome?.className).toContain("rounded-md");
    expect(hoverChrome?.className).toContain("group-hover/tab:opacity-100");
    // :focus-visible (keyboard-only), NOT :focus-within - a mouse-drag reorder
    // focuses the tab div without activating it, and :focus-within would leave
    // this accent chrome stuck lit on the inactive tab. The has-[:focus-visible]
    // gate keeps it lit when the separate close button (a descendant tab stop)
    // takes keyboard focus. See tab-strip-item.tsx.
    expect(hoverChrome?.className).toContain(
      "group-focus-visible/tab:opacity-100",
    );
    expect(hoverChrome?.className).toContain(
      "group-has-[:focus-visible]/tab:opacity-100",
    );
    expect(hoverChrome?.querySelector("svg")).toBeNull();
  });

  it("keeps the new-tab button after the tabs while preserving overflow", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-epic-e-a");

    const tabRow = screen.getByTestId("header-tab-strip-scroll");
    const newTabButton = screen.getByTestId("tab-new");
    const tabCluster = newTabButton.parentElement;
    if (tabCluster === null) throw new Error("Expected tab cluster");
    Object.defineProperties(tabRow, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
    });

    fireEvent.wheel(tabRow, { deltaY: 80, deltaMode: 0 });

    expect(tabRow.className).toContain("flex-[0_1_auto]");
    expect(tabRow.className).not.toContain("w-max");
    expect(tabRow.className).toContain("overflow-x-auto");
    expect(tabRow.scrollLeft).toBe(80);
    expect(newTabButton.parentElement).not.toBe(tabRow);
    expect(tabCluster.className).toContain("max-w-full");
    expect(tabCluster.className).toContain("flex-[0_1_auto]");
    expect(tabCluster.className).not.toContain("flex-1");
    expect(newTabButton.className).toContain("shrink-0");
  });

  it("scrolls the active header tab into view after any route activation", async () => {
    const scrollTargets: Element[] = [];
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrollTargets.push(this);
      });
    try {
      openEpicFixture(EPIC_A);
      openEpicFixture(EPIC_B);
      openEpicFixture(EPIC_C);
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);
      await screen.findByTestId("tab-epic-e-a");

      scrollTargets.length = 0;
      scrollSpy.mockClear();

      await router.navigate({
        to: "/epics/$epicId/$tabId",
        params: { epicId: "e-c", tabId: "e-c" },
        search: {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      });
      await flushNav();

      const activeTab = screen.getByTestId("tab-epic-e-c");
      expect(scrollTargets).toContain(activeTab);
      expect(scrollSpy).toHaveBeenCalledWith({
        block: "nearest",
        inline: "nearest",
      });
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("scopes the epic title tooltip trigger to the title text", async () => {
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const tab = await screen.findByTestId("tab-epic-e-a");
    const title = screen.getByTestId("tab-title-epic-e-a");

    expect(tab.getAttribute("data-slot")).not.toBe("tooltip-trigger");
    expect(title.getAttribute("data-slot")).toBe("tooltip-trigger");
  });

  it("shows a spinner while epic title generation is pending", async () => {
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    useEpicCanvasStore.getState().markEpicTitlePending(EPIC_A.id, EPIC_A.name);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-title-generating-${EPIC_A.id}`),
    ).toBeDefined();
  });

  it("shows a task activity spinner while any chat is active in the epic", async () => {
    openEpicFixture(EPIC_A);
    registerActiveEpicHeader(EPIC_A, "owner", ["chat-active"]);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-activity-${EPIC_A.id}`),
    ).toBeDefined();
  });

  it("shows the chat-level background indicator when only background work remains", async () => {
    openEpicFixture(EPIC_A);
    registerActiveEpicHeader(EPIC_A, "owner", ["chat-background"]);
    registerChatSession(EPIC_A.id, "chat-background");
    const handle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-background",
    );
    if (handle === null) throw new Error("expected chat session handle");
    handle.store.setState({
      runStatus: "running",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [
        {
          taskId: "background-task",
          kind: "monitor",
          title: "Monitor",
          blockId: "background-task",
          parentTaskId: null,
          scheduledFor: null,
        },
      ],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const backgroundIcon = await screen.findByTestId(
      `header-tab-background-activity-${EPIC_A.id}`,
    );
    expect(backgroundIcon.getAttribute("class")).toContain(
      "lucide-message-square-clock",
    );
    expect(screen.queryByTestId(`header-tab-activity-${EPIC_A.id}`)).toBeNull();
    expect(
      screen.queryByTitle("Background activity — agent idle"),
    ).not.toBeNull();
  });

  it("prioritizes turn activity over background work from another chat", async () => {
    openEpicFixture(EPIC_A);
    registerActiveEpicHeader(EPIC_A, "owner", ["chat-background", "chat-turn"]);
    registerChatSession(EPIC_A.id, "chat-background");
    registerChatSession(EPIC_A.id, "chat-turn");
    const backgroundHandle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-background",
    );
    const turnHandle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-turn",
    );
    if (backgroundHandle === null || turnHandle === null) {
      throw new Error("expected chat session handles");
    }
    backgroundHandle.store.setState({
      runStatus: "running",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [],
    });
    turnHandle.store.setState({
      runStatus: "running",
      activeTurn: null,
      turnInProgress: true,
      backgroundItems: [],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-activity-${EPIC_A.id}`),
    ).toBeDefined();
    expect(
      screen.queryByTestId(`header-tab-background-activity-${EPIC_A.id}`),
    ).toBeNull();
  });

  it("ignores stale active awareness for a deleted chat", async () => {
    openEpicFixture(EPIC_A);
    registerStaleActiveEpicHeader(EPIC_A, "owner", ["chat-deleted"]);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId(`tab-epic-${EPIC_A.id}`)).toBeDefined();
    expect(screen.queryByTestId(`header-tab-activity-${EPIC_A.id}`)).toBeNull();
    expect(screen.queryByTestId(`header-tab-prompt-${EPIC_A.id}`)).toBeNull();
  });

  it("does not derive a prompt indicator from a chat session's pending interview", () => {
    openEpicFixture(EPIC_A);
    registerLiveEpicHeader(EPIC_A, "owner", ["chat-waiting"]);
    registerChatSession(EPIC_A.id, "chat-waiting");
    const handle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-waiting",
    );
    if (handle === null) throw new Error("expected chat session handle");
    handle.store.setState({
      pendingInterviews: [{ blockId: "question-1", requestedAt: 1 }],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(screen.queryByTestId(`header-tab-prompt-${EPIC_A.id}`)).toBeNull();
  });

  it("does not derive a prompt indicator from a chat session's pending approval", () => {
    openEpicFixture(EPIC_A);
    registerLiveEpicHeader(EPIC_A, "owner", ["chat-permission"]);
    registerChatSession(EPIC_A.id, "chat-permission");
    const handle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-permission",
    );
    if (handle === null) throw new Error("expected chat session handle");
    handle.store.setState({
      pendingApprovals: [
        {
          kind: "tool",
          approvalId: "approval-1",
          toolName: "edit",
          description: "Apply change",
          input: null,
          planId: null,
          actions: [],
          requestedAt: 1,
        },
      ],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(screen.queryByTestId(`header-tab-prompt-${EPIC_A.id}`)).toBeNull();
  });

  it("hides the header epic edit-title menu item for viewer role", async () => {
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    expect(await screen.findByText("Edit Title")).toBeDefined();
    cleanup();
    queryClient.clear();
    resetStores();

    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "viewer");
    const viewerRouter = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={viewerRouter} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    expect(screen.queryByText("Edit Title")).toBeNull();
    expect(screen.getByText("Pin Task in History")).toBeDefined();
  });

  it("pins a task from its tab context menu and offers Undo", async () => {
    pinTestState.pinnedByEpicId.set(EPIC_A.id, false);
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    fireEvent.click(await screen.findByText("Pin Task in History"));

    expect(pinTestState.mutate).toHaveBeenCalledTimes(1);
    const firstCall = pinTestState.mutate.mock.calls[0];
    expect(firstCall[0]).toEqual({ epicId: EPIC_A.id, pinned: true });
    expect(typeof firstCall[1]?.onSuccess).toBe("function");
    expect(toastTestState.messages).toEqual([
      "Pinned “Alpha” to the top of History",
    ]);
    expect(toastTestState.actionLabel).toBe("Undo");
    expect(toastTestState.undo).not.toBeNull();

    toastTestState.undo?.();

    expect(pinTestState.mutate).toHaveBeenNthCalledWith(2, {
      epicId: EPIC_A.id,
      pinned: false,
    });
  });

  it("shows the inverse task-history action for a pinned task", async () => {
    pinTestState.pinnedByEpicId.set(EPIC_A.id, true);
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));

    expect(await screen.findByText("Unpin Task in History")).toBeDefined();
  });

  it("does not expose the task-history pin action on system tabs", async () => {
    ensureHistoryTab();
    const router = buildRouter("/epics");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-history-history"));

    expect(screen.queryByText("Pin Task in History")).toBeNull();
    expect(screen.queryByText("Unpin Task in History")).toBeNull();
  });

  it("delays leader digit badges on header tabs", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByTestId("tab-epic-e-a")).toBeDefined();
    vi.useFakeTimers();
    try {
      expect(screen.queryByTestId("tab-digit-1")).toBeNull();

      fireEvent.keyDown(window, {
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
      });
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(screen.queryByTestId("tab-digit-1")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByTestId("tab-digit-1")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close the previous epic canvas tab when Cmd-W follows new draft activation", async () => {
    const epicTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-current", "Current Epic");
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_A);
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_B);
    useTabsStore.setState((state) => ({
      ...state,
      stripOrder: useEpicCanvasStore
        .getState()
        .openTabOrder.map((id) => ({ kind: "epic", id })),
    }));
    const before = canvasTabIds(epicTabId);
    const router = buildRouter(`/epics/epic-current/${epicTabId}`);

    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId(`tab-epic-${epicTabId}`);

    fireEvent.click(screen.getByTestId("tab-new"));
    await flushNav();
    fireEvent.keyDown(window, {
      code: "KeyW",
      key: "w",
      metaKey: true,
    });
    await flushNav();

    expect(canvasTabIds(epicTabId)).toEqual(before);
  });

  it("does not close the previous epic canvas tab when Cmd-W follows Cmd-T", async () => {
    const epicTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-current", "Current Epic");
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_A);
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_B);
    useTabsStore.setState((state) => ({
      ...state,
      stripOrder: useEpicCanvasStore
        .getState()
        .openTabOrder.map((id) => ({ kind: "epic", id })),
    }));
    const before = canvasTabIds(epicTabId);
    const router = buildRouter(`/epics/epic-current/${epicTabId}`);

    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId(`tab-epic-${epicTabId}`);

    fireEvent.keyDown(window, {
      code: "KeyT",
      key: "t",
      metaKey: true,
    });
    await flushNav();
    fireEvent.keyDown(window, {
      code: "KeyW",
      key: "w",
      metaKey: true,
    });
    await flushNav();

    // Cmd-T now opens a blank tab in the active group (`tab.new`); `epic.new`
    // moved to Cmd-N. So Cmd-T no longer spawns a landing draft, and the
    // following Cmd-W closes that blank - leaving the previous epic canvas tab
    // and its real tabs untouched.
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(screen.queryByTestId(`tab-epic-${epicTabId}`)).not.toBeNull();
    expect(canvasTabIds(epicTabId)).toEqual(before);
  });

  it("renders leader number badges beyond single digit on header tabs", async () => {
    Array.from({ length: 11 }, (_, index) => epicFixture(index + 1)).forEach(
      (fixture) => openEpicFixture(fixture),
    );
    const router = buildRouter("/epics/e-1/e-1");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByTestId("tab-epic-e-1")).toBeDefined();
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(window, {
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(screen.getByTestId("tab-digit-10").textContent).toContain("10");
      expect(screen.getByTestId("tab-digit-11").textContent).toContain("11");
      expect(screen.queryByTestId("tab-digit-0")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the strip on the landing page when there are no tabs", () => {
    const router = buildRouter("/");
    render(<RouterProvider router={router} />);

    expect(screen.queryByTestId("tab-strip")).toBeNull();
  });

  it("renders a History tab opened via ensureHistoryTab", async () => {
    ensureHistoryTab();
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("tab-history-history")).toBeDefined();
    expect(screen.getByTestId("tab-epic-e-a")).toBeDefined();
  });

  it("renders a Settings tab opened via ensureSettingsTab", async () => {
    ensureSettingsTab({ subSection: null, resetToGeneral: true });
    const router = buildRouter("/settings/general");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("tab-settings-settings")).toBeDefined();
  });

  it("falls back to Settings general when a persisted Settings path is stale", async () => {
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: "/epics/e-a/tab-a",
    });
    const router = buildRouter("/epics/e-a/tab-a");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-settings-settings");

    fireEvent.click(screen.getByTestId("tab-settings-settings"));
    await flushNav();

    expect(router.state.location.pathname).toBe("/settings/general");
  });

  it("switches from an active epic tab to non-epic strip tabs", async () => {
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

    const router = buildRouter(`/epics/epic-current/${epicTabId}`);
    render(<RouterProvider router={router} />);
    await screen.findByTestId(`tab-epic-${epicTabId}`);

    fireEvent.click(screen.getByTestId("tab-settings-settings"));
    await flushNav();
    expect(router.state.location.pathname).toBe("/settings/general");

    await router.navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-current", tabId: epicTabId },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      },
    });
    fireEvent.click(screen.getByTestId("tab-history-history"));
    await flushNav();
    expect(router.state.location.pathname).toBe("/epics");

    await router.navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-current", tabId: epicTabId },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      },
    });
    fireEvent.click(screen.getByTestId(`tab-draft-${draftId}`));
    await flushNav();
    expect(router.state.location.pathname).toBe(`/draft/${draftId}`);
  });

  it("only marks the routed tab active when one epic has multiple tabs", async () => {
    const store = useEpicCanvasStore.getState();
    const firstTabId = store.openEpicTab("epic-shared", "Shared");
    const secondTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    const thirdTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    if (secondTabId === null || thirdTabId === null) {
      throw new Error("Expected duplicate tabs");
    }
    const router = buildRouter(`/epics/epic-shared/${secondTabId}`);
    render(<RouterProvider router={router} />);

    const first = await screen.findByTestId(`tab-epic-${firstTabId}`);
    const second = await screen.findByTestId(`tab-epic-${secondTabId}`);
    const third = await screen.findByTestId(`tab-epic-${thirdTabId}`);

    expect(first.getAttribute("aria-selected")).toBe("false");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(third.getAttribute("aria-selected")).toBe("false");
  });

  it("does not resurrect same-epic duplicates when closing them serially", async () => {
    const store = useEpicCanvasStore.getState();
    const firstTabId = store.openEpicTab("epic-shared", "Shared");
    const secondTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    const thirdTabId = useEpicCanvasStore
      .getState()
      .duplicateTab(secondTabId ?? firstTabId);
    if (secondTabId === null || thirdTabId === null) {
      throw new Error("Expected duplicate tabs");
    }
    const router = buildRouter(`/epics/epic-shared/${thirdTabId}`);
    render(<RouterProvider router={router} />);
    await screen.findByTestId(`tab-epic-${thirdTabId}`);

    fireEvent.click(screen.getByTestId(`tab-close-epic-${thirdTabId}`));
    await flushNav();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      firstTabId,
      secondTabId,
    ]);
    expect(useTabsStore.getState().stripOrder).toEqual([
      { kind: "epic", id: firstTabId },
      { kind: "epic", id: secondTabId },
    ]);

    fireEvent.click(screen.getByTestId(`tab-close-epic-${secondTabId}`));
    await flushNav();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([firstTabId]);
    expect(useTabsStore.getState().stripOrder).toEqual([
      { kind: "epic", id: firstTabId },
    ]);

    fireEvent.click(screen.getByTestId(`tab-close-epic-${firstTabId}`));
    await flushNav();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(useEpicCanvasStore.getState().tabsById[firstTabId]?.epicId).toBe(
      "epic-shared",
    );
    expect(useEpicCanvasStore.getState().tabsById[secondTabId]?.epicId).toBe(
      "epic-shared",
    );
    expect(useEpicCanvasStore.getState().tabsById[thirdTabId]?.epicId).toBe(
      "epic-shared",
    );
    expect(useTabsStore.getState().stripOrder).toEqual([]);
    expect(screen.queryByTestId(`tab-epic-${firstTabId}`)).toBeNull();
    expect(screen.queryByTestId(`tab-epic-${secondTabId}`)).toBeNull();
    expect(screen.queryByTestId(`tab-epic-${thirdTabId}`)).toBeNull();
  });

  it("ignores stale legacy epic rows after canonical tabs close", async () => {
    const store = useEpicCanvasStore.getState();
    const firstTabId = store.openEpicTab("epic-shared", "Shared");
    const secondTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    const thirdTabId = useEpicCanvasStore
      .getState()
      .duplicateTab(secondTabId ?? firstTabId);
    if (secondTabId === null || thirdTabId === null) {
      throw new Error("Expected duplicate tabs");
    }

    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        [firstTabId]: state.tabsById[firstTabId],
      },
      openTabOrder: [firstTabId],
    }));
    useTabsStore.setState({
      stripOrder: [
        { kind: "epic", id: firstTabId },
        { kind: "epic", id: secondTabId },
        { kind: "epic", id: thirdTabId },
      ],
    });

    const router = buildRouter(`/epics/epic-shared/${firstTabId}`);
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId(`tab-epic-${firstTabId}`)).toBeDefined();
    expect(screen.queryByTestId(`tab-epic-${secondTabId}`)).toBeNull();
    expect(screen.queryByTestId(`tab-epic-${thirdTabId}`)).toBeNull();
  });

  it("ensureHistoryTab is a singleton - repeat calls do not duplicate", () => {
    ensureHistoryTab();
    ensureHistoryTab();
    ensureHistoryTab();

    const refs = useTabsStore.getState().stripOrder;
    expect(
      refs.filter((ref) => ref.kind === "history" && ref.id === "history"),
    ).toHaveLength(1);
  });

  it("closing the History tab via X removes it from the strip", async () => {
    ensureHistoryTab();
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-close-history-history");

    fireEvent.click(screen.getByTestId("tab-close-history-history"));
    await flushNav();

    expect(useTabsStore.getState().systemTabs.history).toBeNull();
    expect(
      useTabsStore.getState().stripOrder.some((ref) => ref.kind === "history"),
    ).toBe(false);
  });
});
