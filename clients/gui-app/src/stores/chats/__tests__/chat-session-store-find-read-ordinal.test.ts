import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  HYDRATION_REQUEST_TIMEOUT_MS,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * F14-8: `findReadOrdinal` is REQUIRED hydration, never a viewport move.
 *
 * Chat find reads an index hit's row to confirm it, and nothing scrolls to that
 * row - so unless the store names it to the planner, nothing will ever fetch it.
 * Driven through the real store and its real planner; only the stream client
 * is a double, recording every `loadRange` the store sends.
 */
const EPIC_ID = "epic-find-read";
const CHAT_ID = "chat-find-read";
const OWNER_ID = "owner-find-read";

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

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-find-read",
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

/** 40 rows, the tail (20..39) hydrated, and the reader parked on it. */
function primeWindowAtTail(harness: Harness): void {
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
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "host-find-read",
        title: "Find read",
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
      rowCount: 40,
      indexRevision: null,
      tail: {
        fromOrdinal: 20,
        messages: [userMessage("tail", 20)],
        events: [],
      },
      derived,
    },
  });
  // A visible range wholly inside the hydrated tail: the viewport asks for
  // nothing, so any request after this is the find read's alone.
  harness.handle.store
    .getState()
    .reportVisibleTranscriptRange({ fromOrdinal: 30, toOrdinal: 40 });
}

describe("chat-session-store - find read ordinal (F14-8)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates the named row without a viewport move or a jump", () => {
    const harness = createHarness();
    try {
      primeWindowAtTail(harness);
      expect(harness.rangeRequests).toEqual([]);

      harness.handle.store.getState().requestFindReadOrdinal(5);

      const state = harness.handle.store.getState();
      expect(state.findReadOrdinal).toBe(5);
      expect(state.jumpTargetOrdinal).toBeNull();
      // One row, the one named - the viewport (30..40) is unchanged.
      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]).toMatchObject({
        fromOrdinal: 5,
        toOrdinal: 5,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  it("stops asking for the row once the read is cleared", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      primeWindowAtTail(harness);
      harness.handle.store.getState().requestFindReadOrdinal(5);
      expect(harness.rangeRequests).toHaveLength(1);

      harness.handle.store.getState().requestFindReadOrdinal(null);
      expect(harness.handle.store.getState().findReadOrdinal).toBeNull();

      // The unanswered request times out and the store re-plans: with the
      // read cleared there is nothing left to ask for.
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps re-asking for the row while the read stands (control for the cell above)", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      primeWindowAtTail(harness);
      harness.handle.store.getState().requestFindReadOrdinal(5);

      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(2);
      expect(harness.rangeRequests[1]).toMatchObject({
        fromOrdinal: 5,
        toOrdinal: 5,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  it("is held apart from a jump: clearing one leaves the other", () => {
    const harness = createHarness();
    try {
      primeWindowAtTail(harness);
      harness.handle.store.getState().requestFindReadOrdinal(5);
      harness.handle.store.getState().requestTranscriptOrdinal(8);
      harness.handle.store.getState().requestTranscriptOrdinal(null);

      const state = harness.handle.store.getState();
      expect(state.findReadOrdinal).toBe(5);
      expect(state.jumpTargetOrdinal).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });
});
