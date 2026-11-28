/**
 * `useStripTabItem` is the whole per-tab behaviour; a presentation only paints.
 * The `BareRow` below is the minimal second presentation a side row would be:
 * a `div` over the hook, with no handlers of its own. Every behaviour asserted
 * against it therefore comes from the hook and the two components it exports.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useStripTabItem, type StripTabItemInput } from "../use-strip-tab-item";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  StripTabContextMenu,
  StripTabTitleInput,
} from "../strip-tab-item-parts";
import { TabItem } from "../tab-strip-item";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import {
  LeaderHeldContext,
  type LeaderState,
} from "@/providers/keybinding-context";
import { LEADER_SCOPE_HEADER_TABS } from "@/lib/keybindings/leader-scope";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { toast } from "sonner";
import { HOST_UNKNOWN_OUTCOME_NOTICE } from "@/lib/host-error-toast";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { markTargetAnswer } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  createTitleRequesterFixture,
  mountPoolServingWithHomeOffline,
  resetTitleRequesterFixture,
  seedPoolCloudHistoryRow,
  signInTaskTitleTestUser,
  titleUpdateCalls,
  TITLE_TEST_HOME_HOST_ID,
  TITLE_TEST_PINNED_HOST_ID,
  TITLE_TEST_USER_ID,
} from "@/lib/test-support/epic-title-requester-fixture";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { registerEditableEpicSession } from "@/stores/epics/open-epic/test-support/editable-epic-session-fixture";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";
import type { HeaderTab } from "@/stores/tabs/types";

const titleRequesterState = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

function targetedTitleWriteError(
  code: "E_IDEMPOTENCY_OUTCOME_UNKNOWN" | "E_WRITE_NOT_STARTED",
): HostRpcError {
  const error = HostRpcError.fromWireEnvelope(
    {
      code,
      message:
        code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN"
          ? "The pool could not confirm whether the title was saved."
          : "The pool refused the title write before starting it.",
    },
    "task-title-request",
    "epic.updateTitle",
  );
  markTargetAnswer(error);
  return error;
}

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    getHostBindingSnapshot: () =>
      titleRequesterState.client === null
        ? null
        : { hostClient: titleRequesterState.client },
  };
});

const navigation = vi.hoisted((): { calls: unknown[] } => ({ calls: [] }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return {
    ...actual,
    navigateToTabIntent: (_navigate: unknown, intent: unknown) => {
      navigation.calls.push(intent);
    },
  };
});

/** Reads a host client, which throws outside a `<HostRuntimeProvider>`. */
vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: () => false,
}));

// The context menu's appearance submenu composes the organization
// task-context query, which also reads a host client and throws outside a
// `<HostRuntimeProvider>`. No case here supplies an organization host or
// asserts that submenu's data, so keep it inert at its host-query boundary.
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(),
    localHomedTaskIds: new Set(),
    isFetching: false,
    error: null,
  }),
}));

vi.mock(
  "@/hooks/epic/use-epic-task-pinned-states-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-task-pinned-states-query")
      >();
    return {
      ...actual,
      useComputerTaskPinReading: () => null,
      usePoolTaskPinReading: () => null,
    };
  },
);

const EPIC_ID = "epic-row";
const CHAT_ID = "chat-row";

const EPIC_TAB: Extract<HeaderTab, { kind: "epic" }> = {
  kind: "epic",
  id: "tab-row",
  epicId: EPIC_ID,
  hostId: null,
  route: `/epics/${EPIC_ID}/tab-row`,
  name: "Row task",
  icon: null,
  canClose: true,
  canDuplicate: false,
  canOpenInNewWindow: false,
  appearance: null,
};

const IDLE_LEADER: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

const ALT_LEADER: LeaderState = {
  ...IDLE_LEADER,
  altHeld: true,
  altOwnerScopeId: LEADER_SCOPE_HEADER_TABS,
};

/** The host has a row for the epic and no prompt notification is lit for it. */
const NO_PROMPT_LIT_INDICATORS: SurfaceNotificationIndicators = {
  epics: {
    [EPIC_ID]: { ...EMPTY_NOTIFICATION_INDICATOR_STATE, unreadCount: 0 },
  },
  chats: {},
};

