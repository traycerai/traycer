import { TestRouterProvider } from "@/__tests__/with-test-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as Y from "yjs";
import type { ComponentProps } from "react";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatStreamClientHandle } from "@/stores/chats/chat-session-store";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatComposerSideChatInput,
  ChatComposerSubmitInput,
} from "@/components/chat/composer/chat-composer";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { ChatTile } from "@/components/epic-canvas/renderers/chat-tile";
import { pendingSend } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  queueEditStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
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
 * The real ChatTile edit arm:
 * mount ChatTile → open queue-row edit → drive the actual submitMessage path
 * (queueEdit + queueSteerNow for after_safe_point vs queueEdit +
 * queueSettingsUpdate for auto). Captures the tile's onSubmitMessage so
 * deliveryPolicy can be driven without TipTap DOM key events under jsdom.
 * A change to chat-tile.tsx's edit branch fails these assertions.
 */

const selectorCapture: { editSessionId: string | null } = {
  editSessionId: null,
};

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: (props: {
      readonly surface: {
        readonly bindingResolved: boolean;
        readonly queueEdit: { readonly editSessionId: string } | null;
      };
    }) => {
      // The edit's session id is the key of the slot its picks stage into.
      selectorCapture.editSessionId =
        props.surface.queueEdit?.editSessionId ?? null;
      return (
        <div
          data-testid="host-workspace-selector"
          data-binding-resolved={String(props.surface.bindingResolved)}
        />
      );
    },
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

// ENUMERATES deliberately - do NOT convert to an `importOriginal` spread.
// `@/lib/host` is a barrel of provider-coupled hooks, so the un-overridden
// residue is not inert: spreading leaks the real `useAuthService` into
// `EpicSessionProvider` -> `useStreamAuthRevalidator`, which throws "Host
// runtime hooks must be used inside a <HostRuntimeProvider>" from deep inside
// an unrelated component (~55 tests across these files). Enumeration fails the
// useful way instead: vitest names the missing export and the module.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useOptionalHostClient: () => MOCK_HOST_CLIENT,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
  // The SPINE, a separate export.
  useHostRuntimeClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: (
      request: CreateChatMutationInput,
      callbacks: CreateChatCallbacksCapture,
    ) => {
      createChatCapture.calls.push({ request, callbacks });
    },
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

// Dictation reads the person's selected host through its own surface binding;
// these tiles do not exercise it.
vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  // No stream client means nothing has been negotiated yet, which is what
  // `null` says - the tile's Shells menu reads this and stays quiet.
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

/**
 * The slash-command lookups the tile makes for its own send paths (next-step
 * prompts, compaction, a sent message's inline edit) pass
 * `NO_LOCAL_SLASH_COMMANDS`; the composer passes its own commands. Recording
 * the former's working directories is how the tests read where the tile looks
 * those commands up. A host that answered `agent.gui.listCommands` per
 * directory would need a request harness this suite does not have.
 */
const tileSlashLookups: { workingDirectories: ReadonlyArray<string> }[] = [];
vi.mock("@/hooks/composer/use-slash-commands", async (importActual) => {
  const actual =
    await importActual<typeof import("@/hooks/composer/use-slash-commands")>();
  return {
    ...actual,
    useSlashCommands: (
      query: string,
      params: Parameters<typeof actual.useSlashCommands>[1],
    ) => {
      if (params.localCommands === actual.NO_LOCAL_SLASH_COMMANDS) {
        tileSlashLookups.push({
          workingDirectories: params.workingDirectories,
        });
      }
      return actual.useSlashCommands(query, params);
    },
  };
});

// The Epic session resolves its host through the selection authority's derived
// pointer, not the active-host projection above - seed the
// decider at its own name (the convention in epic-shell-usage-entry-point).
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-test",
}));

