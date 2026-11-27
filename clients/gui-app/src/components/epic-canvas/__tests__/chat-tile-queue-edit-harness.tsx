/** The chat tile mounted on one queued message, for the `chat-tile-queue-edit-*` suites. */
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { expect } from "vitest";
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
import { ChatTile } from "@/components/epic-canvas/renderers/chat-tile";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  queueEditStagingKey,
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
import {
  selectorCapture,
  submitCapture,
  createChatCapture,
  tileSlashLookups,
} from "./chat-tile-queue-edit-captures";

export const EPIC_ID = "epic-queue-edit-steer";
export const CHAT_ARTIFACT = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat" as const,
  name: "Chat 1",
  hostId: "host-test",
};
export const QUEUED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "edited queue item" }],
    },
  ],
};
export const QUEUED_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
export const SIDE_CHAT_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "why is this slow?" }],
    },
  ],
};

export function queuedPromptItem(
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
export function editingPillQueueItemId(): string | null {
  return screen
    .getByTestId("queue-edit-draft-pill")
    .getAttribute("data-queue-item-id");
}

const epicHarness = createEpicSessionTestHarness(EPIC_ID);
export const chatHarness = createChatHarness();

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

export const PROJECT_PATH = "/Users/test/project";
export const LOCAL_FOLDER = { mode: "local", worktreePath: null } as const;
/** How the chat's one bound folder is bound; a test may bind it to a worktree. */
type BoundFolder = {
  readonly mode: "local" | "worktree";
  readonly worktreePath: string | null;
};
/**
 * What the host's snapshot reports. A case may set any field; every field is
 * put back before each case by `resetQueueEditTileTest`.
 */
export const hostState: {
  /** Whether a turn is under way. */
  turnRunning: boolean;
  /** The chat's shells. */
  shells: ReadonlyArray<ManagedCommand>;
  boundFolder: BoundFolder;
  /**
   * Message ids of queued prompts the host has begun: the snapshot's
   * transcript holds each, while its queue can still list the row.
   */
  begunQueuedMessageIds: ReadonlyArray<string>;
} = {
  turnRunning: true,
  shells: [],
  boundFolder: LOCAL_FOLDER,
  begunQueuedMessageIds: [],
};

export function emitChatSnapshot(
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
          ...hostState.begunQueuedMessageIds.map((messageId) => ({
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
      runStatus: hostState.turnRunning ? "running" : "idle",
      activeTurn: !hostState.turnRunning
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
            ...hostState.boundFolder,
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
      managedCommands: [...hostState.shells],
      heldUpdates: [],
      portForwards: [],
    },
  });
}

/** Before each case: every store, capture and host-state field put back, and a fresh epic and chat. */
export function resetQueueEditTileTest(): void {
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
  hostState.boundFolder = LOCAL_FOLDER;
  hostState.shells = [];
  hostState.begunQueuedMessageIds = [];
  useWorktreeIntentStagingStore.getState().resetForTests();
  hostState.turnRunning = true;
  tileSlashLookups.length = 0;
  epicHarness.install(seedDocWithChat, "editor");
  chatHarness.install("owner", []);
}

export function cleanUpQueueEditTileTest(): void {
  cleanup();
  chatHarness.teardown();
  epicHarness.teardown();
  __getOpenEpicRegistryForTests().disposeAll();
  resetFocusedComposerControlsForTests();
}

export function renderChatTile(): void {
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

export async function waitForChatTileLoaded(): Promise<void> {
  await waitFor(() => {
    expect(
      document.querySelector('[data-testid^="chat-tile-pre-content-"]'),
    ).toBeNull();
  });
  await waitFor(() => {
    expect(screen.getByTestId("queued-message-rows")).not.toBeNull();
  });
}

// The folder dialog on a queued message's Save: a chat bound to worktree A,
// with shells that run there.
export const WORKTREE_A = "/Users/test/project-worktree";
const WORKTREE_B = "/Users/test/other-worktree";
export const LOCAL_PICK: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: PROJECT_PATH,
      repoIdentifier: null,
      isPrimary: true,
    },
  ],
};
export const IMPORT_B_PICK: WorktreeIntent = {
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
export const QUEUE_ITEM_ID = "queue-edit-target";
/** What a save sends: text the queued row did not hold, so the host's reply can tell it apart. */
export const SAVED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "saved queue item" }],
    },
  ],
};

export function shell(
  id: string,
  command: string,
  cwd: string,
): ManagedCommand {
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
export const SHELL_UNDER_A = shell("sh-a", "npm run dev", `${WORKTREE_A}/apps`);

/**
 * The chat is bound to worktree A with the given shells running, and a queued
 * message whose own choice is `rowChoice` is open for editing.
 */
export async function editRow(
  rowChoice: WorktreeIntent | null,
  shells: ReadonlyArray<ManagedCommand>,
): Promise<void> {
  await renderRow(BOUND_TO_A, rowChoice, shells);
  await beginEdit();
}

export const BOUND_TO_A = {
  mode: "worktree",
  worktreePath: WORKTREE_A,
} as const;

/** The tile loaded on a chat bound as `bound`, with the queued message not yet edited. */
export async function renderRow(
  bound: BoundFolder,
  rowChoice: WorktreeIntent | null,
  shells: ReadonlyArray<ManagedCommand>,
): Promise<void> {
  hostState.boundFolder = bound;
  hostState.shells = shells;
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

/** The host's next snapshot: the queued row as it now stands, the shells running. */
export function emitHostState(
  rowChoice: WorktreeIntent | null,
  content: JsonContent,
  shells: ReadonlyArray<ManagedCommand>,
): void {
  hostState.shells = shells;
  act(() => {
    emitChatSnapshot(chatHarness.callbacks(), "owner", [
      queuedRow(rowChoice, content),
    ]);
  });
}

export async function beginEdit(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
  await waitFor(() => {
    expect(editingPillQueueItemId()).toBe(QUEUE_ITEM_ID);
  });
  await waitFor(() => {
    expect(selectorCapture.editSessionId).not.toBeNull();
  });
}

export function editSlot() {
  const sessionId = selectorCapture.editSessionId;
  if (sessionId === null) throw new Error("expected an open edit session");
  return queueEditStagingKey("host-test", EPIC_ID, CHAT_ARTIFACT.id, {
    queueItemId: QUEUE_ITEM_ID,
    sessionId,
  });
}

export function pickInEdit(intent: WorktreeIntent): void {
  act(() => {
    useWorktreeIntentStagingStore.getState().setIntent(editSlot(), intent);
  });
}

/** Saves through the composer's submit handler as the render that handed it out. */
export function saveEdit(
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

export function queueEditFrames() {
  return chatHarness.sent.filter((frame) => frame.kind === "queueEdit");
}
