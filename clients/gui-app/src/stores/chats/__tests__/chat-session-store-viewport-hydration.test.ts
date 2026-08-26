import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { TRANSCRIPT_WINDOW_MAX_BYTES } from "@/stores/chats/transcript-window";

const EPIC_ID = "epic-viewport";
const CHAT_ID = "chat-viewport";
const OWNER_ID = "owner-viewport";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT },
    timestamp,
    sessionAnchor: null,
  };
}

interface ViewportHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
}

function createViewportHarness(): ViewportHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-viewport",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
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

function snapshot(input: {
  readonly rowCount: number;
  readonly tailFromOrdinal: number;
  readonly tailMessages: readonly Message[];
}): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  const derived: ChatTranscriptDerived = {
    latestAssistantUsage: null,
    pinnedTodo: null,
    latestForkableAssistantMessageId: null,
    restorableSetupInterruption: null,
  };
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
        hostId: "host-viewport",
        title: "Viewport hydration",
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
      transcriptEpoch: 1,
      rowCount: input.rowCount,
      tail: {
        fromOrdinal: input.tailFromOrdinal,
        messages: [...input.tailMessages],
        events: [],
      },
      derived,
    },
  };
}

function range(
  fromOrdinal: number,
  toOrdinal: number,
): Parameters<ChatStreamCallbacks["onRange"]>[0] {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: `response-${fromOrdinal}-${toOrdinal}`,
      epoch: 1,
      fromOrdinal,
      rowIds: Array.from(
        { length: toOrdinal - fromOrdinal },
        (_unused, index) => `row-${fromOrdinal + index}`,
      ),
      messages: [userMessage(`m-${fromOrdinal}`, fromOrdinal)],
      events: [],
      reachedStart: fromOrdinal === 0,
      reachedEnd: toOrdinal === 40,
    },
  };
}

/** A single user message whose serialized body alone exceeds the window budget. */
function hugeUserMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x".repeat(TRANSCRIPT_WINDOW_MAX_BYTES + 1024),
              },
            ],
          },
        ],
      },
    },
    timestamp,
    sessionAnchor: null,
  };
}

function rangeWithMessages(
  fromOrdinal: number,
  rowIds: readonly string[],
  messages: readonly Message[],
): Parameters<ChatStreamCallbacks["onRange"]>[0] {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: `response-huge-${fromOrdinal}`,
      epoch: 1,
      fromOrdinal,
      rowIds: [...rowIds],
      messages: [...messages],
      events: [],
      reachedStart: fromOrdinal === 0,
      reachedEnd: false,
    },
  };
}

/** The legacy (pre-windowed) `chat.subscribe` snapshot shape - the whole
 * transcript rides inline on `snapshot.chat.messages`/`events`, with no
 * `tail`/`rowCount`/`derived`. */
function legacySnapshot(
  messages: readonly Message[],
): Parameters<ChatStreamCallbacks["onSnapshot"]>[0] {
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
        hostId: "host-viewport",
        title: "Viewport hydration",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
        messages: [...messages],
        events: [],
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
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
    },
  };
}

function hydrateTail(harness: ViewportHarness): void {
  harness.callbacks().onWindowedSnapshot(
    snapshot({
      rowCount: 40,
      tailFromOrdinal: 20,
      tailMessages: [userMessage("tail", 20)],
    }),
  );
}

