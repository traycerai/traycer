/**
 * A chat on the windowed line, played from the host's side: the REAL chat
 * session store (`createWindowedSession`) and the frames a host sends it (a
 * bounded snapshot, the row skeleton, an index delta, an appended event, a
 * range response), built from the protocol's own producers - the same
 * `buildRowSkeleton`, `sliceTranscriptTail` and `sliceTranscriptRange` the
 * live host serves a chat from. Shared by the suites that draw what the
 * client's window makes of a host's frames.
 */
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  buildRowSkeleton,
  transcriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import {
  buildTranscriptRecordLookup,
  sliceTranscriptRange,
  sliceTranscriptTail,
  type TranscriptTailSlice,
} from "@traycer/protocol/persistence/chat-transcript/read-range";
import {
  projectTranscriptRows,
  type TranscriptRowProjectionInput,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type {
  OpenChatEvent,
  OpenMessage,
} from "@traycer/protocol/host/agent/gui/open-harness-wire";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/** Who a windowed chat belongs to, in the frames a host addresses it with. */
export interface WindowedChatIds {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  /** The owner the chat's access names. */
  readonly ownerId: string;
  readonly title: string;
}

export interface WindowedSession {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
}

export function createWindowedSession(ids: WindowedChatIds): WindowedSession {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: ids.hostId,
    epicId: ids.epicId,
    chatId: ids.chatId,
    userId: ids.ownerId,
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
    handle,
    rangeRequests,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

export const EMPTY_TAIL = (
  rowCount: number,
): TranscriptTailSlice<OpenMessage, OpenChatEvent> => ({
  fromOrdinal: rowCount,
  rowIds: [],
  incompleteRowIds: [],
  messages: [],
  events: [],
  rowContext: {},
});

/** The whole transcript as one tail slice, as a host serves a short chat. */
export function wholeTail(
  input: TranscriptRowProjectionInput<OpenMessage, OpenChatEvent>,
): TranscriptTailSlice<OpenMessage, OpenChatEvent> {
  return sliceTranscriptTail(
    projectTranscriptRows(input),
    buildTranscriptRecordLookup(input.messages, input.events),
    1_000_000,
    null,
  );
}

export function windowedSnapshotFrame(
  ids: WindowedChatIds,
  input: {
    readonly rowCount: number;
    readonly tail: TranscriptTailSlice<OpenMessage, OpenChatEvent>;
    readonly indexRevision: number | null;
  },
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
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
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    snapshot: {
      chat: {
        id: ids.chatId,
        parentId: null,
        userId: ids.ownerId,
        hostId: ids.hostId,
        title: ids.title,
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
      access: { role: "owner", ownerUserId: ids.ownerId, canAct: true },
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
      transcriptEpoch: 1,
      rowCount: input.rowCount,
      indexRevision: input.indexRevision,
      tail: {
        fromOrdinal: input.tail.fromOrdinal,
        rowIds: [...input.tail.rowIds],
        incompleteRowIds: [...input.tail.incompleteRowIds],
        messages: [...input.tail.messages],
        events: [...input.tail.events],
        rowContext: { ...input.tail.rowContext },
      },
      derived,
    },
  };
}

/** The whole skeleton of `input` in one final chunk, as the host builds it. */
export function skeletonChunkFrame(
  ids: WindowedChatIds,
  input: TranscriptRowProjectionInput<OpenMessage, OpenChatEvent>,
): Parameters<ChatStreamCallbacks["onSkeletonChunk"]>[0] {
  return {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    chunk: {
      epoch: 1,
      fromOrdinal: 0,
      entries: [...buildRowSkeleton(input, transcriptPreviewProjection, null)],
      isFinal: true,
    },
  };
}

/** The shared frame an append broadcast leads with. */
export function eventAppendedFrame(
  ids: WindowedChatIds,
  event: OpenChatEvent,
): Parameters<ChatStreamCallbacks["onEventAppended"]>[0] {
  return {
    kind: "eventAppended",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    event,
  };
}

/**
 * The `indexChanged` delta for a one-row append that took the transcript from
 * `before` to `after`: the new row's skeleton entry, as the host builds it.
 */
export function appendedDeltaFrame(
  ids: WindowedChatIds,
  input: {
    readonly after: TranscriptRowProjectionInput<OpenMessage, OpenChatEvent>;
    readonly indexRevision: number;
  },
): Parameters<ChatStreamCallbacks["onIndexChanged"]>[0] {
  const entries = buildRowSkeleton(
    input.after,
    transcriptPreviewProjection,
    null,
  );
  const appended = entries.at(-1);
  if (appended === undefined) throw new Error("expected an appended row");
  return {
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    epoch: 1,
    rowCount: entries.length,
    indexRevision: input.indexRevision,
    changes: [{ type: "appended", entries: [appended] }],
  };
}

/** Answer the harness's latest `loadRange` from `input`, as the host would. */
export function answerLatestRange(
  harness: WindowedSession,
  ids: WindowedChatIds,
  input: TranscriptRowProjectionInput<OpenMessage, OpenChatEvent>,
): ChatLoadRangeRequest {
  const request = harness.rangeRequests.at(-1);
  if (request === undefined) throw new Error("expected a loadRange");
  const slice = sliceTranscriptRange(
    projectTranscriptRows(input),
    buildTranscriptRecordLookup(input.messages, input.events),
    {
      fromOrdinal: request.fromOrdinal,
      toOrdinal: request.toOrdinal,
      maxBytes: request.maxBytes,
    },
    null,
  );
  harness.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    range: {
      requestId: request.requestId,
      epoch: request.epoch,
      fromOrdinal: slice.fromOrdinal,
      rowIds: [...slice.rowIds],
      incompleteRowIds: [...slice.incompleteRowIds],
      messages: [...slice.messages],
      events: [...slice.events],
      rowContext: { ...slice.rowContext },
      reachedStart: slice.reachedStart,
      reachedEnd: slice.reachedEnd,
    },
  });
  return request;
}
