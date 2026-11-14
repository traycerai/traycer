import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

export const EPIC_ID = "epic-x";
export const CHAT_ID = "chat-x";
export const OWNER_ID = "owner-x";

export interface ChatTileHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  readonly callbacks: () => ChatStreamCallbacks;
}

export function createHarness(): ChatTileHarness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    sent,
    callbacks: () => {
      if (callbacks === null) throw new Error("expected callbacks");
      return callbacks;
    },
  };
}

export function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  events: ReadonlyArray<ChatEvent>,
  messages: ReadonlyArray<Message>,
): void {
  emitSnapshotWithQueue(callbacks, events, messages, []);
}

export function emitSnapshotWithQueue(
  callbacks: ChatStreamCallbacks,
  events: ReadonlyArray<ChatEvent>,
  messages: ReadonlyArray<Message>,
  queueItems: ReadonlyArray<ChatQueuedPromptItem>,
): void {
  callbacks.onConnectionStatus("open", null, null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "test-host",
        title: "Setup Chat",
        createdAt: 0,
        updatedAt: 0,
        isTitleEditedByUser: false,
        settings: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [...messages],
        events: [...events],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [...queueItems] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
    },
  });
}

export function sendTestMessage(
  harness: ChatTileHarness,
  content: JsonContent,
  settings: ChatRunSettings,
): void {
  harness.handle.store.getState().sendMessage({
    content,
    sender: { type: "user", userId: OWNER_ID },
    settings,
    attachments: buildAttachmentsFromJSONContent(content),
    deliveryPolicy: "auto",
    restore: { content, browserAnnotations: [] },
  });
}
