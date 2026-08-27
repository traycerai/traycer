import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatAccumulatedFileChangeSummary,
  ChatLoadRangeRequest,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { createImageResolutionUpdatedFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { isTailHydrated } from "@/stores/chats/transcript-window";

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
 * The frames are delivered straight to the store's callbacks rather than
 * through a negotiated stream. That is deliberate rather than a shortcut: this
 * behaviour lives on the callback surface, and driving it directly is what lets
 * a test place an `indexChanged` between a `loadRange` and its answer - the
 * reordering these fixtures exist to pin, and one a real handshake gives no way
 * to schedule.
 */

const EPIC_ID = "epic-w";
const CHAT_ID = "chat-w";
const OWNER_ID = "owner-1";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

/**
 * The `messageAccepted` frame's own message type. NOT the `Message` below: the
 * two are structurally identical and nominally distinct (the frame's resolves
 * through the subscribe union's schema instance), so a fixture typed as one
 * cannot be passed where the other is expected.
 */
type AcceptedMessage = Parameters<
  ChatStreamCallbacks["onMessageAccepted"]
>[0]["message"];

function acceptedMessage(
  messageId: string,
  timestamp: number,
): AcceptedMessage {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT },
    timestamp,
    sessionAnchor: null,
  };
}

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

function assistantMessage(messageId: string, timestamp: number): Message {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

type AssistantBlocks = Extract<Message, { role: "assistant" }>["blocks"];

function assistantWithBlocks(
  messageId: string,
  timestamp: number,
  turnId: string,
  blocks: AssistantBlocks,
): Message {
  const base = assistantMessage(messageId, timestamp);
  return base.role === "assistant" ? { ...base, turnId, blocks } : base;
}

function raiseActiveTurn(callbacks: ChatStreamCallbacks, turnId: string): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "running",
    activeTurn: {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId,
      status: "running",
      harnessId: "codex",
      model: "gpt-5.4",
      profileId: null,
      userMessageId: "m-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    },
  });
}

function blockOf(
  message: Message | undefined,
  blockId: string,
): AssistantBlocks[number] | undefined {
  if (message === undefined || message.role !== "assistant") return undefined;
  return message.blocks.find((block) => block.blockId === blockId);
}

function appendedEvent(
  eventId: string,
): Parameters<ChatStreamCallbacks["onEventAppended"]>[0] {
  return {
    kind: "eventAppended",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    event: {
      eventId,
      type: "turn.completed",
      timestamp: 9,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: "turn-1",
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    },
  };
}

