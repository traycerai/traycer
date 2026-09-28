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
import * as Y from "yjs";
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
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";
import type { HeaderTab } from "@/stores/tabs/types";

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
  epics: { [EPIC_ID]: EMPTY_NOTIFICATION_INDICATOR_STATE },
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

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function snapshotMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Row task",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "owner",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

/**
 * A live epic session an owner can rename, whose write commands land in
 * `writes`. Transport opens before the snapshot so the command queue has a
 * fresh root snapshot to send behind.
 */
function registerEditableEpic(writes: EpicWriteCommandIntent[]): void {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: (_commandId, intent) => {
      writes.push(intent);
      return Promise.resolve({ hostId: "host-a" });
    },
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onConnectionStatus("open", null, false);
  captured.value.onSnapshot(snapshotMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () => handle);
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ status: "signed-out" });
  __getOpenEpicRegistryForTests().disposeAll();
  disposeAllChatSessions();
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
    act(() => {
      fireEvent.pointerUp(row, { pointerId: 1, clientX: 40, clientY: 10 });
    });
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
    registerEditableEpic(writes);
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
    expect(
      screen.queryByTestId(`tab-title-input-epic-${EPIC_TAB.id}`),
    ).toBeNull();
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