function makeInput(): StripTabItemInput {
  return {
    tab: EPIC_TAB,
    index: 0,
    dnd: { stripItemId: `tab:epic:${EPIC_TAB.id}`, index: 0, isDropSlot: true },
    isActive: false,
    onClose: () => undefined,
    onCloseOtherTabs: () => undefined,
    canCloseOtherTabs: false,
    onDuplicateTab: () => undefined,
    onOpenInNewWindow: () => undefined,
    canOpenInNewWindow: false,
    onSplitCommand: () => undefined,
    taskPinnedState: {
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    },
    isTaskPinPending: false,
    onTaskPinMenuOpen: () => undefined,
    onSetTaskPinned: () => undefined,
  };
}

/** A second presentation over the hook, with no behaviour of its own. */
function BareRow(props: { readonly input: StripTabItemInput }) {
  const { rootRef, ...item } = useStripTabItem(props.input);
  return (
    <StripTabContextMenu item={item} input={props.input}>
      <div ref={rootRef} {...item.dragListeners} {...item.rootProps}>
        {item.rename.isEditing ? (
          <StripTabTitleInput item={item} tab={props.input.tab} className="" />
        ) : (
          <span>{item.displayName}</span>
        )}
        {item.leaderBadge === null ? null : (
          <span data-testid="bare-leader">{item.leaderBadge.hint}</span>
        )}
      </div>
    </StripTabContextMenu>
  );
}

function DragHarness(props: { readonly children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  return <DndContext sensors={sensors}>{props.children}</DndContext>;
}

async function renderInApp(
  node: ReactNode,
  leader: LeaderState,
  indicators: SurfaceNotificationIndicators,
): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await renderInAppWithQueryClient(node, leader, indicators, queryClient);
}

async function renderInAppWithQueryClient(
  node: ReactNode,
  leader: LeaderState,
  indicators: SurfaceNotificationIndicators,
  queryClient: QueryClient,
): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <LeaderHeldContext.Provider value={leader}>
            <NotificationIndicatorsContext.Provider value={indicators}>
              <DragHarness>{node}</DragHarness>
            </NotificationIndicatorsContext.Provider>
          </LeaderHeldContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
}

async function beginStripTitleRename(): Promise<HTMLElement> {
  const row = await screen.findByTestId(`tab-epic-${EPIC_TAB.id}`);
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByText("Edit Title"));
  const input = await screen.findByTestId(
    `tab-title-input-epic-${EPIC_TAB.id}`,
  );
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

function submitStripTitleRename(input: HTMLElement, title: string): void {
  fireEvent.change(input, { target: { value: title } });
  fireEvent.keyDown(input, { key: "Enter" });
}

/** A live epic projection holding `CHAT_ID`, with a warm session parked on a command approval. */
function registerChatWaitingOnApproval(): void {
  const epic = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: () => ({
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => undefined,
      }),
      laneSelection: null,
    },
    writeCommand: null,
  });
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () => epic);
  epic.store.setState({ chats: { allIds: [CHAT_ID], byId: {} } });
  const chat = __getChatSessionRegistryForTests().acquire(
    {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: "host-1",
      scopeKey: "strip-tab-item-test",
    },
    () =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: "host-a",
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      }),
  );
  chat.store.setState({
    pendingApprovals: [
      {
        kind: "tool",
        approvalId: "approval-1",
        toolName: "bash",
        description: "Run a command",
        input: null,
        planId: null,
        actions: [],
        requestedAt: 1,
        reason: null,
        reviewing: null,
      },
    ],
  });
}

beforeEach(() => {
  navigation.calls.length = 0;
  // A cloud-homed epic's rename and History pin are cloud capabilities.
  useAuthStore.setState({ status: "signed-in" });
  titleRequesterState.client = null;
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ status: "signed-out" });
  titleRequesterState.client = null;
  resetTitleRequesterFixture();
  useCloudEpicTasksPagesStore.setState({
    pagesByIdentity: {},
    generationByIdentity: {},
    identitiesWithDisplacedRowsPage: new Set(),
    deletedEpicIdsByScope: {},
  });
  __getOpenEpicRegistryForTests().disposeAll();
  disposeAllChatSessions();
  useEpicDndStore.setState({ topLevelStripPairPreview: null });
});

