import { describe, expect, it, vi } from "vitest";
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
  HYDRATION_REQUEST_TIMEOUT_MS,
  MAX_OUTSTANDING_HYDRATION_REQUESTS,
  MAX_WATCHDOG_RESTREAMS_PER_EPOCH,
  STREAM_COMPLETION_TIMEOUT_MS,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  spanTouchStamp,
  TRANSCRIPT_WINDOW_MAX_BYTES,
} from "@/stores/chats/transcript-window";

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
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
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
      indexRevision: null,
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
      rowContext: {},
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
      browserAnnotations: [],
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
      rowContext: {},
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
    bodyDigest: `d${ordinal}`,
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
  readonly indexRevision: number;
  readonly changes: readonly ChatIndexChange[];
}): Parameters<ChatStreamCallbacks["onIndexChanged"]>[0] {
  return {
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    epoch: input.epoch,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
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
      generation: 1,
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

/** A skeleton chunk covering `[fromOrdinal, toOrdinal)`. */
function skeletonChunk(
  fromOrdinal: number,
  toOrdinal: number,
  isFinal: boolean,
): Parameters<ChatStreamCallbacks["onSkeletonChunk"]>[0] {
  return {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    chunk: {
      epoch: 1,
      fromOrdinal,
      entries: Array.from({ length: toOrdinal - fromOrdinal }, (_u, index) =>
        skeletonEntry(fromOrdinal + index),
      ),
      isFinal,
    },
  };
}

/**
 * An aux-only rebroadcast: same epoch, same rows, a HELD index revision.
 *
 * This is what a queue change or an approval produces - the host re-sends the
 * snapshot against an unchanged skeleton and streams nothing. `indexRevision`
 * is the discriminator (`null` would be the host announcing a rebuild), and it
 * matches what the client already holds, because a revision that ran AHEAD is a
 * different frame entirely: it means deltas were lost and the window voids.
 */
function auxRebroadcast(input: {
  readonly rowCount: number;
  readonly tailFromOrdinal: number;
  readonly tailMessages: readonly Message[];
}): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  const bootstrap = snapshot(input);
  return {
    ...bootstrap,
    snapshot: { ...bootstrap.snapshot, indexRevision: 0 },
  };
}

/**
 * A skeleton whose ordinals 10-12 are ONE steered turn: two assistant slices
 * with the steer bubble between them. Every other ordinal stays an ordinary
 * user row, so the turn has a real boundary on both sides.
 */
const TURN_ROW_IDS: ReadonlyMap<number, string> = new Map([
  [10, "assistant:t-9:part:0"],
  [11, "steer:q-9"],
  [12, "assistant:t-9:part:1"],
]);

function turnSkeletonChunk(): Parameters<
  ChatStreamCallbacks["onSkeletonChunk"]
>[0] {
  const chunk = skeletonChunk(0, 40, true);
  return {
    ...chunk,
    chunk: {
      ...chunk.chunk,
      entries: chunk.chunk.entries.map((entry, ordinal) => {
        const rowId = TURN_ROW_IDS.get(ordinal);
        return rowId === undefined ? entry : { ...entry, rowId };
      }),
    },
  };
}

/** A `range` answering a NAMED request with the row ids the skeleton names. */
function turnRangeAnswering(
  requestId: string,
  fromOrdinal: number,
  toOrdinal: number,
  messages: readonly Message[],
): Parameters<ChatStreamCallbacks["onRange"]>[0] {
  const answer = rangeAnswering(requestId, fromOrdinal, toOrdinal);
  return {
    ...answer,
    range: {
      ...answer.range,
      rowIds: answer.range.rowIds.map(
        (rowId, index) => TURN_ROW_IDS.get(fromOrdinal + index) ?? rowId,
      ),
      messages: [...messages],
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
        toOrdinal: 39,
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
        toOrdinal: 19,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  /**
   * Two `toOrdinal`s with two meanings, and the store is where they meet.
   *
   * `OrdinalRange.toOrdinal` (the viewport report, the planner, the gaps) is
   * EXCLUSIVE. `ChatLoadRangeRequest.toOrdinal` (the wire, and the
   * `sliceTranscriptRange` that serves it) is INCLUSIVE at both ends. Passing
   * the planner's value straight through asks for one row more than the plan
   * on every single request - which at a gap boundary is the first row of the
   * span already held, so it also drags a body the client did not need across
   * the wire.
   *
   * Asserted as an exact width rather than as `toOrdinal: 19`, because that is
   * the property that matters and it survives the numbers changing.
   */
  it("converts the planner's exclusive bound to the wire's inclusive one", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });

      expect(harness.rangeRequests).toHaveLength(1);
      const request = harness.rangeRequests[0];
      // Ten rows visible, so ten rows requested - inclusive of both bounds.
      expect(request.toOrdinal - request.fromOrdinal + 1).toBe(10);
      expect(request.fromOrdinal).toBe(10);
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
        toOrdinal: 19,
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
        toOrdinal: 5,
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

  it("seats an answer that arrived after its request timed out", () => {
    // The failure this pins is a LOOP, not a dropped frame, so the assertion
    // has to bound the retries rather than check one response.
    //
    // A range response is deliberately unbounded for a single folded row (see
    // `read-range.ts`) and rides the relay's BULK lane, so taking longer than
    // the client's deadline is an ordinary slow answer. When the timeout
    // released the slot AND forgot the request, that answer was rejected on
    // arrival for having an untracked id - and its replacement re-armed the
    // same deadline, so a link that is merely slow discarded every answer it
    // ever produced and minted one more request per discard. The gap never
    // hydrated and nothing in the store noticed.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      const slowRequestId = harness.lastRangeRequestId();

      // Long enough for the deadline to fire and the plan to be re-issued.
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(2);
      expect(harness.rangeRequests[1]?.requestId).not.toBe(slowRequestId);

      // The FIRST request is answered - late, but describing exactly the rows
      // that were asked for, in an epoch nothing has invalidated.
      harness.callbacks().onRange(rangeAnswering(slowRequestId, 10, 20));

      // Seated: a report fully inside the now-hydrated span asks for nothing.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 12, toOrdinal: 18 });
      expect(harness.rangeRequests).toHaveLength(2);

      // And the loop is closed at the other end too: letting the second
      // request's own deadline elapse re-asks nothing, because the rows it
      // covered are no longer a gap.
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(2);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("discards a late answer whose rows a reindex invalidated", () => {
    // The other side of the same change. Keeping a timed-out request eligible
    // must not make it eligible unconditionally: supersession is tracked per
    // REQUEST, so a frame that invalidates the rows in the air still has to
    // reject the answer when it lands - otherwise the fix for the loop would
    // seat a body frozen at a previous revision, which is the hazard the
    // request ledger exists to prevent in the first place.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      const slowRequestId = harness.lastRangeRequestId();

      // Past the timeout, so the slow request is no longer the one holding the
      // dedup slot - which is the state this case is about.
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);

      // A reindex lands while BOTH requests are outstanding. It supersedes the
      // timed-out one as much as the current one.
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );

      harness.callbacks().onRange(rangeAnswering(slowRequestId, 10, 20));

      // Asserted on the WINDOW, because the two request-count assertions that
      // used to stand here could not fail. `rangeRequests.length` is compared
      // against a number read from that same growing array, and the follow-up
      // was satisfied by the `reindexed` frame's own resnapshot whether or not
      // the late answer was seated.
      //
      // What actually has to hold is that nothing was seated: the superseded
      // body must not be holding these rows, so the span is still a gap.
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(false);
      // Recovery is the resnapshot the reindex already asked for, and it is
      // asserted rather than assumed. Note what must NOT be asserted here: a
      // further `reportVisibleTranscriptRange` mints nothing, because the
      // resnapshot latch suppresses a duplicate while one is outstanding. A
      // "it asks again" assertion would therefore have to be written loosely
      // enough to pass on traffic the reindex itself produced - which is how
      // the two assertions this replaced came to be unfalsifiable.
      expect(harness.handle.store.getState().transcriptWindow.invalidated).toBe(
        true,
      );
      expect(harness.resnapshotCount()).toBeGreaterThan(0);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("restreams when a skeleton stops before its final chunk", () => {
    // The class: a chunked delivery closes its loop only when the final chunk
    // ARRIVES. `applySkeletonChunk` reads completeness off `chunk.isFinal`, so
    // losing exactly the last frame leaves `skeletonComplete` false forever -
    // and the module's own comment says what that is worth: "`skeletonComplete`
    // merely goes false, which requests no repair."
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      const before = harness.resnapshotCount();

      // Two chunks arrive; the third, carrying `isFinal`, never does.
      harness.callbacks().onSkeletonChunk(skeletonChunk(0, 10, false));
      harness.callbacks().onSkeletonChunk(skeletonChunk(10, 20, false));

      // Still within the idle window: a stream that is merely slow must not be
      // torn down and re-sent, which is the whole reason this is an IDLE
      // timeout re-armed per chunk rather than one deadline for the stream.
      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS - 1);
      expect(harness.resnapshotCount()).toBe(before);

      vi.advanceTimersByTime(2);
      expect(harness.resnapshotCount()).toBe(before + 1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("stops restreaming a skeleton that keeps stalling", () => {
    // The bound. A resnapshot restarts the very stream whose stall triggered
    // it, so without a cap a link that keeps dropping the last frame gets an
    // unbounded restream loop - the same shape as the range-request loop this
    // store shipped once, and the reason that fix needed a bounding test too.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      const before = harness.resnapshotCount();

      // Each round: a chunk arrives, the stream stalls, the watchdog fires.
      for (
        let round = 0;
        round < MAX_WATCHDOG_RESTREAMS_PER_EPOCH + 3;
        round += 1
      ) {
        harness.callbacks().onSkeletonChunk(skeletonChunk(0, 10, false));
        vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS + 1);
      }

      expect(harness.resnapshotCount() - before).toBe(
        MAX_WATCHDOG_RESTREAMS_PER_EPOCH,
      );
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("does not restream a skeleton that completed", () => {
    // The negative that keeps the watchdog from firing on every healthy chat.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      const before = harness.resnapshotCount();

      harness.callbacks().onSkeletonChunk(skeletonChunk(0, 20, false));
      harness.callbacks().onSkeletonChunk(skeletonChunk(20, 40, true));

      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS * 3);
      expect(harness.resnapshotCount()).toBe(before);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("restreams when the SOLE skeleton chunk is the one that is lost", () => {
    // The hole an earlier receipt gate left, and the reason the watchdog now
    // reads the snapshot's totals instead. That gate only monitored a stream
    // which had delivered something, so it saw a stream that stopped part way
    // and was blind to one that never started - losing the whole skeleton was
    // invisible while losing its last frame was caught.
    //
    // "No chunk" is unambiguous evidence of loss rather than of a chat with
    // nothing to send: `chunkRowSkeleton` yields one empty final chunk for an
    // EMPTY skeleton precisely so the two are distinguishable, and the host
    // streams it behind every bootstrap snapshot.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      const before = harness.resnapshotCount();

      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS - 1);
      expect(harness.resnapshotCount()).toBe(before);

      vi.advanceTimersByTime(2);
      expect(harness.resnapshotCount()).toBe(before + 1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("restreams when the summary stream's first chunk never arrives", () => {
    // The same hole on the other stream, and it did not need the summaries to
    // be unlucky on their own: under a receipt gate the summaries were watched
    // only once a summary chunk had landed, so a skeleton that completed
    // perfectly left a summary stream that lost its opening chunk unmonitored.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      const base = snapshot({
        rowCount: 40,
        tailFromOrdinal: 20,
        tailMessages: [userMessage("tail", 20)],
      });
      harness.callbacks().onWindowedSnapshot({
        ...base,
        snapshot: { ...base.snapshot, accumulatedFileChangeCount: 3 },
      });
      // The skeleton is healthy and complete, so it can indict nothing. The
      // only thing outstanding is the file list the snapshot promised.
      harness.callbacks().onSkeletonChunk(skeletonChunk(0, 40, true));
      const before = harness.resnapshotCount();

      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS + 1);

      expect(harness.resnapshotCount()).toBe(before + 1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("retries a summary resnapshot that was dropped, and still stops at the cap", () => {
    // The recovery had a hole exactly where it was needed: when the resnapshot
    // ITSELF is dropped. Its timeout releases the dedup latch and calls
    // `requestPlannedHydration`, which retries only what it can see in the
    // transcript - an invalidated window, or a visible gap. A summary-only
    // stall is neither: that transcript is valid and fully hydrated here, so
    // the planner asks for nothing.
    //
    // Meanwhile the watchdog timer that started the recovery has fired and
    // cleared itself, and it is re-armed only by delivery progress or a
    // snapshot - neither of which is coming, since a dropped resnapshot is the
    // premise. So the retry budget read as unspent while nothing would ever
    // spend it, and the file list stayed short for the life of the connection.
    //
    // Both halves are pinned here deliberately: a retry loop whose bound is
    // untested is the failure mode this store has shipped before.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      const base = snapshot({
        rowCount: 40,
        tailFromOrdinal: 20,
        tailMessages: [userMessage("tail", 20)],
      });
      harness.callbacks().onWindowedSnapshot({
        ...base,
        snapshot: { ...base.snapshot, accumulatedFileChangeCount: 3 },
      });
      harness.callbacks().onSkeletonChunk(skeletonChunk(0, 40, true));
      const before = harness.resnapshotCount();

      // The stall is noticed and the first resnapshot goes out.
      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS + 1);
      expect(harness.resnapshotCount()).toBe(before + 1);

      // Nothing answers it. Each round is the request's own deadline expiring,
      // then the re-armed watchdog reaching its own - and the loop must run
      // past the cap to prove the cap is what stops it, not the arithmetic.
      for (
        let round = 0;
        round < MAX_WATCHDOG_RESTREAMS_PER_EPOCH + 3;
        round += 1
      ) {
        vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
        vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS + 1);
      }

      expect(harness.resnapshotCount() - before).toBe(
        MAX_WATCHDOG_RESTREAMS_PER_EPOCH,
      );
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("stops retrying once the resnapshot is answered", () => {
    // The other direction, so the re-arm cannot become a timer that outlives
    // its reason: a snapshot that completes the delivery disarms the watchdog
    // through the same `readCompleteness` check every other arm site uses.
    vi.useFakeTimers();
    const harness = createViewportHarness();
    try {
      const base = snapshot({
        rowCount: 40,
        tailFromOrdinal: 20,
        tailMessages: [userMessage("tail", 20)],
      });
      harness.callbacks().onWindowedSnapshot({
        ...base,
        snapshot: { ...base.snapshot, accumulatedFileChangeCount: 0 },
      });
      harness.callbacks().onSkeletonChunk(skeletonChunk(0, 40, true));
      const before = harness.resnapshotCount();

      vi.advanceTimersByTime(
        (STREAM_COMPLETION_TIMEOUT_MS + HYDRATION_REQUEST_TIMEOUT_MS + 2) * 4,
      );

      expect(harness.resnapshotCount()).toBe(before);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
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
      // The snapshot must PROMISE the summary the chunk delivers - but not
      // because the count gates publication. A final chunk publishes at any
      // count. What a count of 0 would change is the WATCHDOG:
      // `chunkedDeliveryIncomplete` measures the published length against
      // `accumulatedFileChangeCount`, so 0-against-1 keeps it armed and its
      // fire adds a `resnapshot` this test's own count would then include.
      const base = snapshot({
        rowCount: 40,
        tailFromOrdinal: 20,
        tailMessages: [userMessage("tail", 20)],
      });
      harness.callbacks().onWindowedSnapshot({
        ...base,
        snapshot: { ...base.snapshot, accumulatedFileChangeCount: 1 },
      });
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
      // A plain user row's id IS its message's id in production
      // (`row-projection.ts`), which is what lets the warmth bump below find a
      // record to touch - `range()`'s shared `rangeAnswering` fixture names
      // only one message ("m-<fromOrdinal>") for a five-row response, so it is
      // not representative here and this test builds its own instead.
      harness
        .callbacks()
        .onRange(
          rangeWithMessages(
            harness,
            10,
            ["row-10", "row-11", "row-12", "row-13", "row-14"],
            [userMessage("row-10", 10)],
          ),
        );
      // The reader leaves that scrollback for the tail, which is what makes
      // coming back to it the interesting event.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 20, toOrdinal: 21 });
      const beforeWindow = harness.handle.store.getState().transcriptWindow;
      const beforeSpan = beforeWindow.spans.find(
        (span) => span.fromOrdinal === 10,
      );
      const before =
        beforeSpan !== undefined
          ? spanTouchStamp(beforeWindow, beforeSpan)
          : undefined;
      expect(before).toBeDefined();

      // Already hydrated, so reporting it visible plans no new fetch...
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 15 });
      expect(harness.rangeRequests).toHaveLength(1);

      // ...but it does warm the span's LRU clock, which is what keeps it from
      // reading as coldest the next time eviction runs.
      const afterWindow = harness.handle.store.getState().transcriptWindow;
      const afterSpan = afterWindow.spans.find(
        (span) => span.fromOrdinal === 10,
      );
      const after =
        afterSpan !== undefined
          ? spanTouchStamp(afterWindow, afterSpan)
          : undefined;
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
          indexRevision: 1,
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
        toOrdinal: 19,
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
          indexRevision: 1,
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

  it("seats an answer to a request it has already replaced", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      const firstRequestId = harness.lastRangeRequestId();
      // The reader scrolls to the top before the first answer lands, so the
      // dedup slot now tracks a different ask.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 0, toOrdinal: 5 });
      expect(harness.rangeRequests).toHaveLength(2);

      harness.callbacks().onRange(rangeAnswering(firstRequestId, 10, 20));

      // Seated. This assertion used to read `false`, on the rationale that the
      // client "stopped tracking what happened to ordinals 10-19 the moment it
      // replaced the request" - and that was true while one slot held both the
      // dedup key and the staleness record.
      //
      // It is not true now: supersession is recorded per REQUEST, and
      // `supersedeInFlightHydration` marks every outstanding one, so the
      // client can still say whether these rows went stale. Nothing did, so
      // the bodies are current and already paid for on the wire - dropping
      // them would buy a round trip and nothing else. `discards a late answer
      // whose rows a reindex invalidated` is the case where the record earns
      // its keep and the answer IS dropped.
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("discards an answer carrying the records of a SIBLING row the frame rewrote", () => {
    // The ordinals a request asked for are not the rows its answer can be stale
    // in. A range serves a row from its TURN's shared records, so an answer for
    // slice 0 carries the same message record slice 1 renders from - and an
    // `updated` naming only slice 1 leaves an ordinal-keyed intersection empty.
    //
    // Seating it covers slice 0 with pre-update records while slice 1, which
    // need never be visible, is the only row anything would re-ask for.
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.callbacks().onSkeletonChunk(turnSkeletonChunk());
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const sliceRequestId = harness.lastRangeRequestId();

      // Rewrites the SIBLING slice, outside [10, 11).
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 12,
                  entry: {
                    ...skeletonEntry(12),
                    rowId: "assistant:t-9:part:1",
                    byteLength: 4096,
                  },
                },
              ],
            },
          ],
        }),
      );

      harness
        .callbacks()
        .onRange(
          turnRangeAnswering(sliceRequestId, 10, 11, [
            userMessage("shared-turn-record", 10),
          ]),
        );

      // Asserted on the WINDOW, not on a request count: the failure this pins
      // is a body that seats and then renders forever, and a count says
      // nothing about which bodies are held.
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(false);
    } finally {
      harness.handle.dispose();
    }
  });

  it("still seats an answer when the rewritten row shares no turn with it", () => {
    // The bound. Widening to the turn must not become "discard whatever is in
    // flight": a rewritten user row elsewhere in the transcript shares no
    // records with this answer, and dropping it would cost a round trip per
    // unrelated edit.
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.callbacks().onSkeletonChunk(turnSkeletonChunk());
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const sliceRequestId = harness.lastRangeRequestId();

      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [{ type: "updated", entries: [updatedEntry(30)] }],
        }),
      );

      harness
        .callbacks()
        .onRange(
          turnRangeAnswering(sliceRequestId, 10, 11, [
            userMessage("shared-turn-record", 10),
          ]),
        );

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps tracking the replacement, so a discarded answer mints no new request", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      const firstRequestId = harness.lastRangeRequestId();
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 0, toOrdinal: 5 });
      const secondRequestId = harness.lastRangeRequestId();
      expect(harness.rangeRequests).toHaveLength(2);

      harness.callbacks().onRange(rangeAnswering(firstRequestId, 10, 20));

      // The replacement is still on the wire. Forgetting it here re-issues the
      // same ask under a new id, whose answer then finds the slot mismatched
      // again - one new request per answer, forever, with the gap never
      // hydrating. The re-plan must dedupe against the request still tracked.
      expect(harness.rangeRequests).toHaveLength(2);

      // And the replacement still answers normally afterwards.
      harness.callbacks().onRange(rangeAnswering(secondRequestId, 0, 5));
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 0)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * The other half of the same rule the ledger already follows.
 *
 * An aux-only rebroadcast is not a connection reset, so it must leave BOTH
 * records of an outstanding request alone. Keeping the ledger while releasing
 * the dedup slot is the shape that reads as conservative and destroys the
 * answer: the released slot permits a re-plan of a range that is still being
 * answered, and the requests that re-plan mints push the original's ledger
 * entry out of a capped map.
 */