const submitCapture: {
  onSubmitMessage:
    | ((input: ChatComposerSubmitInput) => boolean | Promise<boolean>)
    | null;
  onSideChat: ((input: ChatComposerSideChatInput) => boolean) | null;
  mentionRoots: ReadonlyArray<string> | null;
  runWorkingDirectory: string | null;
} = {
  onSubmitMessage: null,
  onSideChat: null,
  mentionRoots: [],
  runWorkingDirectory: null,
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
    submitCapture.onSideChat = props.onSideChat;
    submitCapture.mentionRoots = props.mentionRoots;
    submitCapture.runWorkingDirectory = props.runWorkingDirectory;
    return <actual.ChatComposer {...props} />;
  }
  return {
    ...actual,
    ChatComposer: ChatComposerCapture,
  };
});

/**
 * `startSideChatFromComposer` (chat-tile.tsx) bridges `startSideChat`'s
 * `createChat` seam onto `useEpicCreateChatForHost().mutate` - capturing calls
 * here, instead of a bare `vi.fn()`, is what lets the tests below drive
 * success/failure by hand and assert what happens in between (decision 14
 * refinement: the queue's edit pill clears synchronously on accept; the
 * captured queue item is cancelled only from a successful create).
 */
interface CreateChatCallbacksCapture {
  readonly onSuccess: (result: {
    chatId: string;
    initialTurnStarted?: boolean;
  }) => void;
  readonly onError: (error: HostRpcError) => void;
}
interface CreateChatCall {
  readonly request: CreateChatMutationInput;
  readonly callbacks: CreateChatCallbacksCapture;
}
const createChatCapture: { calls: CreateChatCall[] } = { calls: [] };

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
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
const SIDE_CHAT_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "why is this slow?" }],
    },
  ],
};

function queuedPromptItem(
  queueItemId: string,
  content: JsonContent,
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId: `message-${queueItemId}`,
    message: { kind: "user", content, browserAnnotations: [] },
    sender: { type: "user", userId: "owner-1" },
    settings: QUEUED_SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 2,
    updatedAt: 2,
  };
}

// `@testing-library/jest-dom` (`toHaveAttribute`) is not wired into this
// repo's vitest setup (see `fallback-behavior-group.test.tsx`'s AX8 note) -
// read the attribute by hand instead.
function editingPillQueueItemId(): string | null {
  return screen
    .getByTestId("queue-edit-draft-pill")
    .getAttribute("data-queue-item-id");
}

function unrelatedCreateChatError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "host unreachable",
    requestId: "req-side-chat-cancel",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

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
            nextCallbacks.onConnectionStatus("open", null, null, null);
            emitChatSnapshot(nextCallbacks, access, queueItems);
          }, 0);
          const client: ChatStreamClientHandle = {
            sendAction: (frame) => {
              sent.push(frame);
            },
            sameTurnSteeringProtocolSupported: () => true,
            queuedWorktreeIntentProtocolSupported: () => true,
            draftBlobBridgeSupported: () => true,
            requestTranscriptRange: () => undefined,
            requestResnapshot: () => undefined,
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
      submitCapture.onSideChat = null;
      submitCapture.mentionRoots = [];
      submitCapture.runWorkingDirectory = null;
      selectorCapture.editSessionId = null;
    },
  };
}

const PROJECT_PATH = "/Users/test/project";
const LOCAL_FOLDER = { mode: "local", worktreePath: null } as const;
/** Whether the host's snapshot reports a turn under way. */
let chatTurnRunning = true;
/** The chat's shells, as the host's snapshot reports them. */
let chatShells: ReadonlyArray<ManagedCommand> = [];
/** How the chat's one bound folder is bound; a test may bind it to a worktree. */
let boundFolder: {
  readonly mode: "local" | "worktree";
  readonly worktreePath: string | null;
} = LOCAL_FOLDER;
/**
 * Message ids of queued prompts the host has begun: the snapshot's transcript
 * holds each, while its queue can still list the row.
 */
