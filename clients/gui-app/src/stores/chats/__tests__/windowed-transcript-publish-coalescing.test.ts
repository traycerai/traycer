import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatLoadRangeRequest } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  FRESH_SKELETON_HOLD_IDLE_MS,
  STREAM_COMPLETION_TIMEOUT_MS,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  IMMEDIATE_STREAM_FLUSH_COORDINATOR,
  type StreamFlushCoordinator,
} from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * # Coalesced transcript publishes
 *
 * Every publish of a new `transcriptWindow` re-derives the whole transcript
 * list in React. A skeleton streams in several chunks and a busy turn echoes
 * an index change per write, so the store buffers both and folds them on the
 * stream-flush coordinator's tick, publishing once per tick instead of once per
 * frame.
 *
 * The contract these pin:
 *
 * - k buffered frames publish the window once;
 * - the state a tick publishes is the state the per-frame path reaches;
 * - nothing from the stream overtakes a buffered frame - every other frame
 *   applies the buffer before itself, as the frames used to apply on arrival.
 */

const EPIC_ID = "epic-c";
const CHAT_ID = "chat-c";
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
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function skeletonEntry(ordinal: number): RowSkeletonEntry {
  return {
    rowId: `row-${String(ordinal)}`,
    createdAt: ordinal,
    role: "user",
    byteLength: 10,
    bodyDigest: `d${String(ordinal)}`,
  };
}

type SkeletonChunkFrame = Parameters<ChatStreamCallbacks["onSkeletonChunk"]>[0];
type IndexChangedFrame = Parameters<ChatStreamCallbacks["onIndexChanged"]>[0];
type WindowedSnapshotFrame = Parameters<
  ChatStreamCallbacks["onWindowedSnapshot"]
>[0];

function skeletonChunk(input: {
  readonly epoch: number;
  readonly fromOrdinal: number;
  readonly count: number;
  readonly isFinal: boolean;
}): SkeletonChunkFrame {
  return {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    chunk: {
      epoch: input.epoch,
      fromOrdinal: input.fromOrdinal,
      entries: Array.from({ length: input.count }, (_, index) =>
        skeletonEntry(input.fromOrdinal + index),
      ),
      isFinal: input.isFinal,
    },
  };
}

function appendedChange(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly indexRevision: number;
}): IndexChangedFrame {
  return {
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    epoch: input.epoch,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    changes: [
      { type: "appended", entries: [skeletonEntry(input.rowCount - 1)] },
    ],
  };
}

function windowedSnapshot(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly tailFromOrdinal: number;
  readonly tailMessages: readonly Message[];
  /**
   * `null` announces a rebuild - a full replacement skeleton streams behind
   * it. A live revision is an aux-only or append republish.
   */
  readonly indexRevision: number | null;
}): WindowedSnapshotFrame {
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
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      transcriptEpoch: input.epoch,
      rowCount: input.rowCount,
      indexRevision: input.indexRevision,
      tail: {
        fromOrdinal: input.tailFromOrdinal,
        messages: [...input.tailMessages],
        events: [],
      },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
    },
  };
}

/** Rows 0..11, the last two seated by the snapshot's tail. */
const ROW_COUNT = 12;

function openSnapshot(): WindowedSnapshotFrame {
  return windowedSnapshot({
    epoch: 1,
    rowCount: ROW_COUNT,
    tailFromOrdinal: 10,
    tailMessages: [userMessage("row-10", 10), userMessage("row-11", 11)],
    indexRevision: null,
  });
}

/** The skeleton in three chunks, the way the host streams a long one. */
function skeletonInChunks(): readonly [
  SkeletonChunkFrame,
  SkeletonChunkFrame,
  SkeletonChunkFrame,
] {
  return [
    skeletonChunk({ epoch: 1, fromOrdinal: 0, count: 4, isFinal: false }),
    skeletonChunk({ epoch: 1, fromOrdinal: 4, count: 4, isFinal: false }),
    skeletonChunk({ epoch: 1, fromOrdinal: 8, count: 4, isFinal: true }),
  ];
}

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  readonly resnapshotCount: () => number;
  /** How many times a publish replaced `transcriptWindow`. */
  readonly windowPublishCount: () => number;
  callbacks(): ChatStreamCallbacks;
  /** The coordinator's tick. A no-op on the immediate harness. */
  tick(): void;
}

function createHarnessWith(
  streamFlushCoordinator: StreamFlushCoordinator,
  tick: () => void,
): Harness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let resnapshots = 0;
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
    streamFlushCoordinator,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
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
  let windowPublishes = 0;
  handle.store.subscribe((state, previous) => {
    if (state.transcriptWindow !== previous.transcriptWindow) {
      windowPublishes += 1;
    }
  });
  return {
    handle,
    rangeRequests,
    resnapshotCount: () => resnapshots,
    windowPublishCount: () => windowPublishes,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
    tick,
  };
}

