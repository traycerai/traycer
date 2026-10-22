import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { chatRecordSchema } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ContinueOnOpencodeTwoTabMenu } from "@/components/epic-canvas/canvas/continue-on-opencode-two-menu";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const hoisted = vi.hoisted(() => ({
  mutate: vi.fn(),
  createChatVersion: null as { major: number; minor: number } | null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: (): SchemaVersion | null =>
    hoisted.createChatVersion,
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    mutate: hoisted.mutate,
    isPending: false,
  }),
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

async function openMenu(): Promise<void> {
  render(
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
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId("tab"));
  await screen.findByRole("menu");
}

describe("ContinueOnOpencodeTwoTabMenu", () => {
  beforeEach(() => {
    hoisted.createChatVersion = { major: 1, minor: 3 };
  });
  afterEach(() => {
    cleanup();
    hoisted.mutate.mockReset();
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

  it("creates a clone from the latest boundary on line 2 and keeps the source", async () => {
    openSession({ opencodeLine: 1 });
    await openMenu();
    fireEvent.click(screen.getByText("Continue on OpenCode 2"));

    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
    expect(hoisted.mutate.mock.calls[0]?.[0]).toMatchObject({
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
  });
});
