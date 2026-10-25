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
 * `holdTranscriptOrdinal` is REQUIRED hydration for as long as a surface
 * outside the transcript shows the row (a bot thread's post in its panel),
 * never a viewport move. Each hold is its own entry, so two surfaces on one
 * row release independently.
 * Driven through the real store and its real planner; only the stream client
 * is a double, recording every `loadRange` the store sends.
 */
const EPIC_ID = "epic-hold";
const CHAT_ID = "chat-hold";
const OWNER_ID = "owner-hold";

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
    hostId: "host-hold",
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
        hostId: "host-hold",
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

describe("chat-session-store - held transcript ordinals", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates the held row without a viewport move or a jump", () => {
    const harness = createHarness();
    try {
      primeWindowAtTail(harness);
      expect(harness.rangeRequests).toEqual([]);

      harness.handle.store.getState().holdTranscriptOrdinal(5);

      const state = harness.handle.store.getState();
      expect(state.heldReadOrdinals).toEqual([5]);
      expect(state.jumpTargetOrdinal).toBeNull();
      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]).toMatchObject({
        fromOrdinal: 5,
        toOrdinal: 5,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps asking for the row while any hold on it stands, and stops after the last release", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      primeWindowAtTail(harness);
      const releaseFirst = harness.handle.store
        .getState()
        .holdTranscriptOrdinal(5);
      const releaseSecond = harness.handle.store
        .getState()
        .holdTranscriptOrdinal(5);
      expect(harness.rangeRequests).toHaveLength(1);

      releaseFirst();
      // A second release of the same hold changes nothing.
      releaseFirst();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(2);

      releaseSecond();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([]);
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(2);
    } finally {
      harness.handle.dispose();
    }
  });

  it("is held apart from a find read: releasing the hold leaves the read", () => {
    const harness = createHarness();
    try {
      primeWindowAtTail(harness);
      harness.handle.store.getState().requestFindReadOrdinal(6);
      const release = harness.handle.store.getState().holdTranscriptOrdinal(5);
      release();

      const state = harness.handle.store.getState();
      expect(state.findReadOrdinal).toBe(6);
      expect(state.heldReadOrdinals).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});
