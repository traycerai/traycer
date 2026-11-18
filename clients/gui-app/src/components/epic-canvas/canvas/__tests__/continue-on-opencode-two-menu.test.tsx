import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { chatRecordSchema } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ContinueOnOpencodeTwoTabMenu } from "@/components/epic-canvas/canvas/continue-on-opencode-two-menu";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const hoisted = vi.hoisted(() => ({
  // The host RPC boundary: the real create hook and a real QueryClient sit
  // above it, so a pending create is visible across a menu remount.
  request: vi.fn(),
  openWhenProjected: vi.fn(
    (_args: { readonly intent: unknown }) => () => undefined,
  ),
  createChatVersion: null as { major: number; minor: number } | null,
  setSelectionVersion: { major: 2, minor: 2 } as {
    major: number;
    minor: number;
  } | null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    getActiveHostId: () => "host-1",
    request: hoisted.request,
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: (
    _hostId: string | null,
    method: string,
  ): SchemaVersion | null =>
    method === "providers.setSelection"
      ? hoisted.setSelectionVersion
      : hoisted.createChatVersion,
}));
vi.mock("@/lib/commands/actions/new-chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commands/actions/new-chat")>()),
  openCreatedChatWhenProjectedWithNavigation: hoisted.openWhenProjected,
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));

const registry = getChatSessionRegistry();

function chatRecord(overrides: Record<string, unknown>) {
  return chatRecordSchema.parse({
    id: "chat-1",
    parentId: null,
    userId: "user-1",
    hostId: "host-1",
    title: "A chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: {
      ultracode: false,
      harnessId: "opencode",
      model: "m",
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    },
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
    ...overrides,
  });
}

function openSession(overrides: Record<string, unknown>): void {
  const handle = registry.acquire(
    {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-1",
      scopeKey: "continue-menu",
    },
    () =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: "host-1",
        epicId: "epic-1",
        chatId: "chat-1",
        userId: "user-1",
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
  handle.store.setState({ chat: chatRecord(overrides) });
}

let queryClient = new QueryClient();

function renderMenu() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ContextMenu>
        <ContextMenuTrigger>
          <span data-testid="tab">tab</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContinueOnOpencodeTwoTabMenu
            epicId="epic-1"
            chatId="chat-1"
            hostId="host-1"
            tabId="tab-1"
          />
        </ContextMenuContent>
      </ContextMenu>
    </QueryClientProvider>,
  );
}

async function openMenu(): Promise<void> {
  renderMenu();
  fireEvent.contextMenu(screen.getByTestId("tab"));
  await screen.findByRole("menu");
}