describe("useStripTabItem through a bare presentation", () => {
  it("carries the tab's root attributes", async () => {
    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = screen.getByTestId(`tab-epic-${EPIC_TAB.id}`);
    expect(row.getAttribute("role")).toBe("tab");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-selected")).toBe("false");
    expect(row.getAttribute("data-header-tab-key")).toBe(`epic:${EPIC_TAB.id}`);
    expect(row.getAttribute("data-tab-kind")).toBe("epic");
    expect(row.getAttribute("data-tab-index")).toBe("0");
  });

  it("activates on Enter and Space, and not on other keys", async () => {
    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = screen.getByTestId(`tab-epic-${EPIC_TAB.id}`);
    fireEvent.keyDown(row, { key: "a" });
    expect(navigation.calls).toHaveLength(0);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(navigation.calls).toHaveLength(1);
    fireEvent.keyDown(row, { key: " " });
    expect(navigation.calls).toHaveLength(2);
  });

  it("closes through onClose on a middle click, and not on a left click", async () => {
    const onClose = vi.fn<(tab: HeaderTab) => void>();
    await renderInApp(
      <BareRow input={{ ...makeInput(), onClose }} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = screen.getByTestId(`tab-epic-${EPIC_TAB.id}`);

    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 0 }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(EPIC_TAB);
  });

  it("ignores a middle click on a tab that cannot close", async () => {
    const onClose = vi.fn<(tab: HeaderTab) => void>();
    await renderInApp(
      <BareRow
        input={{
          ...makeInput(),
          tab: { ...EPIC_TAB, canClose: false },
          onClose,
        }}
      />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );

    fireEvent(
      screen.getByTestId(`tab-epic-${EPIC_TAB.id}`),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );

    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores a middle click while the inline title rename is open", async () => {
    registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Row task",
      userId: null,
      hostId: "host-a",
      writes: [],
    });
    const onClose = vi.fn<(tab: HeaderTab) => void>();
    await renderInApp(
      <BareRow input={{ ...makeInput(), onClose }} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = await screen.findByTestId(`tab-epic-${EPIC_TAB.id}`);
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Edit Title"));
    await screen.findByTestId(`tab-title-input-epic-${EPIC_TAB.id}`);

    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("activates the tab the moment a drag picks it up, before any release", async () => {
    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = screen.getByTestId(`tab-epic-${EPIC_TAB.id}`);
    act(() => {
      fireEvent.pointerDown(row, {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
    });
    expect(navigation.calls).toHaveLength(0);
    act(() => {
      fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 10 });
    });
    await waitFor(() => expect(navigation.calls).toHaveLength(1));
    // A started drag makes dnd-kit stop every click on the document, and its
    // release lifts that on a timer. The timer runs here so the drag ends with
    // this test: left pending, it swallows a later test's click.
    vi.useFakeTimers();
    act(() => {
      fireEvent.pointerUp(row, { pointerId: 1, clientX: 40, clientY: 10 });
    });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    const bubbled = vi.fn();
    document.body.addEventListener("click", bubbled);
    try {
      fireEvent.click(row);
    } finally {
      document.body.removeEventListener("click", bubbled);
    }
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it("opens the context menu on a long press, and a moving touch cancels it", async () => {
    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = screen.getByTestId(`tab-epic-${EPIC_TAB.id}`);
    const contextMenus: MouseEvent[] = [];
    row.addEventListener("contextmenu", (event) => {
      contextMenus.push(event);
    });
    vi.useFakeTimers();

    fireEvent.touchStart(row, { touches: [{ clientX: 12, clientY: 34 }] });
    fireEvent.touchMove(row);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(contextMenus).toHaveLength(0);

    fireEvent.touchStart(row, { touches: [{ clientX: 12, clientY: 34 }] });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(contextMenus).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(contextMenus).toHaveLength(1);
    expect(contextMenus[0]?.clientX).toBe(12);
    expect(contextMenus[0]?.clientY).toBe(34);
    vi.useRealTimers();
    expect(await screen.findByText("Pin Task in History")).toBeDefined();
  });

  it("renames through Edit Title and commits on the epic's write path", async () => {
    const writes: EpicWriteCommandIntent[] = [];
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Row task",
      userId: null,
      hostId: "host-a",
      writes,
    });
    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = await screen.findByTestId(`tab-epic-${EPIC_TAB.id}`);

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Edit Title"));
    const input = await screen.findByTestId(
      `tab-title-input-epic-${EPIC_TAB.id}`,
    );
    expect(input.getAttribute("aria-label")).toBe("Edit epic title");
    // Guards the NON-MODAL tab menu: a modal menu's focus trap pulls focus
    // back as it closes, the input blur-commits and unmounts, and this fails.
    await waitFor(() => expect(document.activeElement).toBe(input));

    // Activation is suppressed while the title is being edited.
    fireEvent.keyDown(row, { key: "Enter" });
    expect(navigation.calls).toHaveLength(0);

    fireEvent.change(input, { target: { value: "Renamed row" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      kind: "update-epic-title",
      title: "Renamed row",
    });
    expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([]);
    expect(
      screen.queryByTestId(`tab-title-input-epic-${EPIC_TAB.id}`),
    ).toBeNull();
  });

  it("routes a detached cloud rename to its pool History row after home goes offline", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    signInTaskTitleTestUser();
    mountPoolServingWithHomeOffline();
    seedPoolCloudHistoryRow(queryClient, EPIC_ID);
    const writes: EpicWriteCommandIntent[] = [];
    const session = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Task title",
      userId: TITLE_TEST_USER_ID,
      hostId: TITLE_TEST_HOME_HOST_ID,
      writes,
    });
    await renderInAppWithQueryClient(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
      queryClient,
    );

    const input = await beginStripTitleRename();
    act(() => {
      session.release();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`tab-title-input-epic-${EPIC_TAB.id}`)).toBe(
        input,
      );
    });
    submitStripTitleRename(input, "Pool task title");

    await waitFor(() => {
      expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([
        {
          hostId: POOL_HOST_ID,
          epicId: EPIC_ID,
          title: "Pool task title",
        },
      ]);
    });
    expect(writes).toEqual([]);
    const poolPage = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        TITLE_TEST_USER_ID,
        LIST_CLOUD_TASKS_REQUEST,
      ),
    );
    expect(
      poolPage?.tasks.find((task) => task.epic?.light?.id === EPIC_ID)?.epic
        ?.light?.title,
    ).toBe("Pool task title");
  });

  it.each([
    ["unknown outcome", "E_IDEMPOTENCY_OUTCOME_UNKNOWN"],
    ["write not started", "E_WRITE_NOT_STARTED"],
  ] as const)(
    "keeps the pool strip rename truthful for an exact %s answer",
    async (_answer, code) => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const requesterFixture = createTitleRequesterFixture();
      requesterFixture.messenger.setHandlers({
        "epic.updateTitle": () => {
          throw targetedTitleWriteError(code);
        },
      });
      titleRequesterState.client = requesterFixture.client;
      signInTaskTitleTestUser();
      mountPoolServingWithHomeOffline();
      seedPoolCloudHistoryRow(queryClient, EPIC_ID);
      const pageKey = cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        TITLE_TEST_USER_ID,
        LIST_CLOUD_TASKS_REQUEST,
      );
      expect(queryClient.getQueryState(pageKey)?.isInvalidated).toBe(false);
      const noticesBefore = toast.getToasts().length;
      const session = registerEditableEpicSession({
        epicId: EPIC_ID,
        title: "Task title",
        userId: TITLE_TEST_USER_ID,
        hostId: TITLE_TEST_HOME_HOST_ID,
        writes: [],
      });
      const renameSuccess = vi.spyOn(toast, "success");
      const renameError = vi.spyOn(toast, "error");
      await renderInAppWithQueryClient(
        <BareRow input={makeInput()} />,
        IDLE_LEADER,
        NO_PROMPT_LIT_INDICATORS,
        queryClient,
      );

      const input = await beginStripTitleRename();
      act(() => {
        session.release();
      });
      await waitFor(() => {
        expect(screen.getByTestId(`tab-title-input-epic-${EPIC_TAB.id}`)).toBe(
          input,
        );
      });
      submitStripTitleRename(input, "Pool task title");

      await waitFor(() => {
        expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([
          {
            hostId: POOL_HOST_ID,
            epicId: EPIC_ID,
            title: "Pool task title",
          },
        ]);
        if (code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN") {
          expect(queryClient.getQueryState(pageKey)?.isInvalidated).toBe(true);
          expect(
            toast
              .getToasts()
              .slice(noticesBefore)
              .filter(
                (notice) =>
                  "title" in notice &&
                  notice.title === HOST_UNKNOWN_OUTCOME_NOTICE,
              ),
          ).toHaveLength(1);
        } else {
          expect(renameError).toHaveBeenCalledWith("Couldn't rename epic.");
        }
      });
      expect(renameSuccess).not.toHaveBeenCalled();
      expect(titleUpdateCalls(requesterFixture.messenger)).toHaveLength(1);
      const poolPage = queryClient.getQueryData<ListTasksResponse>(pageKey);
      expect(
        poolPage?.tasks.find((task) => task.epic?.light?.id === EPIC_ID)?.epic
          ?.light?.title,
      ).toBe("Task title");
      if (code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN") {
        expect(renameError).not.toHaveBeenCalled();
      } else {
        expect(
          toast
            .getToasts()
            .slice(noticesBefore)
            .filter(
              (notice) =>
                "title" in notice &&
                notice.title === HOST_UNKNOWN_OUTCOME_NOTICE,
            ),
        ).toHaveLength(0);
        expect(queryClient.getQueryState(pageKey)?.isInvalidated).toBe(false);
      }
    },
  );

  it("uses the explicit strip host ahead of pool row evidence after detachment", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    signInTaskTitleTestUser();
    mountPoolServingWithHomeOffline();
    seedPoolCloudHistoryRow(queryClient, EPIC_ID);
    const session = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Task title",
      userId: TITLE_TEST_USER_ID,
      hostId: TITLE_TEST_HOME_HOST_ID,
      writes: [],
    });
    const pinnedInput: StripTabItemInput = {
      ...makeInput(),
      tab: { ...EPIC_TAB, hostId: TITLE_TEST_PINNED_HOST_ID },
    };
    await renderInAppWithQueryClient(
      <BareRow input={pinnedInput} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
      queryClient,
    );

    const input = await beginStripTitleRename();
    act(() => {
      session.release();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`tab-title-input-epic-${EPIC_TAB.id}`)).toBe(
        input,
      );
    });
    submitStripTitleRename(input, "Pinned task title");

    await waitFor(() => {
      expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([
        {
          hostId: TITLE_TEST_PINNED_HOST_ID,
          epicId: EPIC_ID,
          title: "Pinned task title",
        },
      ]);
    });
    const poolPage = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        TITLE_TEST_USER_ID,
        LIST_CLOUD_TASKS_REQUEST,
      ),
    );
    expect(
      poolPage?.tasks.find((task) => task.epic?.light?.id === EPIC_ID)?.epic
        ?.light?.title,
    ).toBe("Task title");
  });

  it("keeps the strip failure toast and sends nothing when detached without row evidence", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    signInTaskTitleTestUser();
    mountPoolServingWithHomeOffline();
    const session = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Task title",
      userId: TITLE_TEST_USER_ID,
      hostId: TITLE_TEST_HOME_HOST_ID,
      writes: [],
    });
    await renderInAppWithQueryClient(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
      queryClient,
    );
    const failureToast = vi.spyOn(toast, "error");

    const input = await beginStripTitleRename();
    act(() => {
      session.release();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`tab-title-input-epic-${EPIC_TAB.id}`)).toBe(
        input,
      );
    });
    submitStripTitleRename(input, "No evidence title");

    await waitFor(() => {
      expect(failureToast).toHaveBeenCalledWith(
        "Couldn't reach the host to rename the epic.",
      );
    });
    expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([]);
  });

  it("keeps Edit Title present but disabled while the task-title overlay is retained", async () => {
    const handle = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Row task",
      userId: null,
      hostId: "host-a",
      writes: [],
    }).handle;
    const commandId = await handle.store.getState().submitWriteCommand({
      kind: "update-epic-title",
      title: "Held title",
      updatedAt: 1,
    });
    expect(commandId).not.toBeNull();
    await handle.flush();
    expect(handle.store.getState().occupiedWriteFields["epic-title"]).toBe(
      true,
    );

    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = await screen.findByTestId(`tab-epic-${EPIC_TAB.id}`);
    fireEvent.contextMenu(row);
    const editTitle = screen.getByRole("menuitem", { name: "Edit Title" });
    expect(editTitle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(editTitle);
    fireEvent.keyDown(editTitle, { key: "Enter", code: "Enter" });
    expect(
      screen.queryByTestId(`tab-title-input-epic-${EPIC_TAB.id}`),
    ).toBeNull();
  });

  it("keeps Edit Title absent for a denied user while the real task-title key is occupied", async () => {
    const handle = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Row task",
      userId: null,
      hostId: "host-a",
      writes: [],
    }).handle;
    const commandId = await handle.store.getState().submitWriteCommand({
      kind: "update-epic-title",
      title: "Occupied title",
      updatedAt: 1,
    });
    expect(commandId).not.toBeNull();
    await handle.flush();
    expect(handle.store.getState().occupiedWriteFields["epic-title"]).toBe(
      true,
    );
    handle.store.setState({ permissionRole: null });

    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = await screen.findByTestId(`tab-epic-${EPIC_TAB.id}`);
    fireEvent.contextMenu(row);

    expect(handle.store.getState().occupiedWriteFields["epic-title"]).toBe(
      true,
    );
    expect(screen.queryByRole("menuitem", { name: "Edit Title" })).toBeNull();
  });

  it("keeps Edit Title absent without a grant while the task-title key is idle", async () => {
    const handle = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Row task",
      userId: null,
      hostId: "host-a",
      writes: [],
    }).handle;
    handle.store.setState({ permissionRole: null });
    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const row = await screen.findByTestId(`tab-epic-${EPIC_TAB.id}`);
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menuitem", { name: "Edit Title" })).toBeNull();
  });

  it("shows the Alt-digit badge only while the header-tab scope owns alt", async () => {
    await renderInApp(
      <BareRow input={makeInput()} />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    expect(screen.queryByTestId("bare-leader")).toBeNull();
    cleanup();

    await renderInApp(
      <BareRow input={makeInput()} />,
      ALT_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    expect(screen.getByTestId("bare-leader").textContent).toContain("Row task");
  });
});