let begunQueuedMessageIds: ReadonlyArray<string> = [];

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
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
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
              browserAnnotations: [],
            },
            timestamp: 1,
            sessionAnchor: null,
          },
          ...begunQueuedMessageIds.map((messageId) => ({
            role: "user" as const,
            messageId,
            sender: { type: "user" as const, userId: "owner-1" },
            message: {
              kind: "user" as const,
              content: QUEUED_CONTENT,
              browserAnnotations: [],
            },
            timestamp: 3,
            sessionAnchor: null,
          })),
        ],
        events: [],
      },
      access: {
        role: access,
        ownerUserId: "owner-1",
        canAct: access === "owner",
      },
      queue: { status: "idle", items: [...queueItems] },
      runStatus: chatTurnRunning ? "running" : "idle",
      activeTurn: !chatTurnRunning
        ? null
        : {
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
            workspacePath: PROJECT_PATH,
            ...boundFolder,
            repoIdentifier: null,
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
      managedCommands: [...chatShells],
      heldUpdates: [],
      portForwards: [],
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
  submitCapture.onSideChat = null;
  createChatCapture.calls.length = 0;
  boundFolder = LOCAL_FOLDER;
  chatShells = [];
  begunQueuedMessageIds = [];
  chatTurnRunning = true;
  tileSlashLookups.length = 0;
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
          browserAnnotations: [],
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        sentFromHostId: null,
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
        restore: { content: QUEUED_CONTENT, browserAnnotations: [] },
        restartConfirmed: false,
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

  it("leaves a queue-edit steer unconfirmed when the composer did not ask, settings changed or not", async () => {
    // A harness that cannot steer mid-turn skips the composer's settings
    // dialog, so a changed model reaches here unconfirmed: the steer must go
    // out unconfirmed for the host to refuse it and the queue's dialog to ask.
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-steer-unasked", QUEUED_CONTENT),
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
        settings: { ...QUEUED_SETTINGS, model: "claude-opus" },
        deliveryPolicy: "after_safe_point",
        restore: { content: QUEUED_CONTENT, browserAnnotations: [] },
        restartConfirmed: false,
      });
      expect(accepted).toBe(true);
    });

    expect(
      chatHarness.sent.find((frame) => frame.kind === "queueSteerNow"),
    ).toMatchObject({
      queueItemId: "queue-steer-unasked",
      newSettings: { model: "claude-opus" },
      restartConfirmed: false,
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
          browserAnnotations: [],
        },
        sender: { type: "user", userId: "owner-1" },
        settings: QUEUED_SETTINGS,
        accountContext: { type: "PERSONAL" as const },
        sentFromHostId: null,
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
        restore: { content: QUEUED_CONTENT, browserAnnotations: [] },
        restartConfirmed: false,
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

/**
 * `startSideChatFromComposer` (chat-tile.tsx): `/btw` from a queue-row edit
 * must release the edit it started - the "Editing" pill clears SYNCHRONOUSLY
 * on accept (matching the composer's own immediate draft clear), and the
 * queue item captured at that moment is cancelled only once the create
 * actually SUCCEEDS. Cancellation reads the value captured at accept time,
 * never a live read of `editingQueueItemId` in the success callback, so a
 * delayed success can never clobber a NEW edit started while the create was
 * still pending.
 */
describe("chat-tile queue-edit /btw side chat cancellation (decision 14 refinement)", () => {
  it("clears the edit pill synchronously on accept and cancels the captured queue item only once the side chat create succeeds", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-edit-target", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-edit-target");
    });

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    // Cleared synchronously on accept - before the create has resolved at all.
    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    expect(createChatCapture.calls).toHaveLength(1);
    expect(chatHarness.sent.some((frame) => frame.kind === "queueCancel")).toBe(
      false,
    );

    act(() => {
      createChatCapture.calls[0].callbacks.onSuccess({
        chatId: "side-chat-1",
        initialTurnStarted: false,
      });
    });

    expect(chatHarness.sent).toContainEqual(
      expect.objectContaining({
        kind: "queueCancel",
        queueItemId: "queue-edit-target",
      }),
    );
  });

  it("does not cancel any queue item for an ordinary (non-edit) side chat", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-untouched", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    expect(createChatCapture.calls).toHaveLength(1);

    act(() => {
      createChatCapture.calls[0].callbacks.onSuccess({
        chatId: "side-chat-2",
        initialTurnStarted: false,
      });
    });

    expect(chatHarness.sent.some((frame) => frame.kind === "queueCancel")).toBe(
      false,
    );
  });

  it("retains the queued item (no cancellation) when the side chat create fails", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-retained", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-retained");
    });

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    // The pill still clears on accept, regardless of the eventual outcome -
    // the composer's own draft clears immediately too, independent of the
    // create's result.
    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();

    expect(createChatCapture.calls).toHaveLength(1);
    act(() => {
      createChatCapture.calls[0].callbacks.onError(unrelatedCreateChatError());
    });

    expect(chatHarness.sent.some((frame) => frame.kind === "queueCancel")).toBe(
      false,
    );
    // The queued item itself is untouched by the failed side chat.
    expect(
      screen.getByRole("button", { name: "Edit queued message" }),
    ).not.toBeNull();
  });

  it("does not let a stale side-chat success touch a NEW edit started while the create was pending", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem("queue-a", QUEUED_CONTENT),
      queuedPromptItem("queue-b", QUEUED_CONTENT),
    ]);

    renderChatTile();
    await waitForChatTileLoaded();

    const editButtons = (): HTMLElement[] =>
      screen.getAllByRole("button", { name: "Edit queued message" });

    fireEvent.click(editButtons()[0]);
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-a");
    });

    await waitFor(() => {
      expect(submitCapture.onSideChat).not.toBeNull();
    });
    const onSideChatForA = submitCapture.onSideChat;
    if (onSideChatForA === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      const accepted = onSideChatForA({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
      expect(accepted).toBe(true);
    });

    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    expect(createChatCapture.calls).toHaveLength(1);

    // Start a NEW edit on a DIFFERENT queued item while A's create is still
    // pending - this is the exact overlap the refinement guards against.
    fireEvent.click(editButtons()[1]);
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-b");
    });

    act(() => {
      createChatCapture.calls[0].callbacks.onSuccess({
        chatId: "side-chat-a",
        initialTurnStarted: false,
      });
    });

    // Only the CAPTURED item (A) is cancelled - B, the live edit, is untouched.
    const queueCancelFrames = chatHarness.sent.filter(
      (frame) => frame.kind === "queueCancel",
    );
    expect(queueCancelFrames).toHaveLength(1);
    expect(queueCancelFrames[0]).toMatchObject({
      kind: "queueCancel",
      queueItemId: "queue-a",
    });

    // B's edit pill is still showing - A's stale success must not have
    // cleared or otherwise touched the CURRENT edit target.
    expect(editingPillQueueItemId()).toBe("queue-b");
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
                  tileId="pane-queue-edit-steer"
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
    expect(
      document.querySelector('[data-testid^="chat-tile-pre-content-"]'),
    ).toBeNull();
  });
  await waitFor(() => {
    expect(screen.getByTestId("queued-message-rows")).not.toBeNull();
  });
}

