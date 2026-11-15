import type {
  ChatAccountWait,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

export interface ChatSessionTestIdentity {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly snapshotHostId: string;
  readonly userId: string;
}

export interface LegacyChatSessionHarness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

export interface ChatSessionTestState {
  readonly pendingFallback: PendingFallback | undefined;
  readonly pendingReturn: PendingReturn | undefined;
  readonly accountWait: ChatAccountWait | null | undefined;
}

export interface ChatSessionTestTurnState {
  readonly pendingFallback: PendingFallback | undefined;
  readonly pendingReturn: PendingReturn | undefined;
  readonly accountWait: ChatAccountWait | null;
}

export function createLegacyChatSessionHarness(
  identity: ChatSessionTestIdentity,
): LegacyChatSessionHarness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: identity.hostId,
    epicId: identity.epicId,
    chatId: identity.chatId,
    userId: identity.userId,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function emptyChat(identity: ChatSessionTestIdentity): Chat {
  return {
    id: identity.chatId,
    parentId: null,
    userId: identity.userId,
    hostId: identity.snapshotHostId,
    title: "Host Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

export function emitLegacySnapshot(
  callbacks: ChatStreamCallbacks,
  identity: ChatSessionTestIdentity,
  state: ChatSessionTestState,
): void {
  callbacks.onConnectionStatus("open", null, null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: identity.epicId,
    chatId: identity.chatId,
    snapshot: {
      chat: emptyChat(identity),
      access: {
        role: "owner",
        ownerUserId: identity.userId,
        canAct: true,
      },
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
      pendingFallback: state.pendingFallback,
      pendingReturn: state.pendingReturn,
      ...(state.accountWait === undefined
        ? {}
        : { accountWait: state.accountWait }),
    },
  });
}

export function emitTurnState(
  callbacks: ChatStreamCallbacks,
  identity: ChatSessionTestIdentity,
  state: ChatSessionTestTurnState,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: identity.epicId,
    chatId: identity.chatId,
    runStatus: "idle",
    activeTurn: null,
    pendingFallback: state.pendingFallback,
    pendingReturn: state.pendingReturn,
    accountWait: state.accountWait,
  });
}