interface WindowedHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  readonly resnapshotCount: () => number;
  callbacks(): ChatStreamCallbacks;
  /**
   * The id a `range` frame must carry to be seated.
   *
   * The store discards a response that does not answer its outstanding
   * request, so a fixture inventing an id would be testing the discard path
   * rather than the seat path. Throws when nothing is outstanding, because
   * that is a frame the host has no reason to send.
   */
  lastRangeRequestId(): string;
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
    lastRangeRequestId: () => {
      const last = rangeRequests.at(-1);
      if (last === undefined) throw new Error("Expected an outstanding range");
      return last.requestId;
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
        pinnedTaskTodoItems: [],
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
      // 39, not 40: the wire's `toOrdinal` is INCLUSIVE, and with `rowCount`
      // 40 the last row is ordinal 39. Asking for 40 asked for a row that does
      // not exist - which is what forwarding the planner's exclusive bound
      // unconverted did on every request.
      expect(request.toOrdinal).toBe(39);
      expect(request.fromOrdinal).toBeLessThan(39);
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
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0)],
          events: [],
          rowContext: {},
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

  it("clears the previous epoch's rows instead of leaving them on screen", () => {
    // A reconnect or reindex rebases the transcript into a new coordinate
    // space, and `applyWindowedSnapshot` returns an empty window for it. The
    // fold is held until the new tail lands - but the rows the reader is
    // looking at belong to the epoch that just ended, and holding them means
    // the row merge treats them as unplaced rows of a space they were never
    // numbered in. If the tail is slow or lost, that is what stays on screen.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("old-0", 1), userMessage("old-1", 2)],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(
        harness.handle.store
          .getState()
          .messages.map((message) => message.messageId),
      ).toEqual(["old-0", "old-1"]);

      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 40,
          tailFromOrdinal: 40,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );

      const state = harness.handle.store.getState();
      expect(state.transcriptWindow.epoch).toBe(5);
      // Proof this is the DEFERRAL path rather than the fold: the window has
      // no span covering the last row, so the store is waiting on a tail it
      // has just asked for. (`snapshotLoaded` says nothing here - it latched
      // true on the first snapshot and a deferral does not clear it.)
      expect(isTailHydrated(state.transcriptWindow)).toBe(false);
      expect(harness.rangeRequests.at(-1)?.epoch).toBe(5);
      // And nothing from epoch 4 survived into it.
      expect(state.messages).toEqual([]);
      expect(state.events).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("an unanswered range request", () => {
  it("is retried once its wait runs out", () => {
    // The in-flight slot is the dedup key: while it holds a request for a
    // range, every later plan for that range is suppressed as already-asked.
    // A `loadRange` or its response dropped on a stream that stays OPEN clears
    // nothing, so the gap stays placeholders until the viewport moves or the
    // connection is rebuilt - neither of which is guaranteed to happen.
    vi.useFakeTimers();
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
      expect(harness.rangeRequests).toHaveLength(1);
      const first = harness.rangeRequests[0];

      // Nothing answers. Re-planning on its own is suppressed by the slot,
      // which is the wedge - so the wait has to expire.
      vi.advanceTimersByTime(29_000);
      expect(harness.rangeRequests).toHaveLength(1);
      vi.advanceTimersByTime(2_000);

      expect(harness.rangeRequests).toHaveLength(2);
      const retry = harness.rangeRequests[1];
      // The same gap, asked again under a NEW id - so the abandoned request's
      // answer, if it ever arrives, is discarded rather than seated.
      expect(retry.fromOrdinal).toBe(first.fromOrdinal);
      expect(retry.toOrdinal).toBe(first.toOrdinal);
      expect(retry.epoch).toBe(first.epoch);
      expect(retry.requestId).not.toBe(first.requestId);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("is not retried once it has been answered", () => {
    // The timeout is armed per request id and released with the slot. A
    // response that seats its range must take the deadline with it, or every
    // answered request mints a duplicate one timeout later.
    vi.useFakeTimers();
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
      expect(harness.rangeRequests).toHaveLength(1);

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
      expect(harness.handle.store.getState().snapshotLoaded).toBe(true);

      vi.advanceTimersByTime(120_000);

      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
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

  it("asks again when the resnapshot it was waiting for never arrives", () => {
    // The same wedge an unanswered range request has, and worse: the latch
    // that keeps an invalidated window from asking once per frame is cleared
    // only by a snapshot, which is exactly what is missing. Every ordinal in a
    // void index belongs to a coordinate space this client has left, so
    // nothing on screen can be repaired until one lands.
    vi.useFakeTimers();
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

      // Nothing answers, and no further frame arrives to re-drive the plan.
      vi.advanceTimersByTime(31_000);

      expect(harness.resnapshotCount()).toBe(2);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("stops asking once the snapshot lands", () => {
    // The latch and its deadline are released together, so an answered
    // resnapshot does not mint a duplicate one timeout later.
    vi.useFakeTimers();
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

      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      vi.advanceTimersByTime(120_000);

      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
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

      // The chunks follow a windowed snapshot on the wire, and the store now
      // requires that: a chunk arriving on a session that has NOT negotiated
      // the windowed line is a straggler from an abandoned epoch, and seating
      // it would leave the panel serving rows the legacy line has no way to
      // clear.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 3,
        }),
      );

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

  /**
   * A chunk that starts PAST the assembled end is one whose predecessor was
   * dropped. `slice(0, fromIndex)` cannot say so - on a shorter array it
   * returns the whole thing and appends, so every entry from there on sits
   * BELOW the index the host gave it and the panel attributes each row's
   * digest and counts to the wrong file.
   */
  it("drops an accumulated chunk whose predecessor was lost, rather than misplacing it", () => {
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
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 4,
        }),
      );
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          summaries: [summary("a.ts")],
          isFinal: false,
        },
      });
      // fromIndex 3 against an assembled length of 1: chunk 2 never arrived.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 3,
          summaries: [summary("d.ts")],
          isFinal: true,
        },
      });

      const state = harness.handle.store.getState();
      // "d.ts" is NOT seated at index 1 wearing "b.ts"'s position.
      expect(
        state.accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts"]);
      // And the shortfall stays visible, which is what holds "Review all" back.
      expect(
        state.accumulatedFileChangeCount -
          state.accumulatedFileChangeSummaries.length,
      ).toBe(3);
      // Dropping alone would strand the panel: the host streams these chunks
      // only while rebuilding an index, so nothing on the ordinary path sends
      // them again. The resnapshot is the restart.
      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  /**
   * An aux-only re-broadcast - a queue change, an approval - re-sends the
   * snapshot against an unchanged skeleton, and the host emits accumulated
   * chunks only while REBUILDING a subscriber's index. So a snapshot is not
   * proof that a re-stream is coming, and clearing the assembled summaries on
   * one empties the panel for the rest of the session while the header goes on
   * counting files it can no longer list.
   */
  it("keeps the assembled summaries across an aux-only snapshot re-broadcast", () => {
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
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 1,
        }),
      );
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          summaries: [summary("a.ts")],
          isFinal: true,
        },
      });
      // Same epoch, same rows: nothing here re-streams the summaries.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 1,
        }),
      );

      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts"]);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("a record that arrives with no ordinal", () => {
  /**
   * The host emits `messageAccepted` / `eventAppended` the moment the append
   * commits, and moves the INDEX only on its next snapshot - verified against
   * `chat-session-manager.ts`, where the accept path broadcasts the body and
   * calls no `broadcastSnapshot`. So a record genuinely exists on the client
   * with nowhere in the ordinal space to live, and it has to survive every
   * windowed frame that arrives before the index catches up.
   */
  function seatHydratedSnapshot(harness: WindowedHarness): void {
    harness.callbacks().onWindowedSnapshot(
      windowedSnapshot({
        epoch: 4,
        rowCount: 1,
        tailFromOrdinal: 0,
        tailMessages: [userMessage("m-0", 0)],
        accumulatedFileChangeCount: 0,
      }),
    );
  }

  it("survives a skeleton chunk, which is what the old code got wrong", () => {
    // Before write-through, `onMessageAccepted` appended to `state.messages`
    // and the next `publishWindowedTranscript` - triggered by ANY windowed
    // frame - rebuilt that array from the window and dropped it.
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-live", 9),
      });
      expect(
        harness.handle.store
          .getState()
          .messages.map((message) => message.messageId),
      ).toEqual(["m-0", "m-live"]);

      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromOrdinal: 0,
          entries: [
            { rowId: "row-0", createdAt: 1, role: "user", byteLength: 10 },
          ],
          isFinal: true,
        },
      });

      expect(
        harness.handle.store
          .getState()
          .messages.map((message) => message.messageId),
      ).toEqual(["m-0", "m-live"]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("routes an appended EVENT the same way", () => {
    // Same defect class as the message above, and it needs its own case: the
    // two appliers are separate branches, so a fix to one leaves the other
    // writing into an array the next frame rebuilds.
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onEventAppended({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          eventId: "e-live",
          type: "turn.completed",
          timestamp: 9,
          clientActionId: null,
          actor: null,
          message: null,
          turnId: "turn-1",
          messageId: null,
          queueItemId: null,
          approvalId: null,
          blockId: null,
          severity: "info",
          metadata: null,
        },
      });
      expect(
        harness.handle.store.getState().events.map((event) => event.eventId),
      ).toEqual(["e-live"]);

      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromOrdinal: 0,
          entries: [
            { rowId: "row-0", createdAt: 1, role: "user", byteLength: 10 },
          ],
          isFinal: true,
        },
      });

      expect(
        harness.handle.store.getState().events.map((event) => event.eventId),
      ).toEqual(["e-live"]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("is superseded, not duplicated, once a range brings the placed copy", () => {
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-live", 9),
      });

      // The index catches up and names a row for it. That un-hydrates the
      // tail, which is what makes the client ask - a `range` only ever arrives
      // in answer to a `loadRange`, so the fetch has to be real for the
      // response below to be one the host could send.
      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 4,
        rowCount: 2,
        changes: [
          {
            type: "appended",
            entries: [
              { rowId: "row-1", createdAt: 9, role: "user", byteLength: 128 },
            ],
          },
        ],
      });
      expect(harness.rangeRequests).toHaveLength(1);

      // The host's own copy, now with an ordinal.
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
          messages: [userMessage("m-0", 0), userMessage("m-live", 9)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: true,
        },
      });

      const state = harness.handle.store.getState();
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-0",
        "m-live",
      ]);
      // Pruned rather than kept alongside: a live copy that outlived its
      // hydration would reappear the moment its span was evicted.
      expect(state.transcriptWindow.liveMessages).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("is dropped on a rebase, because the coordinate space changed", () => {
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-live", 9),
      });
      expect(
        harness.handle.store.getState().transcriptWindow.liveMessages,
      ).toHaveLength(1);

      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 5,
        rowCount: 1,
        changes: [{ type: "reindexed" }],
      });

      // A `reindexed` says every ordinal now names a different row. Anything
      // the client was holding unplaced says nothing about the new space, and
      // the resnapshot re-delivers whatever is real.
      expect(
        harness.handle.store.getState().transcriptWindow.liveMessages,
      ).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not take the window path on the legacy line", () => {
    // No windowed snapshot ever arrived, so `messageAccepted` must still
    // append to `state.messages` exactly as it always has.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-legacy", 1),
      });
      const state = harness.handle.store.getState();
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-legacy",
      ]);
      expect(state.transcriptWindow.liveMessages).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * A row-targeted delta names a row that ALREADY has an ordinal, which is what
 * separates these from `messageAccepted`: the question is not where the record
 * goes, it is whether the write survives.
 *
 * On this line it only survives in the WINDOW. `state.messages` is rebuilt from
 * the window by the next windowed frame of any kind, so an applier that spliced
 * the published array would look correct until the next frame - and the next
 * frame is a skeleton chunk on any reconnect, or simply the next appended
 * event.
 */