describe("chat-tile's ready line for an agent whose first message waited for its sandbox", () => {
  afterEach(() => {
    usePendingSandboxSendStore.setState({ sends: {} });
  });

  it("shows Sandbox ready above the conversation once the message was delivered into this chat, and nothing for another chat", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", []);
    usePendingSandboxSendStore.getState().add(
      pendingSend({
        id: "send-ready",
        userId: "owner-1",
        text: "fix the login bug",
        delivery: {
          chatId: CHAT_ARTIFACT.id,
          hostId: "sbx-host",
          sandboxId: "sbx-1",
          readySeconds: 24,
        },
      }),
    );
    renderChatTile();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid^="chat-tile-pre-content-"]'),
      ).toBeNull();
    });

    const line = await screen.findByTestId("sandbox-ready-line");
    expect(line.textContent).toContain("Sandbox ready");
    expect(line.textContent).toContain("24 s");
  });

  it("shows no ready line for a chat no waiting message was delivered into", async () => {
    chatHarness.teardown();
    chatHarness.install("owner", []);
    usePendingSandboxSendStore.getState().add(
      pendingSend({
        id: "send-other",
        userId: "owner-1",
        delivery: {
          chatId: "some-other-chat",
          hostId: "sbx-host",
          sandboxId: "sbx-1",
          readySeconds: 24,
        },
      }),
    );
    renderChatTile();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid^="chat-tile-pre-content-"]'),
      ).toBeNull();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("sandbox-ready-line")).toBeNull();
  });
});

