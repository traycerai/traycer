import "../../../../__tests__/test-browser-apis";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as Y from "yjs";
import type { ComponentProps } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatStreamClient } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import { ChatTile } from "@/components/epic-canvas/renderers/chat-tile";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  __setChatStreamClientFactoryForTests,
} from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { installLegendListViewportMetrics } from "@/components/chat/__tests__/legend-list-test-environment";
import { TestEpicSessionWrapper } from "./test-epic-session";
import { createEpicSessionTestHarness } from "./test-epic-session-harness";
import { resetFocusedComposerControlsForTests } from "@/lib/commands/composer-controls-registry";

/**
 * Decision 14 real ChatTile edit arm:
 * mount ChatTile → open queue-row edit → drive the actual submitMessage path
 * (queueEdit + queueSteerNow for after_safe_point vs queueEdit +
 * queueSettingsUpdate for auto). Captures the tile's onSubmitMessage so
 * deliveryPolicy can be driven without TipTap DOM key events under jsdom.
 * A change to chat-tile.tsx's edit branch fails these assertions.
 */

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: (props: {
      readonly surface: { readonly bindingResolved: boolean };
    }) => (
      <div
        data-testid="host-workspace-selector"
        data-binding-resolved={String(props.surface.bindingResolved)}
      />
    ),
    ActiveHostWorkspaceControls: () => null,
  }),
);

const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  onChange: () => () => undefined,
};
const MOCK_HOST_ENTRY = {
  hostId: "host-test",
  label: "Test host",
  kind: "local" as const,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  streamUrl: "ws://127.0.0.1:1/stream",
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: (hostId: string) =>
    hostId === MOCK_HOST_ENTRY.hostId ? MOCK_HOST_ENTRY : null,
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
}));

const submitCapture: {
  onSubmitMessage: ((input: ChatComposerSubmitInput) => boolean) | null;
} = {
  onSubmitMessage: null,
};

vi.mock("@/components/chat/composer/chat-composer", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/components/chat/composer/chat-composer")
    >();
  function ChatComposerCapture(
    props: ComponentProps<typeof actual.ChatComposer>,
  ) {
    submitCapture.onSubmitMessage = props.onSubmitMessage;
    return <actual.ChatComposer {...props} />;
  }
  return {
    ...actual,
    ChatComposer: ChatComposerCapture,
  };
});

const EPIC_ID = "epic-queue-edit-steer";
const CHAT_ARTIFACT = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat" as const,
  name: "Chat 1",
  hostId: "host-test",
};
const QUEUED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "edited queue item" }],
    },
  ],
};
const QUEUED_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const epicHarness = createEpicSessionTestHarness(EPIC_ID);
const chatHarness = createChatHarness();

function seedDocWithChat(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();
  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ARTIFACT.id);
  chat.set("title", CHAT_ARTIFACT.name);
  chat.set("parentId", null);
  chat.set("createdAt", 0);
  chat.set("updatedAt", 0);
  const messages = new Y.Array<unknown>();
  messages.push([
    {
      role: "user",
      content: "Host chat content",
      timestamp: 1,
    },
  ]);
  chat.set("messages", messages);
  chats.set(CHAT_ARTIFACT.id, chat);
  epic.set("title", "Epic Queue Edit Steer");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", chats);
}

function createChatHarness(): {
  readonly sent: ChatSubscribeClientFrame[];
  install(
    access: "owner" | "viewer",
    queueItems: ReadonlyArray<ChatQueuedItem>,
  ): void;
  callbacks(): ChatStreamCallbacks;
  teardown(): void;
} {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  return {
    sent,
    install: (access, queueItems) => {
      __setChatStreamClientFactoryForTests(
        (_epicId, _chatId, nextCallbacks) => {
          callbacks = nextCallbacks;
          setTimeout(() => {
            nextCallbacks.onConnectionStatus("open", null);
            emitChatSnapshot(nextCallbacks, access, queueItems);
          }, 0);
          const client: Pick<
            ChatStreamClient,
            "sendAction" | "close" | "sameTurnSteeringProtocolSupported"
          > = {
            sendAction: (frame) => {
              sent.push(frame);
            },
            sameTurnSteeringProtocolSupported: () => true,
            close: () => undefined,
          };
          return client;
        },
      );
    },
    callbacks: () => {
      if (callbacks === null) throw new Error("expected chat callbacks");
      return callbacks;
    },
    teardown: () => {
      __setChatStreamClientFactoryForTests(null);
      __getChatSessionRegistryForTests().disposeAll();
      sent.length = 0;
      callbacks = null;
      submitCapture.onSubmitMessage = null;
    },
  };
}

function emitChatSnapshot(
  callbacks: ChatStreamCallbacks,
  access: "owner" | "viewer",
  queueItems: ReadonlyArray<ChatQueuedItem>,
): void {
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ARTIFACT.id,
    snapshot: {
      chat: {
        id: CHAT_ARTIFACT.id,
        parentId: null,
        userId: "owner-1",
        hostId: "host-test",
        title: CHAT_ARTIFACT.name,
        createdAt: 0,
        updatedAt: 0,
        archivedAt: null,
        isTitleEditedByUser: false,
        settings: QUEUED_SETTINGS,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [
          {
            role: "user",
            messageId: "message-1",
            sender: { type: "user", userId: "owner-1" },
            message: {
              kind: "user",
              content: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Host chat content" }],
                  },
                ],
              },
            },
            timestamp: 1,
            sessionAnchor: null,
          },
        ],
        events: [],
      },
      access: {
        role: access,
        ownerUserId: "owner-1",
        canAct: access === "owner",
      },
      queue: { status: "idle", items: [...queueItems] },
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: true,
        turnId: "turn-1",
        status: "running",
        harnessId: QUEUED_SETTINGS.harnessId,
        model: QUEUED_SETTINGS.model,
        profileId: null,
        userMessageId: "message-active",
        startedAt: 1,
        updatedAt: 1,
        reasoningEffort: QUEUED_SETTINGS.reasoningEffort,
        serviceTier: QUEUED_SETTINGS.serviceTier,
      },
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: {
        entries: [
          {
            workspacePath: "/Users/test/project",
            mode: "local",
            repoIdentifier: null,
            worktreePath: null,
            branch: "main",
            isPrimary: true,
            isImported: false,
            setupState: "not_required",
            setupTerminalSessionId: null,
            setupExitCode: null,
            setupFailedAt: null,
            createdAt: 1,
            ownedSubmodules: [],
          },
        ],
      },
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
    },
  });
}