/** Per-frame: the coordinator flushes inside every `requestFlush`. */
function createImmediateHarness(): Harness {
  return createHarnessWith(IMMEDIATE_STREAM_FLUSH_COORDINATOR, () => {});
}

/**
 * Coalescing: frames wait in the store's buffer until `tick()`, which stands
 * in for the coordinator's animation-frame flush.
 */
function createTickedHarness(): Harness {
  let flush: (() => void) | null = null;
  return createHarnessWith(
    {
      register: (input) => {
        flush = input.flush;
        return {
          requestFlush: () => {},
          setVisible: () => {},
          unregister: () => {
            flush = null;
          },
        };
      },
    },
    () => {
      if (flush !== null) flush();
    },
  );
}

/** What a reader of the store can see of the transcript. */
function transcriptOf(state: ChatSessionState): {
  readonly window: ChatSessionState["transcriptWindow"];
  readonly messages: ChatSessionState["messages"];
  readonly events: ChatSessionState["events"];
} {
  return {
    window: state.transcriptWindow,
    messages: state.messages,
    events: state.events,
  };
}

describe("coalesced transcript publishes", () => {
  it("publishes k buffered skeleton chunks as one window", () => {
    const harness = createTickedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      const afterSnapshot = harness.windowPublishCount();
      const before = harness.handle.store.getState().transcriptWindow;

      for (const chunk of skeletonInChunks()) {
        harness.callbacks().onSkeletonChunk(chunk);
      }
      // Buffered: no publish, and the store still holds the pre-chunk window.
      expect(harness.windowPublishCount()).toBe(afterSnapshot);
      expect(harness.handle.store.getState().transcriptWindow).toBe(before);

      harness.tick();

      expect(harness.windowPublishCount()).toBe(afterSnapshot + 1);
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.skeletonComplete).toBe(true);
      expect(window.skeleton.map((entry) => entry?.rowId)).toEqual(
        Array.from(
          { length: ROW_COUNT },
          (_, ordinal) => skeletonEntry(ordinal).rowId,
        ),
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("reaches the same transcript and the same plan as publishing per chunk", () => {
    // A REBUILD stream, restreaming into a skeleton the client already holds:
    // the kind that still publishes per chunk under the immediate coordinator
    // (a fresh stream is held for its final chunk under any coordinator).
    const perFrame = createImmediateHarness();
    const ticked = createTickedHarness();
    try {
      for (const harness of [perFrame, ticked]) {
        harness.callbacks().onWindowedSnapshot(openSnapshot());
        for (const chunk of skeletonInChunks()) {
          harness.callbacks().onSkeletonChunk(chunk);
        }
        harness.tick();
      }
      const perFrameBefore = perFrame.windowPublishCount();
      const tickedBefore = ticked.windowPublishCount();

      for (const harness of [perFrame, ticked]) {
        harness.callbacks().onWindowedSnapshot(openSnapshot());
        harness.handle.store
          .getState()
          .reportVisibleTranscriptRange({ fromOrdinal: 2, toOrdinal: 6 });
        for (const chunk of skeletonInChunks()) {
          harness.callbacks().onSkeletonChunk(chunk);
        }
        harness.tick();
      }

      // One publish per chunk, against one for the whole batch.
      expect(perFrame.windowPublishCount() - perFrameBefore).toBeGreaterThan(
        ticked.windowPublishCount() - tickedBefore,
      );
      expect(transcriptOf(ticked.handle.store.getState())).toEqual(
        transcriptOf(perFrame.handle.store.getState()),
      );
      // The plan in force is the same request. The per-frame path may have
      // asked for intermediate ranges on the way there; the batch never
      // planned against a window it did not publish.
      const planOf = (harness: Harness) => {
        const last = harness.rangeRequests.at(-1);
        return last === undefined
          ? null
          : {
              epoch: last.epoch,
              fromOrdinal: last.fromOrdinal,
              toOrdinal: last.toOrdinal,
            };
      };
      expect(planOf(ticked)).not.toBeNull();
      expect(planOf(ticked)).toEqual(planOf(perFrame));
      expect(ticked.resnapshotCount()).toBe(perFrame.resnapshotCount());
    } finally {
      perFrame.handle.dispose();
      ticked.handle.dispose();
    }
  });

  it("publishes k buffered index changes as one window, equal to the per-frame result", () => {
    const perFrame = createImmediateHarness();
    const ticked = createTickedHarness();
    try {
      for (const harness of [perFrame, ticked]) {
        harness.callbacks().onWindowedSnapshot(openSnapshot());
        for (const chunk of skeletonInChunks()) {
          harness.callbacks().onSkeletonChunk(chunk);
        }
        harness.tick();
      }
      const tickedBefore = ticked.windowPublishCount();

      for (const harness of [perFrame, ticked]) {
        for (let revision = 1; revision <= 3; revision += 1) {
          harness.callbacks().onIndexChanged(
            appendedChange({
              epoch: 1,
              rowCount: ROW_COUNT + revision,
              indexRevision: revision,
            }),
          );
        }
      }
      expect(ticked.windowPublishCount()).toBe(tickedBefore);
      ticked.tick();

      expect(ticked.windowPublishCount()).toBe(tickedBefore + 1);
      const tickedWindow = ticked.handle.store.getState().transcriptWindow;
      expect(tickedWindow.rowCount).toBe(ROW_COUNT + 3);
      expect(tickedWindow.invalidated).toBe(false);
      expect(transcriptOf(ticked.handle.store.getState())).toEqual(
        transcriptOf(perFrame.handle.store.getState()),
      );
    } finally {
      perFrame.handle.dispose();
      ticked.handle.dispose();
    }
  });

  it("applies buffered frames before any other stream frame, without waiting for the tick", () => {
    const harness = createTickedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      for (const chunk of skeletonInChunks()) {
        harness.callbacks().onSkeletonChunk(chunk);
      }
      expect(
        harness.handle.store.getState().transcriptWindow.skeletonComplete,
      ).toBe(false);

      // Any frame will do: this one has nothing to do with the transcript, and
      // it still lands behind the chunks that arrived before it.
      harness.callbacks().onManagedCommandsChanged({
        kind: "managedCommandsChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        managedCommands: [],
      });

      expect(
        harness.handle.store.getState().transcriptWindow.skeletonComplete,
      ).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("applies buffered frames before a snapshot that follows them", () => {
    // A snapshot that shrinks the row space arriving behind a chunk: per
    // frame, the chunk applied first and the snapshot's boundary then cut the
    // skeleton back to its `rowCount`. Folding the chunk AFTER the snapshot
    // would instead seat entries past the boundary the snapshot just drew.
    const perFrame = createImmediateHarness();
    const ticked = createTickedHarness();
    try {
      for (const harness of [perFrame, ticked]) {
        harness.callbacks().onWindowedSnapshot(openSnapshot());
        harness.callbacks().onSkeletonChunk(
          skeletonChunk({
            epoch: 1,
            fromOrdinal: 0,
            count: 4,
            isFinal: false,
          }),
        );
        harness.callbacks().onWindowedSnapshot(
          windowedSnapshot({
            epoch: 1,
            rowCount: 2,
            tailFromOrdinal: 0,
            tailMessages: [userMessage("row-0", 0), userMessage("row-1", 1)],
            indexRevision: null,
          }),
        );
        harness.tick();
      }

      expect(transcriptOf(ticked.handle.store.getState())).toEqual(
        transcriptOf(perFrame.handle.store.getState()),
      );
      expect(
        ticked.handle.store.getState().transcriptWindow.skeleton,
      ).toHaveLength(2);
    } finally {
      perFrame.handle.dispose();
      ticked.handle.dispose();
    }
  });

  it("restarts the stream watchdog when a batch of chunks lands, as a chunk did", () => {
    vi.useFakeTimers();
    const harness = createTickedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      // Late in the snapshot's own deadline, delivery progresses - but the
      // final chunk never arrives.
      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS - 1_000);
      for (const chunk of skeletonInChunks().slice(0, 2)) {
        harness.callbacks().onSkeletonChunk(chunk);
      }
      harness.tick();

      // Past the snapshot's deadline: the batch restarted the clock, so the
      // stall is not declared yet.
      vi.advanceTimersByTime(2_000);
      expect(harness.resnapshotCount()).toBe(0);

      // A full deadline after the batch, it is.
      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS);
      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("applies buffered frames before a retry replaces the stream they arrived on", () => {
    const harness = createTickedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      for (const chunk of skeletonInChunks()) {
        harness.callbacks().onSkeletonChunk(chunk);
      }

      harness.handle.store.getState().retry();
      harness.tick();

      expect(
        harness.handle.store.getState().transcriptWindow.skeletonComplete,
      ).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * # Holding a fresh skeleton for its final chunk
 *
 * A fresh stream describes placeholders whose list keys flip from their
 * ordinal to their row id when the chunk publishes - and every flip is a
 * whole-list re-layout. So a fresh stream publishes ONCE, at `isFinal`, under
 * any coordinator. A rebuild restreams onto described rows (no key flips) and
 * an index change is never a skeleton stream, so neither is held.
 */
describe("fresh skeleton hold", () => {
  function completeSkeleton(harness: Harness): void {
    harness.callbacks().onWindowedSnapshot(openSnapshot());
    for (const chunk of skeletonInChunks()) {
      harness.callbacks().onSkeletonChunk(chunk);
    }
    harness.tick();
  }

  it("publishes a fresh stream once, at its final chunk, even when every frame flushes on arrival", () => {
    const harness = createImmediateHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      const afterSnapshot = harness.windowPublishCount();
      const [first, second, last] = skeletonInChunks();

      harness.callbacks().onSkeletonChunk(first);
      harness.callbacks().onSkeletonChunk(second);
      expect(harness.windowPublishCount()).toBe(afterSnapshot);
      expect(
        harness.handle.store.getState().transcriptWindow.skeleton,
      ).toHaveLength(0);

      harness.callbacks().onSkeletonChunk(last);

      expect(harness.windowPublishCount()).toBe(afterSnapshot + 1);
      expect(
        harness.handle.store.getState().transcriptWindow.skeletonComplete,
      ).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not hold a rebuild restreaming onto rows it already describes", () => {
    const harness = createImmediateHarness();
    try {
      completeSkeleton(harness);
      // The rebuild boundary: same epoch, `indexRevision: null`.
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      const beforeChunk = harness.windowPublishCount();

      const [first] = skeletonInChunks();
      harness.callbacks().onSkeletonChunk(first);

      expect(harness.windowPublishCount()).toBe(beforeChunk + 1);
      expect(
        harness.handle.store.getState().transcriptWindow
          .skeletonStreamCoveredThrough,
      ).toBe(4);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not hold the append republish", () => {
    // The host's append order: the snapshot at the post-append `rowCount`
    // (declaring the skeleton short) and then the `indexChanged` that fills
    // it. Neither is a skeleton chunk, so nothing waits.
    const harness = createImmediateHarness();
    try {
      completeSkeleton(harness);
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 1,
          rowCount: ROW_COUNT + 1,
          tailFromOrdinal: 10,
          tailMessages: [userMessage("row-10", 10), userMessage("row-11", 11)],
          indexRevision: 0,
        }),
      );
      expect(
        harness.handle.store.getState().transcriptWindow.skeletonComplete,
      ).toBe(false);
      const beforeDelta = harness.windowPublishCount();

      harness.callbacks().onIndexChanged(
        appendedChange({
          epoch: 1,
          rowCount: ROW_COUNT + 1,
          indexRevision: 1,
        }),
      );

      expect(harness.windowPublishCount()).toBe(beforeDelta + 1);
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.skeleton[ROW_COUNT]?.rowId).toBe(
        skeletonEntry(ROW_COUNT).rowId,
      );
      expect(window.skeletonComplete).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not keep holding once another frame has forced the held stream out", () => {
    // The forced flush applied everything that was held, so nothing is left
    // to wait for: a frame after it publishes on its own tick.
    const harness = createImmediateHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      const [first] = skeletonInChunks();
      harness.callbacks().onSkeletonChunk(first);
      harness.callbacks().onManagedCommandsChanged({
        kind: "managedCommandsChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        managedCommands: [],
      });
      const beforeChange = harness.windowPublishCount();

      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 1,
        rowCount: ROW_COUNT,
        indexRevision: 1,
        changes: [
          {
            type: "updated",
            entries: [
              {
                ordinal: 0,
                entry: { ...skeletonEntry(0), bodyDigest: "d0-edited" },
              },
            ],
          },
        ],
      });

      expect(harness.windowPublishCount()).toBe(beforeChange + 1);
      expect(
        harness.handle.store.getState().transcriptWindow.skeleton[0]
          ?.bodyDigest,
      ).toBe("d0-edited");
    } finally {
      harness.handle.dispose();
    }
  });

  it("publishes what arrived when the stream goes quiet", () => {
    vi.useFakeTimers();
    const harness = createImmediateHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      const [first] = skeletonInChunks();
      harness.callbacks().onSkeletonChunk(first);
      expect(
        harness.handle.store.getState().transcriptWindow.skeleton,
      ).toHaveLength(0);

      vi.advanceTimersByTime(FRESH_SKELETON_HOLD_IDLE_MS);

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.skeletonStreamCoveredThrough).toBe(4);
      expect(window.skeletonComplete).toBe(false);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("lets a delta waiting on the same tick release the held stream first", () => {
    // The tick applies the delta, and every frame buffered ahead of it must
    // land before it does - held or not.
    const harness = createTickedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(openSnapshot());
      const [first] = skeletonInChunks();
      harness.callbacks().onSkeletonChunk(first);

      harness.tick();
      expect(
        harness.handle.store.getState().transcriptWindow.skeleton,
      ).toHaveLength(0);

      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: { type: "text.delta", blockId: "b-1", timestamp: 5, delta: "x" },
      });
      harness.tick();

      expect(
        harness.handle.store.getState().transcriptWindow
          .skeletonStreamCoveredThrough,
      ).toBe(4);
    } finally {
      harness.handle.dispose();
    }
  });
});
