import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatIndexChange,
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
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
  /** How many `resnapshot` requests the client has sent. */
  resnapshotCount(): number;
  callbacks(): ChatStreamCallbacks;
  /**
   * The id of the request a `range` frame would be answering right now.
   *
   * Throws when nothing is outstanding, and that is the point rather than
   * defensive noise: the host sends a `range` for exactly one reason - to
   * answer a `loadRange` - so a test injecting one without having asked is
   * modelling a frame the wire cannot produce. The store discards such a
   * response (see `rangeResponseIsStale`), so a harness that let it through
   * would be asserting against a code path no host can reach.
   */
  lastRangeRequestId(): string;
}

function createViewportHarness(): ViewportHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let resnapshots = 0;
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

/** A `range` frame answering a NAMED request, for tests about identity. */
function rangeAnswering(
  requestId: string,
  fromOrdinal: number,
  toOrdinal: number,
): Parameters<ChatStreamCallbacks["onRange"]>[0] {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId,
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

/** The ordinary case: the host answers whatever the client last asked for. */
function range(
  harness: ViewportHarness,
  fromOrdinal: number,
  toOrdinal: number,
): Parameters<ChatStreamCallbacks["onRange"]>[0] {
  return rangeAnswering(harness.lastRangeRequestId(), fromOrdinal, toOrdinal);
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
  harness: ViewportHarness,
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
      requestId: harness.lastRangeRequestId(),
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

/**
 * The skeleton entry the host publishes for `row-<ordinal>`.
 *
 * The row id is derived from the ordinal so a delta and a `range` response
 * built by these helpers agree on identity - which is what makes the
 * out-of-order tests below about STALENESS rather than about the row-id check
 * that already exists.
 */
function skeletonEntry(ordinal: number): RowSkeletonEntry {
  return {
    rowId: `row-${ordinal}`,
    createdAt: ordinal,
    role: "user",
    byteLength: 128,
  };
}

/** The same row, rewritten in place: same id, new size. */
function updatedEntry(ordinal: number): {
  readonly ordinal: number;
  readonly entry: RowSkeletonEntry;
} {
  return { ordinal, entry: { ...skeletonEntry(ordinal), byteLength: 4096 } };
}

function indexChanged(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly changes: readonly ChatIndexChange[];
}): Parameters<ChatStreamCallbacks["onIndexChanged"]>[0] {
  return {
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    epoch: input.epoch,
    rowCount: input.rowCount,
    changes: [...input.changes],
  };
}

function accumulatedChanges(
  filePath: string,
): Parameters<ChatStreamCallbacks["onAccumulatedChanges"]>[0] {
  return {
    kind: "accumulatedChanges",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    chunk: {
      epoch: 1,
      fromIndex: 0,
      summaries: [
        {
          filePath,
          operation: "edit",
          diffSource: "snapshot",
          reason: "snapshot",
          undoable: true,
          hasContents: true,
          digest: `d-${filePath}`,
          counts: { additions: 1, deletions: 0 },
        },
      ],
      isFinal: true,
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
      harness
        .callbacks()
        .onWindowedSnapshot(
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
      harness.callbacks().onRange(range(harness, 10, 15));

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
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      expect(harness.rangeRequests).toHaveLength(1);
      harness.callbacks().onRange(range(harness, 10, 20));

      // The whole visible span is now held, so seating it plans nothing
      // further and re-reporting it asks for nothing.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 12, toOrdinal: 18 });
      expect(harness.rangeRequests).toHaveLength(1);
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
        .onRange(
          rangeWithMessages(
            harness,
            5,
            ["row-5"],
            [hugeUserMessage("m-huge", 5)],
          ),
        );

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

      harness
        .callbacks()
        .onSnapshot(legacySnapshot([userMessage("legacy-1", 1)]));

      const afterLegacy = harness.handle.store.getState();
      expect(afterLegacy.transcriptDerived).toBeNull();
      expect(afterLegacy.transcriptWindow.rowCount).toBe(0);
      expect(afterLegacy.messages.map((message) => message.messageId)).toEqual([
        "legacy-1",
      ]);

      // A straggler windowed frame for the abandoned epoch must be ignored
      // outright - it must not touch `messages` or rebuild windowed state.
      // Named explicitly rather than through `range`: the point is that the
      // `!windowedLine` guard drops this before request identity is even
      // consulted, and the downgraded session has nothing outstanding to name.
      harness.callbacks().onRange(rangeAnswering("straggler", 10, 15));

      const finalState = harness.handle.store.getState();
      expect(finalState.messages.map((message) => message.messageId)).toEqual([
        "legacy-1",
      ]);
      expect(finalState.transcriptWindow.rowCount).toBe(0);
      expect(finalState.transcriptDerived).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("ignores a straggling accumulated-change chunk after the downgrade", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.callbacks().onAccumulatedChanges(accumulatedChanges("a.ts"));
      expect(
        harness.handle.store.getState().accumulatedFileChangeSummaries,
      ).toHaveLength(1);

      harness
        .callbacks()
        .onSnapshot(legacySnapshot([userMessage("legacy-1", 1)]));
      expect(
        harness.handle.store.getState().accumulatedFileChangeSummaries,
      ).toEqual([]);

      // The legacy line's authoritative set is `accumulatedFileChanges`, and
      // the downgrade cleared these once. Nothing clears them a second time,
      // so a chunk seated here would leave the panel serving rows from the
      // abandoned windowed epoch for the life of the session.
      harness.callbacks().onAccumulatedChanges(accumulatedChanges("b.ts"));

      expect(
        harness.handle.store.getState().accumulatedFileChangeSummaries,
      ).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("applies the byte budget when a snapshot seats a new tail", () => {
    // Codex P1 (#1459): `insertSpan` has exactly two callers - the snapshot
    // tail and a range response - and only the range path ran the budget. A
    // reader who hydrates scrollback and then stops scrolling still receives a
    // snapshot per completed turn, so the cache grew across snapshots with
    // nothing ever enforcing TRANSCRIPT_WINDOW_MAX_BYTES.
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      // The reader scrolls back and hydrates a span. It survives `onRange`'s
      // own eviction only because it is what the viewport is showing.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 5, toOrdinal: 6 });
      harness
        .callbacks()
        .onRange(
          rangeWithMessages(
            harness,
            5,
            ["row-5"],
            [hugeUserMessage("m-huge", 5)],
          ),
        );
      const seeded = harness.handle.store.getState().transcriptWindow;
      expect(seeded.spans.some((held) => held.fromOrdinal === 5)).toBe(true);
      expect(seeded.hydratedBytes).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX_BYTES);

      // The reader returns to the tail, so that span is now cold. Reporting a
      // viewport does not itself evict - only a seat does.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 20, toOrdinal: 21 });
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.some((held) => held.fromOrdinal === 5),
      ).toBe(true);

      // A later turn completes. No range is requested - only a snapshot
      // arrives - which is precisely the path that used to skip the budget.
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: 41,
          tailFromOrdinal: 21,
          tailMessages: [userMessage("tail-2", 21)],
        }),
      );

      const after = harness.handle.store.getState().transcriptWindow;
      expect(after.hydratedBytes).toBeLessThanOrEqual(
        TRANSCRIPT_WINDOW_MAX_BYTES,
      );
      // The cold oversized span is what went; the freshly seated tail stays.
      expect(after.spans.some((held) => held.fromOrdinal === 5)).toBe(false);
      expect(after.spans.length).toBeGreaterThan(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("the viewport report warms the visible span", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 15 });
      harness.callbacks().onRange(range(harness, 10, 15));
      // The reader leaves that scrollback for the tail, which is what makes
      // coming back to it the interesting event.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 20, toOrdinal: 21 });
      const before = harness.handle.store
        .getState()
        .transcriptWindow.spans.find(
          (span) => span.fromOrdinal === 10,
        )?.touchedAt;
      expect(before).toBeDefined();

      // Already hydrated, so reporting it visible plans no new fetch...
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 15 });
      expect(harness.rangeRequests).toHaveLength(1);

      // ...but it does warm the span's LRU clock, which is what keeps it from
      // reading as coldest the next time eviction runs.
      const after = harness.handle.store
        .getState()
        .transcriptWindow.spans.find(
          (span) => span.fromOrdinal === 10,
        )?.touchedAt;
      expect(after ?? -1).toBeGreaterThan(before ?? -1);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * A `range` answer is the one frame on this line that can be reordered behind
 * the deltas that invalidate it: an oversized response goes to the relay's
 * BULK lane while `indexChanged` stays INTERACTIVE. These pin what the client
 * does when that happens.
 */
describe("chat session viewport hydration: a range answered out of order", () => {
  it("discards an answer an `updated` staled while it was in flight", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      expect(harness.rangeRequests).toHaveLength(1);

      // The interactive delta overtakes the bulk answer. Its row id is
      // UNCHANGED, which is not incidental - `diffRowSkeleton` emits a
      // `reindexed` for a row id that moved, so an `updated` always keeps both
      // the epoch and the id. Neither of `applyRangeResponse`'s checks can see
      // this; only the in-flight bookkeeping can.
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 1,
          rowCount: 40,
          changes: [{ type: "updated", entries: [updatedEntry(12)] }],
        }),
      );
      harness.callbacks().onRange(range(harness, 10, 20));

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(false);
      // ...and the ordinals are asked for again rather than left as a hole.
      expect(harness.rangeRequests).toHaveLength(2);
      expect(harness.rangeRequests[1]).toMatchObject({
        fromOrdinal: 10,
        toOrdinal: 20,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps an answer when the `updated` fell outside what it served", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });

      // Ordinal 5 is neither held nor requested, so this answer is still
      // current. Discarding on ANY update would make an active turn - which
      // updates its streaming row constantly - starve every scrollback fetch.
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 1,
          rowCount: 40,
          changes: [{ type: "updated", entries: [updatedEntry(5)] }],
        }),
      );
      harness.callbacks().onRange(range(harness, 10, 20));

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("discards an answer to a request it has already replaced", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      const firstRequestId = harness.lastRangeRequestId();
      // The reader scrolls to the top before the first answer lands, so the
      // slot now tracks a different ask.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 0, toOrdinal: 5 });
      expect(harness.rangeRequests).toHaveLength(2);

      harness.callbacks().onRange(rangeAnswering(firstRequestId, 10, 20));

      // Dropped, though its bodies may well be current: the client stopped
      // tracking what happened to ordinals 10-19 the moment it replaced the
      // request, so "still valid" is no longer a claim it can make. A
      // re-request is the cheap side of that trade.
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(false);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("chat session viewport hydration: resnapshot after invalidation", () => {
  it("asks once per abandoned epoch however many frames follow", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      // A `reindexed` voids the index and advances the epoch with it.
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 2,
          rowCount: 40,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(harness.resnapshotCount()).toBe(1);

      // Invalidation is sticky until a snapshot clears it, and every windowed
      // callback ends in the same planner - so without a latch each of these
      // sends another full-snapshot request.
      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 2,
          fromOrdinal: 0,
          entries: [skeletonEntry(0)],
          isFinal: false,
        },
      });
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 2,
          rowCount: 41,
          changes: [{ type: "appended", entries: [skeletonEntry(40)] }],
        }),
      );

      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("re-arms once a snapshot answers", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 2,
          rowCount: 40,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(harness.resnapshotCount()).toBe(1);

      hydrateTail(harness);
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 3,
          rowCount: 40,
          changes: [{ type: "reindexed" }],
        }),
      );

      // A latch that outlived the snapshot would strand the session on a void
      // index with no way left to ask for a good one.
      expect(harness.resnapshotCount()).toBe(2);
    } finally {
      harness.handle.dispose();
    }
  });
});