describe("ContinueOnOpencodeTwoTabMenu", () => {
  beforeEach(() => {
    queryClient = new QueryClient();
    hoisted.createChatVersion = { major: 1, minor: 3 };
    hoisted.setSelectionVersion = { major: 2, minor: 2 };
  });
  afterEach(() => {
    cleanup();
    hoisted.request.mockReset();
    hoisted.openWhenProjected.mockClear();
    registry.disposeAll();
  });

  it("is offered for a 1.x OpenCode chat on a host with epic.createChat 1.3", async () => {
    openSession({ opencodeLine: 1 });
    await openMenu();
    expect(screen.getByText("Continue on OpenCode 2")).toBeDefined();
  });

  it("is offered for a pre-line OpenCode chat, which runs 1.x", async () => {
    openSession({
      activeSessionChain: {
        harnessId: "opencode",
        sessionId: "s-1",
        sessionWorkspaceSnapshot: {
          workspaceKind: "session-snapshot",
          primaryWorkspace: "/work",
          secondaryWorkspaces: [],
        },
      },
    });
    await openMenu();
    expect(screen.getByText("Continue on OpenCode 2")).toBeDefined();
  });

  it.each([
    ["a chat already on 2.x", { opencodeLine: 2 }, { major: 1, minor: 3 }],
    [
      "a host below epic.createChat 1.3",
      { opencodeLine: 1 },
      { major: 1, minor: 2 },
    ],
    ["a host with no epic.createChat version", { opencodeLine: 1 }, null],
    [
      "a chat on another harness",
      {
        opencodeLine: 1,
        settings: {
          ultracode: false,
          harnessId: "claude",
          model: "m",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        },
      },
      { major: 1, minor: 3 },
    ],
  ])("is hidden for %s", async (_label, overrides, version) => {
    hoisted.createChatVersion = version;
    openSession(overrides);
    await openMenu();
    expect(screen.queryByText("Continue on OpenCode 2")).toBeNull();
  });

  it("is hidden on a host whose providers.setSelection moves existing chats", async () => {
    hoisted.setSelectionVersion = { major: 2, minor: 3 };
    openSession({ opencodeLine: 1 });
    await openMenu();
    expect(screen.queryByText("Continue on OpenCode 2")).toBeNull();
  });

  it("creates a clone from the latest boundary on line 2, and opens it after the menu has closed", async () => {
    const created = Promise.withResolvers<{ chatId: string }>();
    hoisted.request.mockReturnValue(created.promise);
    openSession({ opencodeLine: 1 });
    await openMenu();
    fireEvent.click(screen.getByText("Continue on OpenCode 2"));

    // The real mutation awaits its `onMutate` before it dispatches.
    await waitFor(() => {
      expect(hoisted.request).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.request.mock.calls[0]?.[0]).toBe("epic.createChat");
    expect(hoisted.request.mock.calls[0]?.[1]).toMatchObject({
      epicId: "epic-1",
      hostId: "host-1",
      title: "A chat (OpenCode 2)",
      forkSource: {
        boundary: "latest",
        sourceChatId: "chat-1",
        sourceOwnerUserId: "user-1",
      },
      opencodeLine: 2,
    });

    // The menu is gone before the host answers, as it is in the app.
    cleanup();
    created.resolve({ chatId: "chat-2" });
    await waitFor(() => {
      expect(hoisted.openWhenProjected).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.openWhenProjected.mock.calls[0]).toMatchObject([
      { intent: { chatId: "chat-2", hostId: "host-1" } },
    ]);
  });

  it("blocks a second clone from a remounted menu while the first create is pending, and allows one after it settles", async () => {
    const first = Promise.withResolvers<{ chatId: string }>();
    hoisted.request.mockReturnValueOnce(first.promise);
    openSession({ opencodeLine: 1 });
    await openMenu();
    fireEvent.click(screen.getByText("Continue on OpenCode 2"));
    await waitFor(() => {
      expect(hoisted.request).toHaveBeenCalledTimes(1);
    });

    // Picking the item unmounts the menu; the create keeps running on the
    // shared QueryClient, so the next menu has to see it.
    cleanup();
    await openMenu();
    const item = screen.getByRole("menuitem", {
      name: /Continue on OpenCode 2/,
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);

    first.resolve({ chatId: "chat-2" });
    await waitFor(() => {
      expect(queryClient.isMutating({ mutationKey: ["epic.createChat"] })).toBe(
        0,
      );
    });
    // Settled: the click on the disabled item never made a second create.
    expect(hoisted.request).toHaveBeenCalledTimes(1);

    cleanup();
    hoisted.request.mockResolvedValueOnce({ chatId: "chat-3" });
    await openMenu();
    const retry = screen.getByRole("menuitem", {
      name: /Continue on OpenCode 2/,
    });
    expect(retry.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => {
      expect(hoisted.request).toHaveBeenCalledTimes(2);
    });
  });

  it("stays enabled while a create for another source chat is pending", async () => {
    const other = Promise.withResolvers<{ chatId: string }>();
    hoisted.request.mockReturnValueOnce(other.promise);
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        // The mocked client hook hands back the same fake the menu uses.
        useEpicCreateChatForHostClient(useHostClientForHostId("host-1")),
      { wrapper },
    );
    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        parentId: null,
        hostId: "host-1",
        title: "Another chat (OpenCode 2)",
        chatId: "chat-9",
        forkSource: {
          boundary: "latest",
          sourceChatId: "chat-8",
          sourceOwnerUserId: "user-1",
        },
        opencodeLine: 2,
      });
    });
    await waitFor(() => {
      expect(hoisted.request).toHaveBeenCalledTimes(1);
    });
    expect(queryClient.isMutating({ mutationKey: ["epic.createChat"] })).toBe(
      1,
    );

    openSession({ opencodeLine: 1 });
    await openMenu();
    const item = screen.getByRole("menuitem", {
      name: /Continue on OpenCode 2/,
    });
    expect(item.getAttribute("aria-disabled")).toBeNull();

    other.resolve({ chatId: "chat-9" });
    await waitFor(() => {
      expect(queryClient.isMutating({ mutationKey: ["epic.createChat"] })).toBe(
        0,
      );
    });
  });
});