describe("chat session viewport hydration: aux rebroadcasts while a range is in flight", () => {
  const AUX_FRAMES = MAX_OUTSTANDING_HYDRATION_REQUESTS + 1;

  it("mints no duplicate request, and the original answer still seats", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      expect(harness.rangeRequests).toHaveLength(1);
      const inFlightRequestId = harness.lastRangeRequestId();

      // A steady drip of queue changes and approvals while the answer is still
      // travelling - on the BULK lane, which is where a megabyte of bodies goes
      // and where it can be overtaken by every one of these.
      for (let frame = 0; frame < AUX_FRAMES; frame += 1) {
        harness.callbacks().onWindowedSnapshot(
          auxRebroadcast({
            rowCount: 40,
            tailFromOrdinal: 20,
            tailMessages: [userMessage("tail", 20)],
          }),
        );
      }

      // The gap is still a gap, so the planner still wants it; the slot is what
      // says it has already been asked for.
      expect(harness.rangeRequests).toHaveLength(1);

      harness.callbacks().onRange(rangeAnswering(inFlightRequestId, 10, 20));

      // Its ledger entry survived the aux traffic, so the answer is seated
      // rather than discarded as untracked.
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("still releases the slot when the rebuild signal says the request died", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      expect(harness.rangeRequests).toHaveLength(1);

      // A reconnect: a fresh subscriber holds no index, which reaches the
      // client as `indexRevision: null`. The request really did die with the
      // previous connection, and the epoch survives one - so a slot kept here
      // would suppress the identical re-plan forever and strand the gap.
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: 40,
          tailFromOrdinal: 20,
          tailMessages: [userMessage("tail", 20)],
        }),
      );

      expect(harness.rangeRequests).toHaveLength(2);
      expect(harness.rangeRequests[1]).toMatchObject({
        fromOrdinal: 10,
        toOrdinal: 19,
      });
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * The recovery ledger's rebuild boundary: an accepted rebuild announcement
 * subsumes every open range entry at once, and the answer to a
 * pre-boundary request must never seat - it is indistinguishable from a
 * post-boundary slice of current state, because the host slices at answer
 * time. Rejecting it by REQUEST ID (never by content) is the only thing that
 * can tell the two apart, and the planner that re-derives the same gap under
 * a fresh id is what proves the obligation was carried rather than dropped.
 */
describe("chat session viewport hydration: the rebuild boundary subsumes in-flight ranges", () => {
  it("discards the pre-boundary answer for the old request id, but seats the replanned one", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 20 });
      expect(harness.rangeRequests).toHaveLength(1);
      const oldRequestId = harness.lastRangeRequestId();

      // An accepted rebuild announcement at the SAME epoch - `snapshot()`
      // always frames `indexRevision: null`, the boundary's discriminator,
      // not a new epoch. It subsumes every open range entry, and the planner
      // (never gated on the boundary) immediately re-derives the same gap
      // under a fresh id.
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: 40,
          tailFromOrdinal: 20,
          tailMessages: [userMessage("tail", 20)],
        }),
      );
      expect(harness.rangeRequests).toHaveLength(2);
      const newRequestId = harness.lastRangeRequestId();
      expect(newRequestId).not.toBe(oldRequestId);

      // The OLD request's answer lands. A pre-boundary-framed answer is
      // indistinguishable from a post-boundary slice of current state by
      // CONTENT alone, so only the id absent from the ledger says so - it
      // must not seat, whatever rows it claims to carry.
      harness.callbacks().onRange(rangeAnswering(oldRequestId, 10, 20));
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.some((span) => span.fromOrdinal === 10),
      ).toBe(false);
      // Discarding it does not mint a THIRD request: the replanned one is
      // still tracked as in flight, so the re-plan the discard triggers
      // dedupes against it.
      expect(harness.rangeRequests).toHaveLength(2);

      // The NEW (post-boundary) request's own answer seats normally.
      harness.callbacks().onRange(range(harness, 10, 20));
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.some((span) => span.fromOrdinal === 10),
      ).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps planning gaps in the delivered prefix while the rebuild's skeleton is still incomplete", () => {
    // The boundary opens a `skeleton-completion` entry to carry the subsumed
    // obligations to a guaranteed close, but the planner must NOT be gated on
    // that entry - gating it would strand the delivered prefix behind a close
    // that never comes if the stream stalls into abandonment.
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      // The rebuild announcement. Nothing is visible yet and the tail is
      // already hydrated, so it plans nothing on its own.
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: 40,
          tailFromOrdinal: 20,
          tailMessages: [userMessage("tail", 20)],
        }),
      );
      expect(harness.rangeRequests).toEqual([]);

      // A partial, non-final skeleton chunk: the rebuild has not finished.
      harness.callbacks().onSkeletonChunk(skeletonChunk(0, 10, false));
      expect(
        harness.handle.store.getState().transcriptWindow.skeletonComplete,
      ).toBe(false);

      // A gap INSIDE the delivered prefix [0, 10) is still asked for.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 2, toOrdinal: 5 });
      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]).toMatchObject({
        fromOrdinal: 2,
        toOrdinal: 4,
      });

      // ...and its answer SEATS while `skeletonComplete` is still false - the
      // stalled rebuild's own close condition never gated this plan.
      harness.callbacks().onRange(range(harness, 2, 5));
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.some((span) => span.fromOrdinal === 2),
      ).toBe(true);
      expect(
        harness.handle.store.getState().transcriptWindow.skeletonComplete,
      ).toBe(false);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * The ledger's outstanding-request cap: binding it is a SUPERSEDE-AND-REPLAN,
 * never silent trust. The evicted oldest entries are replaced by one NEW
 * wider request covering their rows; a response to an evicted id is discarded
 * exactly as any unrecorded response is, and only the wider request's own
 * accepted answer closes its entry.
 */
