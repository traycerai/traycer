import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * A real chat session store over a fake stream: what a pending message's
 * dispatch driver sends into, and what acknowledges it.
 */
export interface MessageSessionHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  openAsOwner(): void;
  acknowledgeSend(clientActionId: string): void;
  rejectSend(clientActionId: string, reason: string): void;
}

export function createMessageSessionHarness(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly userId: string;
  readonly settings: ChatRunSettings;
}): MessageSessionHarness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: input.hostId,
    epicId: input.epicId,
    chatId: input.chatId,
    userId: input.userId,
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
  function live(): ChatStreamCallbacks {
    if (callbacks === null) throw new Error("the session opened no stream");
    return callbacks;
  }
  return {
    handle,
    sent,
    openAsOwner: () => {
      live().onConnectionStatus("open", null, null);
      live().onSnapshot({
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId: input.epicId,
        chatId: input.chatId,
        snapshot: {
          chat: {
            id: input.chatId,
            parentId: null,
            userId: input.userId,
            hostId: input.hostId,
            title: "Existing chat",
            createdAt: 1,
            updatedAt: 1,
            isTitleEditedByUser: false,
            settings: input.settings,
            activeSessionChain: null,
            claudePendingWakes: [],
            messages: [],
            events: [],
            archivedAt: null,
            pinnedUserProviderHandle: null,
            lastDeliveredRolesDigest: null,
          },
          access: { role: "owner", ownerUserId: input.userId, canAct: true },
          queue: { status: "idle", items: [] },
          runStatus: "idle",
          activeTurn: null,
          pendingApprovals: [],
          pendingInterviews: [],
          worktreeBinding: null,
          missingWorktreePaths: [],
          pendingFileEditApprovals: [],
          accumulatedFileChanges: [],
          managedCommands: [],
          heldUpdates: [],
          portForwards: [],
        },
      });
    },
    acknowledgeSend: (clientActionId) => {
      live().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: input.epicId,
        chatId: input.chatId,
        clientActionId,
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
        token: null,
      });
    },
    rejectSend: (clientActionId, reason) => {
      live().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: input.epicId,
        chatId: input.chatId,
        clientActionId,
        action: "send",
        status: "rejected",
        reason,
        code: null,
        backgroundStopTaskIds: [],
        token: null,
      });
    },
  };
}