describe("chat session viewport hydration", () => {
  it("requests an unhydrated tail when a snapshot has no tail bodies", () => {
    const harness = createViewportHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        snapshot({ rowCount: 40, tailFromOrdinal: 40, tailMessages: [] }),
      );

      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]).toMatchObject({
        epoch: 1,
        fromOrdinal: 20,
        toOrdinal: 40,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  it("requests a visible middle gap once the snapshot tail is hydrated", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });

      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]).toMatchObject({
        fromOrdinal: 10,
        toOrdinal: 20,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  it("deduplicates a repeated report while its range is in flight", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      const report = { fromOrdinal: 10, toOrdinal: 20 };
      harness.handle.store.getState().reportVisibleTranscriptRange(report);
      harness.handle.store.getState().reportVisibleTranscriptRange(report);

      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("plans the remaining gap after a partial range response", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      const report = { fromOrdinal: 10, toOrdinal: 20 };
      harness.handle.store.getState().reportVisibleTranscriptRange(report);
      harness.callbacks().onRange(range(10, 15));

      // The response clears the old in-flight request and immediately plans
      // the still-visible remainder. Re-reporting that same range is then
      // deduplicated against the new request.
      expect(harness.rangeRequests).toHaveLength(2);
      expect(harness.rangeRequests[1]).toMatchObject({
        fromOrdinal: 15,
        toOrdinal: 20,
      });
      harness.handle.store.getState().reportVisibleTranscriptRange(report);
      expect(harness.rangeRequests).toHaveLength(2);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not request when the visible range is cleared", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store.getState().reportVisibleTranscriptRange(null);
      expect(harness.rangeRequests).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not request a fully hydrated visible range", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.callbacks().onRange(range(10, 20));
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });

      expect(harness.rangeRequests).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("chat session viewport hydration: review fixes", () => {
  it("an oversized visible range response is not evict-looped", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 5, toOrdinal: 6 });
      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]).toMatchObject({
        fromOrdinal: 5,
        toOrdinal: 6,
      });

      // A single row whose serialized body alone exceeds the whole window
      // budget - a legal host response (the range read always serves the
      // first requested row whatever it costs).
      harness
        .callbacks()
        .onRange(rangeWithMessages(5, ["row-5"], [hugeUserMessage("m-huge", 5)]));

      const messages = harness.handle.store.getState().messages;
      expect(messages.some((message) => message.messageId === "m-huge")).toBe(
        true,
      );

      // The plan is now satisfied - no new (or repeated) range request
      // follows, even though the span the reader is looking at alone blows
      // the byte budget. A re-request here would be the evict-loop this
      // fix exists to prevent.
      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a legacy snapshot after a windowed one resets the line", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      expect(harness.handle.store.getState().transcriptWindow.rowCount).toBe(
        40,
      );

      harness.callbacks().onSnapshot(legacySnapshot([userMessage("legacy-1", 1)]));

      const afterLegacy = harness.handle.store.getState();
      expect(afterLegacy.transcriptDerived).toBeNull();
      expect(afterLegacy.transcriptWindow.rowCount).toBe(0);
      expect(afterLegacy.messages.map((message) => message.messageId)).toEqual(
        ["legacy-1"],
      );

      // A straggler windowed frame for the abandoned epoch must be ignored
      // outright - it must not touch `messages` or rebuild windowed state.
      harness.callbacks().onRange(range(10, 15));

      const finalState = harness.handle.store.getState();
      expect(finalState.messages.map((message) => message.messageId)).toEqual(
        ["legacy-1"],
      );
      expect(finalState.transcriptWindow.rowCount).toBe(0);
      expect(finalState.transcriptDerived).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("the viewport report warms the visible span", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.callbacks().onRange(range(10, 15));
      const before = harness.handle.store
        .getState()
        .transcriptWindow.spans.find((span) => span.fromOrdinal === 10)
        ?.touchedAt;
      expect(before).toBeDefined();

      // Already hydrated, so reporting it visible plans no new fetch...
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 15 });
      expect(harness.rangeRequests).toHaveLength(0);

      // ...but it does warm the span's LRU clock, which is what keeps it from
      // reading as coldest the next time eviction runs.
      const after = harness.handle.store
        .getState()
        .transcriptWindow.spans.find((span) => span.fromOrdinal === 10)
        ?.touchedAt;
      expect(after ?? -1).toBeGreaterThan(before ?? -1);
    } finally {
      harness.handle.dispose();
    }
  });
});
