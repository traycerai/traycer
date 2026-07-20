import "../../../../__tests__/test-browser-apis";

const useHostNotificationIndicatorsMock = vi.hoisted(() =>
  vi.fn(() => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  })),
);
vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: useHostNotificationIndicatorsMock,
}));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { AGENT_WORKING_AWARENESS_FIELD } from "@traycer/protocol/host/epic/subscribe";
import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { SplitDirection } from "@/stores/epics/canvas/types";
import { TestEpicSessionWrapper } from "./test-epic-session";
import { createEpicSessionTestHarness } from "./test-epic-session-harness";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

// `EpicSessionProvider` opens its own durable transport via this factory, but
// the test installs an `__setEpicStreamClientFactoryForTests` override that
// short-circuits before `openTransport` runs - so a stable stub opener that is
// never invoked lets the provider mount without the full host runtime.
const openTransportStub = vi.hoisted(() => () => {
  throw new Error("openTransport must not be called in this test");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
}));

// Terminal titles resolve through the tab's bound-host client; these tests
// assert chat/artifact titles outside a <HostRuntimeProvider>, so stub the
// host seam (a null client keeps the terminal.list query disabled).
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: () => undefined }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: (_element: HTMLElement | null) => undefined,
    listeners: {},
    isDragging: false,
  }),
  useDroppable: () => ({
    setNodeRef: (_element: HTMLElement | null) => undefined,
  }),
}));

// Intentionally do not mock ChatProgressIcon: title-generation composition
// must exercise real running / notification / idle-default precedence.

const EPIC_ID = "epic-tab-strip-title";
const CHAT_ID = "chat-1";
const GROUP_ID = "group-1";
// These tests assert titles/tooltips/spinners, not activation state, so the
// canvas store is left unseeded - `useTabActivation` returns all-false here.
const VIEW_TAB_ID = "view-tab-1";
const TAB = {
  id: CHAT_ID,
  instanceId: "inst-chat-1",
  type: "chat" as const,
  name: "New chat",
  hostId: "host-test",
};

const harness = createEpicSessionTestHarness(EPIC_ID);
let queryClient: QueryClient;

function seedDocWithChat(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();
  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ID);
  chat.set("title", "New chat");
  chat.set("parentId", null);
  chat.set("createdAt", 0);
  chat.set("updatedAt", 0);
  chat.set("messages", new Y.Array<unknown>());
  chats.set(CHAT_ID, chat);
  epic.set("title", "Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
}

function renderTabStrip(tab: typeof TAB, canRenameTabs: boolean): void {
  const onSelectTab = vi.fn<(groupId: string, tabId: string) => void>();
  const onCloseTab = vi.fn<(groupId: string, tabId: string) => void>();
  const onPromotePreview = vi.fn<(groupId: string) => void>();
  const onSplit = vi.fn<(groupId: string, direction: SplitDirection) => void>();
  const onCloseGroup = vi.fn<(groupId: string) => void>();
  const onOpenBlankTab = vi.fn<(groupId: string) => void>();
  const onMenuTab = vi.fn<(groupId: string, tabId: string) => void>();
  const onMenuGroup = vi.fn<(groupId: string) => void>();
  const onMenuSplit =
    vi.fn<
      (
        groupId: string,
        tabId: string,
        axis: SplitDirection,
        leading: boolean,
      ) => void
    >();
  const onRevealInSidebar = vi.fn<(tabId: string) => void>();

  render(
    <QueryClientProvider client={queryClient}>
      <TestEpicSessionWrapper epicId={EPIC_ID}>
        <TabStrip
          epicId={EPIC_ID}
          tabId={VIEW_TAB_ID}
          groupId={GROUP_ID}
          tabs={[tab]}
          activeTabId={tab.instanceId}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onPromotePreview={onPromotePreview}
          onSplit={onSplit}
          onCloseGroup={onCloseGroup}
          onOpenBlankTab={onOpenBlankTab}
          canRenameTabs={canRenameTabs}
          menuHandlers={{
            onClose: onMenuTab,
            onCloseOthers: onMenuTab,
            onCloseRight: onMenuTab,
            onCloseAll: onMenuGroup,
            onSplit: onMenuSplit,
            onRevealInSidebar,
            onRename: () => undefined,
          }}
        />
      </TestEpicSessionWrapper>
    </QueryClientProvider>,
  );
}