describe("chat-tile composer folders while a queued message is edited", () => {
  const WORKTREE_PATH = "/Users/test/project-worktree";
  const LOCAL_CHOICE: WorktreeIntent = {
    entries: [
      {
        kind: "local",
        workspacePath: PROJECT_PATH,
        repoIdentifier: null,
        isPrimary: true,
      },
    ],
  };

  /**
   * The chat runs in a worktree; the queued message asked for Local. Resolves
   * to how many slash-command lookups the tile had made when the edit began.
   */
  async function renderEditingLocalMessage(): Promise<number> {
    boundFolder = { mode: "worktree", worktreePath: WORKTREE_PATH };
    chatHarness.teardown();
    chatHarness.install("owner", [
      {
        ...queuedPromptItem("queue-edit-target", QUEUED_CONTENT),
        worktreeIntent: LOCAL_CHOICE,
      },
    ]);
    renderChatTile();
    await waitForChatTileLoaded();
    await waitFor(() => {
      expect(submitCapture.mentionRoots).toEqual([WORKTREE_PATH]);
    });
    expect(submitCapture.runWorkingDirectory).toBe(WORKTREE_PATH);
    const lookupsBeforeEdit = tileSlashLookups.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe("queue-edit-target");
    });
    return lookupsBeforeEdit;
  }

  /** Every lookup the tile made after `count`, each kept as its own record. */
  function lookupsSince(count: number): ReadonlyArray<ReadonlyArray<string>> {
    return tileSlashLookups
      .slice(count)
      .map((lookup) => lookup.workingDirectories);
  }

  it("points the composer's discovery at the edited message's folders, not the chat's worktree", async () => {
    await renderEditingLocalMessage();

    await waitFor(() => {
      expect(submitCapture.mentionRoots).toEqual([PROJECT_PATH]);
    });
    expect(submitCapture.runWorkingDirectory).toBe(PROJECT_PATH);
  });

  it("keeps the tile's own send paths looking up slash commands in the chat's next-send folders", async () => {
    const lookupsBeforeEdit = await renderEditingLocalMessage();

    const lookups = lookupsSince(lookupsBeforeEdit);
    expect(lookups.length).toBeGreaterThan(0);
    for (const directories of lookups) {
      expect(directories).toEqual([WORKTREE_PATH]);
    }
  });

  it("keeps the inline edit of a sent message looking up slash commands in the chat's next-send folders", async () => {
    // A sent message can be edited only while no turn runs.
    chatTurnRunning = false;
    await renderEditingLocalMessage();
    const lookupsBeforeInlineEdit = tileSlashLookups.length;

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    await waitFor(() => {
      expect(screen.getAllByRole("textbox")).toHaveLength(2);
    });

    const lookups = lookupsSince(lookupsBeforeInlineEdit);
    expect(lookups.length).toBeGreaterThan(0);
    for (const directories of lookups) {
      expect(directories).toEqual([WORKTREE_PATH]);
    }
  });

  it("starts a /btw side chat from the edit in the edited message's folders", async () => {
    await renderEditingLocalMessage();
    const onSideChat = submitCapture.onSideChat;
    if (onSideChat === null) {
      throw new Error("expected ChatTile to wire onSideChat");
    }

    act(() => {
      onSideChat({
        command: "side",
        content: SIDE_CHAT_CONTENT,
        settings: QUEUED_SETTINGS,
      });
    });

    expect(createChatCapture.calls).toHaveLength(1);
    expect(createChatCapture.calls[0].request.worktreeIntent?.entries).toEqual([
      expect.objectContaining({ kind: "local", workspacePath: PROJECT_PATH }),
    ]);
  });
});

