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