async function flushEpicSnapshot(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function markChatWorking(): void {
  const handle = __getOpenEpicRegistryForTests().get(EPIC_ID);
  if (handle === null) throw new Error("expected open epic handle");
  handle.awareness.setLocalState({
    [AGENT_WORKING_AWARENESS_FIELD]: [CHAT_ID],
  });
}

describe("TabStrip title", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    harness.install(seedDocWithChat, "owner");
    useHostNotificationIndicatorsMock.mockReturnValue({
      data: { epics: {}, chats: {} },
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => Promise.resolve(),
    });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    harness.teardown();
    useEpicCanvasStore.getState().clearAllTitleGenerationPending();
  });

  it("renders projected artifact titles over the canvas tab's opening name", async () => {
    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(screen.getAllByRole("tab", { name: "New chat" })).toHaveLength(1);

    const handle = __getOpenEpicRegistryForTests().get(EPIC_ID);
    if (handle === null) throw new Error("expected open epic handle");
    act(() => {
      handle.store.getState().renameArtifact(CHAT_ID, "Generated title");
    });

    await waitFor(() => {
      expect(
        screen.getAllByRole("tab", { name: "Generated title" }),
      ).toHaveLength(1);
    });
    expect(screen.queryAllByRole("tab", { name: "New chat" })).toHaveLength(0);
    expect(screen.getByLabelText("Close Generated title")).not.toBeNull();
  });

  it("adds a tooltip trigger to the canvas tab title", async () => {
    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    const tab = screen.getByTestId(`tab-item-${TAB.instanceId}`);
    const title = screen.getByTestId(`tab-title-${TAB.instanceId}`);

    expect(tab.getAttribute("data-slot")).not.toBe("tooltip-trigger");
    expect(title.getAttribute("data-slot")).toBe("tooltip-trigger");
  });

  it("shows a spinner while chat title generation is pending", async () => {
    useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "New chat");

    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(
      screen.getByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeTruthy();
  });

  it("shows running chat status over the title spinner on first-send overlap", async () => {
    useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "New chat");

    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(
      screen.getByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeTruthy();

    act(() => {
      markChatWorking();
    });

    await waitFor(() => {
      expect(
        screen.getByTestId(`chat-tab-spinner-activity-${CHAT_ID}`),
      ).toBeTruthy();
    });
    expect(screen.getByTitle("Chat in progress")).toBeTruthy();
    expect(
      screen.queryByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeNull();
  });

  it("shows the chat's pending-approval status instead of the title spinner", async () => {
    useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "New chat");
    useHostNotificationIndicatorsMock.mockReturnValue({
      data: {
        epics: {},
        chats: {
          [CHAT_ID]: {
            pendingApproval: true,
            pendingInterview: false,
            unreadFailure: false,
            unreadDone: false,
          },
        },
      },
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => Promise.resolve(),
    });

    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(
      screen.queryByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeNull();
    expect(
      screen.getByTestId(`chat-tab-spinner-approval-${CHAT_ID}`),
    ).toBeTruthy();
  });

  it("shows the chat's pending-interview status instead of the title spinner", async () => {
    useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "New chat");
    useHostNotificationIndicatorsMock.mockReturnValue({
      data: {
        epics: {},
        chats: {
          [CHAT_ID]: {
            pendingApproval: false,
            pendingInterview: true,
            unreadFailure: false,
            unreadDone: false,
          },
        },
      },
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => Promise.resolve(),
    });

    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(
      screen.queryByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeNull();
    expect(
      screen.getByTestId(`chat-tab-spinner-interview-${CHAT_ID}`),
    ).toBeTruthy();
  });

  it("shows the chat's unread-failure status instead of the title spinner", async () => {
    useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "New chat");
    useHostNotificationIndicatorsMock.mockReturnValue({
      data: {
        epics: {},
        chats: {
          [CHAT_ID]: {
            pendingApproval: false,
            pendingInterview: false,
            unreadFailure: true,
            unreadDone: false,
          },
        },
      },
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => Promise.resolve(),
    });

    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(
      screen.queryByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeNull();
    expect(
      screen.getByTestId(`chat-tab-spinner-failure-${CHAT_ID}`),
    ).toBeTruthy();
  });

  it("shows the chat's unread-done status instead of the title spinner", async () => {
    useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "New chat");
    useHostNotificationIndicatorsMock.mockReturnValue({
      data: {
        epics: {},
        chats: {
          [CHAT_ID]: {
            pendingApproval: false,
            pendingInterview: false,
            unreadFailure: false,
            unreadDone: true,
          },
        },
      },
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => Promise.resolve(),
    });

    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(
      screen.queryByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeNull();
    expect(screen.getByTestId(`chat-tab-spinner-done-${CHAT_ID}`)).toBeTruthy();
  });

  it("clears chat title spinner when generation completes with the same title", async () => {
    useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "New chat");

    renderTabStrip(TAB, true);
    await flushEpicSnapshot();

    expect(
      screen.getByTestId(`tab-title-generating-${TAB.instanceId}`),
    ).toBeTruthy();

    const handle = __getOpenEpicRegistryForTests().get(EPIC_ID);
    if (handle === null) throw new Error("expected open epic handle");
    act(() => {
      const chats = handle.doc.getMap<unknown>("epic").get("chats");
      if (!(chats instanceof Y.Map)) {
        throw new Error("expected chats map");
      }
      const chat: unknown = chats.get(CHAT_ID);
      if (!(chat instanceof Y.Map)) {
        throw new Error("expected chat map");
      }
      chat.set("updatedAt", Date.now() + 1_000);
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId(`tab-title-generating-${TAB.instanceId}`),
      ).toBeNull();
    });
  });

  it("hides the canvas tab edit-title menu item when title edits are disabled", async () => {
    renderTabStrip(TAB, true);
    await flushEpicSnapshot();
    fireEvent.contextMenu(screen.getByTestId(`tab-item-${TAB.instanceId}`));

    expect(await screen.findByText("Edit Title")).not.toBeNull();
    cleanup();

    renderTabStrip(TAB, false);
    await flushEpicSnapshot();
    fireEvent.contextMenu(screen.getByTestId(`tab-item-${TAB.instanceId}`));

    expect(screen.queryByText("Edit Title")).toBeNull();
  });
});
