import { describe, expect, it } from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { isTailHydrated } from "@/stores/chats/transcript-window";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-send-would-queue";
const CHAT_ID = "chat-send-would-queue";
const OWNER_ID = "owner-send-would-queue";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

interface WindowedHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
  lastRangeRequestId(): string;
}

function createWindowedHarness(): WindowedHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
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
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
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
    lastRangeRequestId: () => {
      const last = rangeRequests.at(-1);
      if (last === undefined) throw new Error("Expected an outstanding range");
      return last.requestId;
    },
  };
}

const WINDOWED_DERIVED: ChatTranscriptDerived = {
  latestAssistantUsage: null,
  pinnedTodo: null,
  pinnedTaskTodoItems: [],
  latestForkableAssistantMessageId: null,
  restorableSetupInterruption: null,
  interviewAnswerability: [],
  latestAssistantAuthFailureTurnKey: null,
  setupCardWindows: [],
};

interface QueueBit {
  readonly sendWouldQueue: boolean | undefined;
  readonly turnInProgress: boolean | undefined;
}

function windowedSnapshot(
  bit: QueueBit,
  hydrated: boolean,
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "host-a",
        title: "Chat",
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
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      sendWouldQueue: bit.sendWouldQueue,
      turnInProgress: bit.turnInProgress,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      // An empty hydrated tail folds immediately; otherwise completeTail
      // below drives the deferred fold after the range arrives.
      transcriptEpoch: 4,
      rowCount: hydrated ? 0 : 2,
      indexRevision: null,
      tail: { fromOrdinal: hydrated ? 0 : 2, messages: [], events: [] },
      derived: WINDOWED_DERIVED,
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFallbackOutcome: undefined,
      messageDelivery: null,
    },
  };
}

function completeTail(harness: WindowedHarness): void {
  harness.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: harness.lastRangeRequestId(),
      epoch: 4,
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      events: [],
      rowContext: {},
      reachedStart: true,
      reachedEnd: true,
    },
  });
}

function emitTurnState(callbacks: ChatStreamCallbacks, bit: QueueBit): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "running",
    activeTurn: null,
    turnInProgress: bit.turnInProgress,
    sendWouldQueue: bit.sendWouldQueue,
  });
}

function stateOf(harness: WindowedHarness) {
  return harness.handle.store.getState();
}

describe("chat-session-store sendWouldQueue through the windowed snapshot adapter", () => {
  it("seats the queue-admission bit of a snapshot whose tail is already in", () => {
    const harness = createWindowedHarness();
    try {
      harness
        .callbacks()
        .onWindowedSnapshot(
          windowedSnapshot(
            { sendWouldQueue: true, turnInProgress: true },
            true,
          ),
        );

      expect(isTailHydrated(stateOf(harness).transcriptWindow)).toBe(true);
      expect(stateOf(harness).sendWouldQueue).toBe(true);
      expect(stateOf(harness).turnInProgress).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("follows an aux-only rebroadcast of the same transcript with a changed bit", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(
        windowedSnapshot(
          { sendWouldQueue: false, turnInProgress: false },
          true,
        ),
      );
      expect(stateOf(harness).sendWouldQueue).toBe(false);

      callbacks.onWindowedSnapshot(
        windowedSnapshot({ sendWouldQueue: true, turnInProgress: true }, true),
      );

      expect(stateOf(harness).sendWouldQueue).toBe(true);
      expect(stateOf(harness).turnInProgress).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the held snapshot's bit when the deferred fold replays it", () => {
    const harness = createWindowedHarness();
    try {
      harness
        .callbacks()
        .onWindowedSnapshot(
          windowedSnapshot(
            { sendWouldQueue: true, turnInProgress: true },
            false,
          ),
        );
      completeTail(harness);

      expect(isTailHydrated(stateOf(harness).transcriptWindow)).toBe(true);
      expect(stateOf(harness).sendWouldQueue).toBe(true);
      expect(stateOf(harness).turnInProgress).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("replays the SUPERSEDING bit, not the held snapshot's, when a turn-state frame lands before the tail hydrates", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(
        windowedSnapshot(
          { sendWouldQueue: false, turnInProgress: false },
          false,
        ),
      );
      emitTurnState(callbacks, { sendWouldQueue: true, turnInProgress: true });
      expect(stateOf(harness).sendWouldQueue).toBe(true);

      completeTail(harness);

      expect(stateOf(harness).sendWouldQueue).toBe(true);
      expect(stateOf(harness).turnInProgress).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });
});