describe("a row-targeted delta on the windowed line", () => {
  function resolutionCount(harness: WindowedHarness): number {
    const row = harness.handle.store
      .getState()
      .messages.find((message) => message.messageId === "a-1");
    if (row === undefined || row.role !== "assistant") return -1;
    return row.imageResolutions.length;
  }

  function seedAndResolve(harness: WindowedHarness): void {
    harness.callbacks().onWindowedSnapshot(
      windowedSnapshot({
        epoch: 4,
        rowCount: 2,
        tailFromOrdinal: 0,
        tailMessages: [userMessage("m-1", 1), assistantMessage("a-1", 2)],
        accumulatedFileChangeCount: 0,
      }),
    );
    harness.callbacks().onBlockDelta(
      createImageResolutionUpdatedFrame({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "image_resolution.updated",
          blockId: "a-1",
          messageId: "a-1",
          timestamp: 3,
          turnId: "turn-1",
          entry: {
            source: "chart.png",
            canonicalSource: "chart.png",
            state: "resolved",
            attachmentHash: "hash-1",
            mediaType: "image/png",
            width: null,
            height: null,
          },
        },
      }),
    );
  }

  it("survives the republish that the next windowed frame performs", () => {
    const harness = createWindowedHarness();
    try {
      seedAndResolve(harness);
      expect(resolutionCount(harness)).toBe(1);

      // The frame that used to erase it. Any windowed frame would do; an
      // appended event is the one that needs no reconnect to arrive.
      harness.callbacks().onEventAppended(appendedEvent("e-1"));

      expect(resolutionCount(harness)).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("carries a steer-split block through to the frozen row, and keeps it", () => {
    // Consumer 10. Three appliers share `rewriteMessageInPlace`, and sharing a
    // helper is not the same as using it - a mutation that un-wires THIS one
    // passed every test until this existed.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 3,
          tailFromOrdinal: 0,
          tailMessages: [
            assistantWithBlocks("a-frozen", 1, "turn-1", [
              {
                type: "text",
                blockId: "b-1",
                status: "streaming",
                timestamp: 1,
                text: "before",
                providerNotice: null,
              },
            ]),
            // The steer bubble sits between the split siblings.
            userMessage("m-steer", 2),
            assistantWithBlocks("a-continuation", 3, "turn-1", []),
          ],
          accumulatedFileChangeCount: 0,
        }),
      );
      raiseActiveTurn(harness.callbacks(), "turn-1");

      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "text.delta",
          blockId: "b-1",
          timestamp: 4,
          delta: " and after",
        },
      });

      const frozenBlock = (): AssistantBlocks[number] | undefined =>
        blockOf(
          harness.handle.store
            .getState()
            .messages.find((message) => message.messageId === "a-frozen"),
          "b-1",
        );
      const carried = frozenBlock();
      expect(carried?.type === "text" ? carried.text : "").toBe(
        "before and after",
      );

      harness.callbacks().onEventAppended(appendedEvent("e-carry"));
      const survived = frozenBlock();
      expect(survived?.type === "text" ? survived.text : "").toBe(
        "before and after",
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("routes a detached background terminal to its settled row, and keeps it", () => {
    // Consumer 8, the third applier. Its owner row belongs to an ALREADY
    // SETTLED turn, which is what makes it a row-targeted delta at arbitrary
    // history rather than a tail write.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [
            assistantWithBlocks("a-settled", 2, "turn-settled", [
              {
                type: "command",
                blockId: "bg-command",
                status: "streaming",
                timestamp: 2,
                command: "sleep 20 && echo done",
                cwd: "/tmp",
                exitCode: null,
                backgroundTask: true,
                stopped: false,
              },
            ]),
          ],
          accumulatedFileChangeCount: 0,
        }),
      );
      raiseActiveTurn(harness.callbacks(), "turn-1");

      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "command.completed",
          blockId: "bg-command",
          timestamp: 30,
          command: "sleep 20 && echo done",
          exitCode: 0,
          backgroundTask: true,
        },
      });

      const settledBlock = (): AssistantBlocks[number] | undefined =>
        blockOf(
          harness.handle.store
            .getState()
            .messages.find((message) => message.messageId === "a-settled"),
          "bg-command",
        );
      const completed = settledBlock();
      expect(completed?.type === "command" ? completed.exitCode : null).toBe(0);

      harness.callbacks().onEventAppended(appendedEvent("e-detached"));
      const survived = settledBlock();
      expect(survived?.type === "command" ? survived.exitCode : null).toBe(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the ACTIVE turn's streamed blocks across an appended event", () => {
    // Consumer 11a - missed by the sweep, and the worst of the set. This row
    // is at the tail and hydrated by construction, which is exactly why the
    // bug reads as impossible: being hydrated is what makes the write LAND,
    // not what makes it SURVIVE. Every mid-turn event republished `messages`
    // from the window and took the streamed text with it.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [
            assistantWithBlocks("a-live", 1, "turn-1", [
              {
                type: "text",
                blockId: "b-live",
                status: "streaming",
                timestamp: 1,
                text: "start",
                providerNotice: null,
              },
            ]),
          ],
          accumulatedFileChangeCount: 0,
        }),
      );
      raiseActiveTurn(harness.callbacks(), "turn-1");

      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "text.delta",
          blockId: "b-live",
          timestamp: 4,
          delta: " and more",
        },
      });

      const streamedText = (): string => {
        const block = blockOf(
          harness.handle.store
            .getState()
            .messages.find((message) => message.messageId === "a-live"),
          "b-live",
        );
        return block?.type === "text" ? block.text : "";
      };
      expect(streamedText()).toBe("start and more");

      harness.callbacks().onEventAppended(appendedEvent("e-mid-turn"));
      expect(streamedText()).toBe("start and more");

      // And it took the DEFERRED charge. Both charge modes are behaviourally
      // identical - the eager one is simply the wrong cost on a growing row
      // written per delta - so nothing else here can tell them apart, and a
      // silent switch back to eager would be an invisible regression.
      expect(
        harness.handle.store.getState().transcriptWindow
          .unsettledByteMessageIds,
      ).toEqual(["a-live"]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("lands in the window itself, not only in the published array", () => {
    // The stronger statement, and the one that does not depend on which frame
    // happens to arrive next: the span holding the row carries the resolution.
    const harness = createWindowedHarness();
    try {
      seedAndResolve(harness);
      const span = harness.handle.store.getState().transcriptWindow.spans[0];
      const row = span.messages.find((message) => message.messageId === "a-1");
      expect(
        row?.role === "assistant" ? row.imageResolutions : [],
      ).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });
});