beforeEach(() => {
  installLegendListViewportMetrics();
  window.localStorage.clear();
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "owner-1",
      userName: "Owner",
      email: "owner@example.com",
    },
    contextMetadata: { userId: "owner-1", username: "Owner" },
  });
  useComposerDraftStore.setState({ drafts: {} });
  useComposerRunSettingsStore.getState().resetForTests();
  useComposerHarnessMemoryStore.getState().resetForTests();
  useSettingsStore.setState({
    steerOnModEnterEnabled: true,
    defaultSelection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
  });
  resetFocusedComposerControlsForTests();
  submitCapture.onSubmitMessage = null;
  epicHarness.install(seedDocWithChat, "editor");
  chatHarness.install("owner", []);
});

afterEach(() => {
  cleanup();
  chatHarness.teardown();
  epicHarness.teardown();
  __getOpenEpicRegistryForTests().disposeAll();
  resetFocusedComposerControlsForTests();
});

describe("chat-tile queue edit save-and-steer routing (decision 14)", () => {
  it("routes after_safe_point edit submit to queueEdit + queueSteerNow via real ChatTile submitMessage", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt",
        queueItemId: "queue-steer-edit",
        messageId: "message-queue-steer-edit",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(submitCapture.onSubmitMessage).not.toBeNull();
    });

    const onSubmitMessage = submitCapture.onSubmitMessage;
    if (onSubmitMessage === null) {
      throw new Error("expected ChatTile to wire onSubmitMessage");
    }

    act(() => {
      const accepted = onSubmitMessage({
        content: QUEUED_CONTENT,
        contentText: "edited queue item",
        attachments: [],
        settings: QUEUED_SETTINGS,
        deliveryPolicy: "after_safe_point",
      });
      expect(accepted).toBe(true);
    });

    expect(chatHarness.sent.map((frame) => frame.kind)).toEqual([
      "queueEdit",
      "queueSteerNow",
    ]);
    expect(chatHarness.sent[0]).toMatchObject({
      kind: "queueEdit",
      queueItemId: "queue-steer-edit",
      content: QUEUED_CONTENT,
    });
    const steerFrame = chatHarness.sent.find(
      (
        frame,
      ): frame is Extract<
        ChatSubscribeClientFrame,
        { readonly kind: "queueSteerNow" }
      > => frame.kind === "queueSteerNow",
    );
    if (steerFrame === undefined) {
      throw new Error("Expected queueSteerNow frame");
    }
    expect(steerFrame.queueItemId).toBe("queue-steer-edit");
    expect(steerFrame.newSettings).toMatchObject({
      harnessId: "claude",
      model: "claude-sonnet",
    });
  });

  it("routes auto edit submit to queueEdit + queueSettingsUpdate via real ChatTile submitMessage", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        kind: "prompt",
        queueItemId: "queue-edit",
        messageId: "message-queue-edit",
        message: {
          kind: "user",
          content: QUEUED_CONTENT,
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(submitCapture.onSubmitMessage).not.toBeNull();
    });

    const onSubmitMessage = submitCapture.onSubmitMessage;
    if (onSubmitMessage === null) {
      throw new Error("expected ChatTile to wire onSubmitMessage");
    }

    act(() => {
      const accepted = onSubmitMessage({
        content: QUEUED_CONTENT,
        contentText: "edited queue item",
        attachments: [],
        settings: QUEUED_SETTINGS,
        deliveryPolicy: "auto",
      });
      expect(accepted).toBe(true);
    });

    expect(chatHarness.sent.map((frame) => frame.kind)).toEqual([
      "queueEdit",
      "queueSettingsUpdate",
    ]);
    expect(
      chatHarness.sent.some((frame) => frame.kind === "queueSteerNow"),
    ).toBe(false);
  });
});

function renderChatTile(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <TestRouterProvider>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={
            new MockRunnerHost({
              signInUrl: "https://example.com",
              authnBaseUrl: "https://auth.example.com",
              localHost: null,
              hosts: [],
              workspaceFolderPickerPaths: undefined,
              hasLocalHost: undefined,
              traycerCli: undefined,
            })
          }
        >
          <TooltipProvider>
            <TestEpicSessionWrapper epicId={EPIC_ID}>
              <TabHostProvider hostId={CHAT_ARTIFACT.hostId}>
                <ChatTile
                  node={CHAT_ARTIFACT}
                  viewTabId="tab-queue-edit-steer"
                  isActive
                />
              </TabHostProvider>
            </TestEpicSessionWrapper>
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>,
  );
}

async function waitForChatTileLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByTestId("chat-tile-loading")).toBeNull();
  });
  await waitFor(() => {
    expect(screen.getByTestId("queued-message-rows")).not.toBeNull();
  });
}