describe("chat session viewport hydration: the outstanding-request cap supersedes and replans", () => {
  it("replaces evicted entries with one wider request, discards their late answers, and seats the wider one", () => {
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);

      // Mint MAX_OUTSTANDING_HYDRATION_REQUESTS + 1 distinct one-row range
      // requests, one per report - each targets an ordinal nothing has
      // fetched yet, so every call plans a fresh id. The ledger keeps every
      // entry even though only the latest holds the in-flight dedup slot (see
      // `requestPlannedHydration`'s own doc: "a differently-planned request
      // does not make the earlier answer wrong, only unawaited"), so the
      // LAST report is what binds the cap.
      for (
        let ordinal = 0;
        ordinal <= MAX_OUTSTANDING_HYDRATION_REQUESTS;
        ordinal += 1
      ) {
        harness.handle.store.getState().reportVisibleTranscriptRange({
          fromOrdinal: ordinal,
          toOrdinal: ordinal + 1,
        });
      }

      // One ordinary request per report, plus the ONE wider replacement
      // request the cap-binding report also sent.
      const ordinaryCount = MAX_OUTSTANDING_HYDRATION_REQUESTS + 1;
      expect(harness.rangeRequests).toHaveLength(ordinaryCount + 1);

      // The two OLDEST entries (ordinals 0 and 1) are what the cap evicted.
      const evictedRequestId = harness.rangeRequests[0].requestId;
      const secondEvictedRequestId = harness.rangeRequests[1].requestId;
      const replacement = harness.rangeRequests[ordinaryCount];
      // Covers exactly the evicted entries' rows: ordinals [0, 2).
      expect(replacement).toMatchObject({ fromOrdinal: 0, toOrdinal: 1 });
      expect(replacement.requestId).not.toBe(evictedRequestId);
      expect(replacement.requestId).not.toBe(secondEvictedRequestId);

      // A response to an evicted id is discarded outright - its ledger entry
      // is gone, so nothing recorded what happened to those ordinals while it
      // was in the air.
      harness.callbacks().onRange(rangeAnswering(evictedRequestId, 0, 1));
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.some((span) => span.fromOrdinal === 0),
      ).toBe(false);
      // No new request was minted for it: the wider replacement already
      // carries the obligation, and the re-plan the discard triggers dedupes
      // against whatever currently holds the in-flight slot.
      expect(harness.rangeRequests).toHaveLength(ordinaryCount + 1);

      // The wider replacement's own answer seats normally.
      harness.callbacks().onRange(rangeAnswering(replacement.requestId, 0, 2));
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.some((span) => span.fromOrdinal === 0),
      ).toBe(true);
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
          indexRevision: 1,
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
          indexRevision: 2,
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
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(harness.resnapshotCount()).toBe(1);

      hydrateTail(harness);
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 3,
          rowCount: 40,
          indexRevision: 1,
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

  it("a refused same-epoch straggler snapshot does not fire the authority boundary", () => {
    // The boundary (`clearInFlightHydration` + `recovery.authorityBoundary` +
    // `imageWitnesses.invalidateAll()`) used to be gated only on the FRAME's
    // own claim (`indexRevision === null || rebased || window.invalidated`),
    // never on whether the fold actually ACCEPTED the frame. A same-epoch
    // straggler - a concrete `indexRevision` BEHIND what this client already
    // holds - is refused by `applyWindowedSnapshot` outright
    // (`classifySnapshotRevision` returns "straggler", and the fold returns
    // its input window BY IDENTITY). But with that window still `invalidated`
    // from the void below, the old ungated check read `window.invalidated` as
    // true and fired the boundary anyway - closing the open resnapshot dedup
    // entry for a frame that moved nothing. The very next planned-hydration
    // pass (this handler's own trailing `requestPlannedHydration()`, or any
    // later replan) then found the entry gone and sent a redundant
    // `requestResnapshot` - one per straggler.
    const harness = createViewportHarness();
    try {
      hydrateTail(harness);
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 2,
          rowCount: 40,
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(harness.resnapshotCount()).toBe(1);

      // A void arms `indexRevisionRebuilding` for one frame's exemption from
      // the revision-direction rules (the counter behind the NEXT frame may
      // not be the counter this window holds). An ordinary follow-up delta
      // spends that exemption and advances the held revision to 2, without
      // touching `invalidated` - exactly "asks once per abandoned epoch"
      // above's second frame - so the straggler below is judged against a
      // revision the direction rules actually compare.
      harness.callbacks().onIndexChanged(
        indexChanged({
          epoch: 2,
          rowCount: 41,
          indexRevision: 2,
          changes: [{ type: "appended", entries: [skeletonEntry(40)] }],
        }),
      );
      expect(harness.resnapshotCount()).toBe(1);

      // Same epoch (2), with a concrete `indexRevision` (1) BEHIND the 2 this
      // client now holds - a straggler, refused whole.
      const bootstrap = snapshot({
        rowCount: 41,
        tailFromOrdinal: 20,
        tailMessages: [userMessage("tail-late", 20)],
      });
      harness.callbacks().onWindowedSnapshot({
        ...bootstrap,
        snapshot: {
          ...bootstrap.snapshot,
          transcriptEpoch: 2,
          indexRevision: 1,
        },
      });
      // The refused frame's own trailing replan must not have fired the
      // boundary and re-sent.
      expect(harness.resnapshotCount()).toBe(1);

      // A later, independent replan must still find the SAME open entry - not
      // a fresh one a wrongly-fired boundary would have permitted.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 5, toOrdinal: 10 });
      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  // The control half - an ACCEPTED rebuild announcement (same epoch,
  // `indexRevision: null`) DOES close the entry, so a later void sends a
  // fresh `requestResnapshot` - is already pinned above by "re-arms once a
  // snapshot answers".
});