describe("chat-tile saving a queued message's folders while a chat shell runs where the chat is bound", () => {
  const WORKTREE_A = "/Users/test/project-worktree";
  const WORKTREE_B = "/Users/test/other-worktree";
  const LOCAL_PICK: WorktreeIntent = {
    entries: [
      {
        kind: "local",
        workspacePath: PROJECT_PATH,
        repoIdentifier: null,
        isPrimary: true,
      },
    ],
  };
  const IMPORT_B_PICK: WorktreeIntent = {
    entries: [
      {
        kind: "import",
        workspacePath: PROJECT_PATH,
        repoIdentifier: null,
        isPrimary: true,
        worktreePath: WORKTREE_B,
      },
    ],
  };
  const QUEUE_ITEM_ID = "queue-edit-target";
  /** What a save sends: text the queued row did not hold, so the host's reply can tell it apart. */
  const SAVED_CONTENT: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "saved queue item" }],
      },
    ],
  };

  function shell(id: string, command: string, cwd: string): ManagedCommand {
    return {
      id,
      monitoring: false,
      description: command,
      command,
      cwd,
      cadence: null,
      status: { state: "running", pid: 42, startedAtMs: 1 },
      chatId: CHAT_ARTIFACT.id,
      relaunchOnHostRestart: false,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
  }
  const SHELL_UNDER_A = shell("sh-a", "npm run dev", `${WORKTREE_A}/apps`);

  /**
   * The chat is bound to worktree A with the given shells running, and a queued
   * message whose own choice is `rowChoice` is open for editing.
   */
  async function editRow(
    rowChoice: WorktreeIntent | null,
    shells: ReadonlyArray<ManagedCommand>,
  ): Promise<void> {
    await renderRow(BOUND_TO_A, rowChoice, shells);
    await beginEdit();
  }

  const BOUND_TO_A = { mode: "worktree", worktreePath: WORKTREE_A } as const;

  /** The tile loaded on a chat bound as `bound`, with the queued message not yet edited. */
  async function renderRow(
    bound: typeof boundFolder,
    rowChoice: WorktreeIntent | null,
    shells: ReadonlyArray<ManagedCommand>,
  ): Promise<void> {
    boundFolder = bound;
    chatShells = shells;
    chatHarness.teardown();
    chatHarness.install("owner", [queuedRow(rowChoice, QUEUED_CONTENT)]);
    renderChatTile();
    await waitForChatTileLoaded();
  }

  function queuedRow(rowChoice: WorktreeIntent | null, content: JsonContent) {
    return {
      ...queuedPromptItem(QUEUE_ITEM_ID, content),
      worktreeIntent: rowChoice,
    };
  }

  /** The host accepts every queue-edit frame sent so far. */
  function acceptQueueEditFrames(): void {
    act(() => {
      for (const frame of chatHarness.sent) {
        if (
          frame.kind !== "queueEdit" &&
          frame.kind !== "queueSettingsUpdate"
        ) {
          continue;
        }
        chatHarness.callbacks().onActionAck({
          kind: "actionAck",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ARTIFACT.id,
          clientActionId: frame.clientActionId,
          action: frame.kind,
          status: "accepted",
          reason: null,
          code: null,
          backgroundStopTaskIds: [],
          token: null,
        });
      }
    });
  }

  /** The host's next snapshot: the queued row as it now stands, the shells running. */
  function emitHostState(
    rowChoice: WorktreeIntent | null,
    content: JsonContent,
    shells: ReadonlyArray<ManagedCommand>,
  ): void {
    chatShells = shells;
    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", [
        queuedRow(rowChoice, content),
      ]);
    });
  }

  async function beginEdit(): Promise<void> {
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(editingPillQueueItemId()).toBe(QUEUE_ITEM_ID);
    });
    await waitFor(() => {
      expect(selectorCapture.editSessionId).not.toBeNull();
    });
  }

  function editSlot() {
    const sessionId = selectorCapture.editSessionId;
    if (sessionId === null) throw new Error("expected an open edit session");
    return queueEditStagingKey("host-test", EPIC_ID, CHAT_ARTIFACT.id, {
      queueItemId: QUEUE_ITEM_ID,
      sessionId,
    });
  }

  function pickInEdit(intent: WorktreeIntent): void {
    act(() => {
      useWorktreeIntentStagingStore.getState().setIntent(editSlot(), intent);
    });
  }

  /** Saves through the composer's submit handler as the render that handed it out. */
  function saveEdit(
    onSubmitMessage: typeof submitCapture.onSubmitMessage,
  ): boolean | Promise<boolean> {
    if (onSubmitMessage === null) {
      throw new Error("expected ChatTile to wire onSubmitMessage");
    }
    let outcome: boolean | Promise<boolean> = false;
    act(() => {
      outcome = onSubmitMessage({
        content: SAVED_CONTENT,
        contentText: "saved queue item",
        attachments: [],
        settings: QUEUED_SETTINGS,
        deliveryPolicy: "auto",
        restore: { content: SAVED_CONTENT, browserAnnotations: [] },
        restartConfirmed: false,
      });
    });
    return outcome;
  }

  function queueEditFrames() {
    return chatHarness.sent.filter((frame) => frame.kind === "queueEdit");
  }

  beforeEach(() => {
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  it("asks before a Save that moves a folder off the worktree a shell runs in, and says Save", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    const dialog = await screen.findByTestId("teardown-commit-dialog");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBe(
      screen.getByTestId("teardown-commit-immediate"),
    );
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });

  it("asks for a pick that imports another worktree over the bound one", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(IMPORT_B_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
    expect(queueEditFrames()).toEqual([]);
  });

  it("saves straight through when the folder is bound Local, whatever shell runs in the project", async () => {
    boundFolder = LOCAL_FOLDER;
    chatShells = [shell("sh-p", "npm run dev", `${PROJECT_PATH}/apps`)];
    chatHarness.teardown();
    chatHarness.install("owner", [
      queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT),
    ]);
    renderChatTile();
    await waitForChatTileLoaded();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await waitFor(() => {
      expect(selectorCapture.editSessionId).not.toBeNull();
    });
    pickInEdit(IMPORT_B_PICK);

    expect(saveEdit(submitCapture.onSubmitMessage)).toBe(true);

    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("leaves the edit open with its text and pick when the dialog is cancelled", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));

    expect(await outcome).toBe(false);
    expect(queueEditFrames()).toEqual([]);
    expect(editingPillQueueItemId()).toBe(QUEUE_ITEM_ID);
    expect(screen.getByRole("textbox").textContent).toContain(
      "edited queue item",
    );
    expect(readStagedWorktreeIntent(editSlot())).toEqual(LOCAL_PICK);
  });

  it("sends the edit once, with the pick, when the dialog is confirmed, and ends the edit", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await outcome).toBe(true);
    const frames = queueEditFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "queueEdit",
      worktreeIntent: LOCAL_PICK,
    });
    expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
  });

  it("saves nothing on confirm when the message began while the dialog was open, though the queue still lists it", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    begunQueuedMessageIds = [
      queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT).messageId,
    ];
    emitHostState(null, QUEUED_CONTENT, [SHELL_UNDER_A]);
    await waitFor(() => {
      expect(screen.queryByTestId("queue-edit-draft-pill")).toBeNull();
    });
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await outcome).toBe(false);
    expect(queueEditFrames()).toEqual([]);
    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
  });

  it("asks again when the shells changed while the dialog was open, and sends only on the second confirm", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(LOCAL_PICK);
    const outcome = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");

    chatShells = [
      SHELL_UNDER_A,
      shell("sh-other", "sleep 1", `${WORKTREE_A}/lib`),
    ];
    act(() => {
      emitChatSnapshot(chatHarness.callbacks(), "owner", [
        queuedPromptItem(QUEUE_ITEM_ID, QUEUED_CONTENT),
      ]);
    });
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "sleep 1",
    );
    expect(queueEditFrames()).toEqual([]);

    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

    expect(await outcome).toBe(true);
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("lists only the shells under the worktree being left, not the running turn or a shell elsewhere", async () => {
    await editRow(null, [
      SHELL_UNDER_A,
      shell("sh-else", "tail -f log", "/Users/test/elsewhere"),
    ]);
    pickInEdit(LOCAL_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    const labels = screen.getAllByTestId("teardown-holder-label");
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toContain("npm run dev");
    expect(screen.getByTestId("teardown-disclosure").textContent).not.toMatch(
      /agent is still working/,
    );
  });

  it("asks again about a shell in a worktree the message's own choice already left", async () => {
    await editRow(LOCAL_PICK, [SHELL_UNDER_A]);
    pickInEdit(IMPORT_B_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });

  it("asks about the shell that started after an earlier save was applied, not about the earlier consent", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    pickInEdit(IMPORT_B_PICK);
    const first = saveEdit(submitCapture.onSubmitMessage);
    await screen.findByTestId("teardown-commit-dialog");
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));
    expect(await first).toBe(true);
    expect(queueEditFrames()).toHaveLength(1);

    // The host applied the edit (the row now chooses B) and a new shell runs in A.
    const later = shell("sh-later", "tail -f later.log", `${WORKTREE_A}/lib`);
    acceptQueueEditFrames();
    emitHostState(IMPORT_B_PICK, SAVED_CONTENT, [SHELL_UNDER_A, later]);
    await beginEdit();
    pickInEdit(LOCAL_PICK);
    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "tail -f later.log",
    );
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("asks about a shell that started after an earlier save went straight through", async () => {
    await editRow(null, []);
    pickInEdit(IMPORT_B_PICK);
    expect(saveEdit(submitCapture.onSubmitMessage)).toBe(true);
    expect(queueEditFrames()).toHaveLength(1);

    acceptQueueEditFrames();
    emitHostState(IMPORT_B_PICK, SAVED_CONTENT, [SHELL_UNDER_A]);
    await beginEdit();
    pickInEdit(LOCAL_PICK);
    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("asks about a shell in a worktree the chat was bound to after the message was queued", async () => {
    await renderRow(LOCAL_FOLDER, LOCAL_PICK, []);
    // A row ahead bound the folder to worktree A while this one waited.
    boundFolder = BOUND_TO_A;
    emitHostState(LOCAL_PICK, QUEUED_CONTENT, [SHELL_UNDER_A]);
    await beginEdit();
    pickInEdit(IMPORT_B_PICK);

    void saveEdit(submitCapture.onSubmitMessage);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });

  it("saves a text-only edit straight through, though the message's own choice left a worktree a shell runs in", async () => {
    await editRow(LOCAL_PICK, [SHELL_UNDER_A]);

    expect(saveEdit(submitCapture.onSubmitMessage)).toBe(true);

    expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
    expect(queueEditFrames()).toHaveLength(1);
  });

  it("judges a save by the picks made after the composer handed out its submit handler", async () => {
    await editRow(null, [SHELL_UNDER_A]);
    const handedOutBeforeThePick = submitCapture.onSubmitMessage;
    pickInEdit(LOCAL_PICK);

    void saveEdit(handedOutBeforeThePick);

    await screen.findByTestId("teardown-commit-dialog");
    expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
      "npm run dev",
    );
    expect(queueEditFrames()).toEqual([]);
  });
});
