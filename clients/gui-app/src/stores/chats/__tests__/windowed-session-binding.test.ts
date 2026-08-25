import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatAccumulatedFileChangeSummary,
  ChatLoadRangeRequest,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";

/**
 * # The wait-for-tail rule
 *
 * The session store's authoritative-snapshot fold decides, among other things,
 * whether a pending send ever landed - and it decides by looking for it in the
 * records it was handed. On the legacy line that question is sound because the
 * snapshot carries the whole transcript. On the windowed line it is not:
 * `messages` holds what is HYDRATED, so "absent" can mean "not fetched yet".
 *
 * Getting that wrong restores an already-sent message into the composer and the
 * user sends it twice, which is worse than any rendering bug in this feature.
 * These tests pin the sequencing that prevents it.
 *
 * The frames are delivered straight to the store's callbacks. That is not a
 * shortcut around the transport - `chatSubscribeV17` is unregistered, so no
 * handshake can negotiate the windowed line at all (the client declares its own
 * canonical minor whenever the host's is newer). The callback surface is where
 * this behaviour lives either way.
 */

const EPIC_ID = "epic-w";
const CHAT_ID = "chat-w";
const OWNER_ID = "owner-1";

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

interface WindowedHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  readonly resnapshotCount: () => number;
  callbacks(): ChatStreamCallbacks;
}

function createWindowedHarness(): WindowedHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let resnapshots = 0;
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-a",
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
        requestResnapshot: () => {
          resnapshots += 1;
        },
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    rangeRequests,
    resnapshotCount: () => resnapshots,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function windowedSnapshot(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly tailFromOrdinal: number;
  readonly tailMessages: readonly Message[];
  readonly accumulatedFileChangeCount: number;
}): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
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
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: input.accumulatedFileChangeCount,
      managedCommands: [],
      heldUpdates: [],
      transcriptEpoch: input.epoch,
      rowCount: input.rowCount,
      tail: {
        fromOrdinal: input.tailFromOrdinal,
        messages: [...input.tailMessages],
        events: [],
      },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        latestForkableAssistantMessageId: "assistant-9",
        restorableSetupInterruption: null,
      },
    },
  };
}

describe("windowed snapshot with a hydrated tail", () => {
  it("applies the shared fold immediately and publishes the tail", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 3,
          tailFromOrdinal: 1,
          tailMessages: [userMessage("m-1", 1), userMessage("m-2", 2)],
          accumulatedFileChangeCount: 7,
        }),
      );

      const state = harness.handle.store.getState();
      expect(state.snapshotLoaded).toBe(true);
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-1",
        "m-2",
      ]);
      expect(state.transcriptWindow.rowCount).toBe(3);
      expect(state.transcriptWindow.epoch).toBe(4);
      // Host-computed folds a windowed client cannot derive for itself.
      expect(state.transcriptDerived?.latestForkableAssistantMessageId).toBe(
        "assistant-9",
      );
      expect(state.accumulatedFileChangeCount).toBe(7);
      // Nothing missing, so nothing asked for.
      expect(harness.rangeRequests).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("windowed snapshot whose tail arrived empty", () => {
  it("does NOT run the fold, and asks for the tail instead", () => {
    // The host's tail walks backwards under a hard ceiling with no
    // always-serve-one exception, so a chat whose last row is over that budget
    // ships zero rows. Running the fold here would let it conclude that a
    // pending send never landed.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 40,
          tailFromOrdinal: 40,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );

      const state = harness.handle.store.getState();
      // `snapshotLoaded` is set INSIDE the fold, so this is the observable
      // proof that no reconcile pass ran - not merely that its result looked
      // unchanged.
      expect(state.snapshotLoaded).toBe(false);
      expect(state.messages).toEqual([]);
      // The index landed even though the fold did not: the window is what the
      // tail request is framed against.
      expect(state.transcriptWindow.rowCount).toBe(40);

      expect(harness.rangeRequests).toHaveLength(1);
      const request = harness.rangeRequests[0];
      expect(request.epoch).toBe(4);
      expect(request.toOrdinal).toBe(40);
      expect(request.fromOrdinal).toBeLessThan(40);
    } finally {
      harness.handle.dispose();
    }
  });

  it("runs the held fold as soon as the tail range lands", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 2,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(harness.handle.store.getState().snapshotLoaded).toBe(false);

      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: "req-1",
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
          reachedStart: true,
          reachedEnd: true,
        },
      });

      const state = harness.handle.store.getState();
      expect(state.snapshotLoaded).toBe(true);
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-0",
        "m-1",
      ]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps holding when the range that lands does not reach the tail", () => {
    // A `maxBytes` truncation answers with a prefix of what was asked for. The
    // rule is about the TAIL being present, not about a response having
    // arrived - so a short answer must not release the fold.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 4,
          tailFromOrdinal: 4,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );
      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: "req-1",
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0)],
          events: [],
          reachedStart: true,
          reachedEnd: false,
          truncatedAtOrdinal: 2,
        },
      });

      expect(harness.handle.store.getState().snapshotLoaded).toBe(false);
      // And it asked again for the part still missing rather than settling.
      expect(harness.rangeRequests.length).toBeGreaterThan(1);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("index deltas", () => {
  it("asks for a resnapshot rather than a range when the index is declared void", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      const rangesBefore = harness.rangeRequests.length;

      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 5,
        rowCount: 2,
        changes: [{ type: "reindexed" }],
      });

      expect(harness.resnapshotCount()).toBe(1);
      // A range against a void index would seat bodies in a coordinate space
      // this client has already left.
      expect(harness.rangeRequests).toHaveLength(rangesBefore);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("accumulated-change chunks", () => {
  it("assembles chunks in order and lets a fresh first chunk replace the set", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });

      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          summaries: [summary("a.ts"), summary("b.ts")],
          isFinal: false,
        },
      });
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 2,
          summaries: [summary("c.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);

      // A re-streamed set starts at 0 and must REPLACE, not append - otherwise
      // a reconnect doubles every row the panel shows.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 5,
          fromIndex: 0,
          summaries: [summary("z.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["z.ts"]);
    } finally {
      harness.handle.dispose();
    }
  });
});