describe("TabItem waiting state", () => {
  it("shows no waiting glyph once the approval resolves", async () => {
    registerChatWaitingOnApproval();
    const input = makeInput();
    await renderInApp(
      <TabItem
        {...input}
        chrome="own"
        includeMotionFrame={false}
        offsetX={0}
        showSeparatorAfter={false}
        showDropIndicatorBefore={false}
        showDropIndicatorAfter={false}
      />,
      IDLE_LEADER,
      NO_PROMPT_LIT_INDICATORS,
    );
    const chat = __getChatSessionRegistryForTests().peek(
      EPIC_ID,
      CHAT_ID,
      "host-1",
    );
    if (chat === null) throw new Error("expected chat session");
    expect(
      screen.getByTestId(`header-tab-approval-${EPIC_TAB.id}`),
    ).toBeDefined();
    act(() => {
      chat.store.setState({ pendingApprovals: [] });
    });

    expect(
      screen.queryByTestId(`header-tab-approval-${EPIC_TAB.id}`),
    ).toBeNull();
  });
});

/**
 * The top strip's hover card converged onto the vertical strip's own
 * `HoverCard` primitive (fix/layout-regression-and-improvements): same rich
 * body, same gating. These mirror `side-tab-row.test.tsx`'s hover-card
 * coverage for the horizontal strip's own `TabItem`.
 */
function hoverCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-slot="hover-card-content"]',
  );
}

/** Dwells over the tab's title trigger - the hover card's only anchor. */
function dwellOverTitle(): void {
  const title = screen.getByTestId(`tab-title-${EPIC_TAB.kind}-${EPIC_TAB.id}`);
  const trigger = title.parentElement;
  if (trigger === null) throw new Error("expected a hover card trigger");
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.mouseEnter(trigger);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
}

function renderTabItem(): Promise<void> {
  const input = makeInput();
  return renderInApp(
    <TabItem
      {...input}
      chrome="own"
      includeMotionFrame={false}
      offsetX={0}
      showSeparatorAfter={false}
      showDropIndicatorBefore={false}
      showDropIndicatorAfter={false}
    />,
    IDLE_LEADER,
    NO_PROMPT_LIT_INDICATORS,
  );
}

describe("TabItem hover card", () => {
  it("opens the vertical strip's rich hover card body on hover", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderTabItem();
    dwellOverTitle();
    const card = hoverCard();
    expect(
      card?.querySelector('[data-testid="side-tab-hover-card-body"]'),
    ).not.toBeNull();
    expect(card?.textContent).toContain("Row task");
  });

  it("keeps the hover card closed while the tab is being renamed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Row task",
      userId: null,
      hostId: "host-a",
      writes: [],
    });
    await renderTabItem();
    const row = await screen.findByTestId(`tab-epic-${EPIC_TAB.id}`);
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Edit Title"));
    await screen.findByTestId(`tab-title-input-epic-${EPIC_TAB.id}`);
    // The rename input replaces the title trigger outright, so there is
    // nothing left to hover into a card - dwelling on the row itself must
    // not conjure one either.
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    fireEvent.mouseEnter(row);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(hoverCard()).toBeNull();
  });

  it("keeps the hover card closed while a pair-merge preview targets this tab", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderTabItem();
    useEpicDndStore.getState().topLevelStripPairPreviewChanged({
      targetRef: { kind: EPIC_TAB.kind, id: EPIC_TAB.id },
      side: "left",
    });
    dwellOverTitle();
    expect(hoverCard()).toBeNull();
  });
});
