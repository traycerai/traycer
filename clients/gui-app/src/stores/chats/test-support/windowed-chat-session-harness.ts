import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * A REAL chat session store whose stream client is the only double: it hands
 * back the store's callbacks and records every transcript range request.
 */

export interface WindowedChatIdentity {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly ownerId: string;
}

export interface Harness {
  readonly identity: WindowedChatIdentity;
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
}

export function createHarness(identity: WindowedChatIdentity): Harness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: identity.hostId,
    epicId: identity.epicId,
    chatId: identity.chatId,
    userId: identity.ownerId,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: (request) => {
          rangeRequests.push(request);
        },
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    identity,
    handle,
    rangeRequests,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

export interface WindowTailSnapshot {
  readonly rowCount: number;
  readonly tailFromOrdinal: number;
  readonly tailMessages: ReadonlyArray<Message>;
  readonly tailRowIds: ReadonlyArray<string> | null;
  readonly transcriptEpoch: number;
  readonly visible: {
    readonly fromOrdinal: number;
    readonly toOrdinal: number;
  };
}

/** 40 rows, the tail (20..39) hydrated, and the reader parked on it. */
export function primeWindowAtTail(
  harness: Harness,
  rowCount: number,
  tailFromOrdinal: number,
  tailMessage: Message,
): void {
  primeWindowWithTail(harness, {
    rowCount,
    tailFromOrdinal,
    tailMessages: [tailMessage],
    tailRowIds: null,
    transcriptEpoch: 1,
    visible: { fromOrdinal: 30, toOrdinal: 40 },
  });
}

/**
 * The snapshot a windowed host sends: `rowCount` rows whose tail is exactly
 * `tailMessages`, one per ordinal from `tailFromOrdinal`, so the tail runs to
 * `rowCount` when the caller gives one message for each. `visible` is the
 * range the reader is then parked on. `tailRowIds` names each tail row, as a
 * host that names its rows does; `null` sends none, which seats the tail
 * positionally with no row identity, so its rows are not placed at their
 * ordinals. `transcriptEpoch` is the window's epoch: a later snapshot naming a
 * higher one is a rebase of the whole coordinate space.
 */
export function primeWindowWithTail(
  harness: Harness,
  snapshot: WindowTailSnapshot,
): void {
  const {
    rowCount,
    tailFromOrdinal,
    tailMessages,
    tailRowIds,
    transcriptEpoch,
    visible,
  } = snapshot;
  const derived: ChatTranscriptDerived = {
    latestAssistantUsage: null,
    pinnedTodo: null,
    pinnedTaskTodoItems: [],
    latestForkableAssistantMessageId: null,
    restorableSetupInterruption: null,
    interviewAnswerability: [],
    latestAssistantAuthFailureTurnKey: null,
    setupCardWindows: [],
  };
  harness.callbacks().onWindowedSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: harness.identity.epicId,
    chatId: harness.identity.chatId,
    snapshot: {
      chat: {
        id: harness.identity.chatId,
        parentId: null,
        userId: harness.identity.ownerId,
        hostId: harness.identity.hostId,
        title: "Hold",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
      },
      access: {
        role: "owner",
        ownerUserId: harness.identity.ownerId,
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
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      transcriptEpoch,
      rowCount,
      indexRevision: null,
      tail: {
        fromOrdinal: tailFromOrdinal,
        messages: [...tailMessages],
        events: [],
        ...(tailRowIds === null ? {} : { rowIds: [...tailRowIds] }),
      },
      derived,
    },
  });
  // A visible range wholly inside the hydrated tail: the viewport asks for
  // nothing, so any request after this is the find read's alone.
  harness.handle.store.getState().reportVisibleTranscriptRange(visible);
}

export function windowedUserMessage(
  ownerId: string,
  messageId: string,
  timestamp: number,
  text: string,
): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: ownerId },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [],
    },
    timestamp,
    sessionAnchor: null,
  };
}
