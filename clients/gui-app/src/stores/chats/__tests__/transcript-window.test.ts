import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatRangeResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  assistantRowId,
  queueSteerRowId,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { transientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import {
  appendLiveRecords,
  MAX_LIVE_EVENTS,
  SPAN_MERGE_MAX_BYTES,
  applyIndexChange,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  evictTranscriptWindowToBudget,
  holdsEveryRecordFrom,
  hydratedRecords,
  mapWindowMessages,
  planTranscriptHydration,
  settleWindowBytes,
  streamWindowMessage,
  touchTranscriptRange,
  transcriptHydrationGaps,
  unhydratedRowCount,
  updateWindowMessage,
  TRANSCRIPT_WINDOW_MAX_BYTES,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * The client half of the windowed transcript.
 *
 * The cases worth writing here are the ones where the window must throw
 * something away, because that is where a bug is silent: a stale body that is
 * kept renders as current, and a coordinate that is trusted after it stopped
 * being valid seats bodies under the wrong rows. Both look like a chat whose
 * messages are subtly shuffled rather than like an error.
 */

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function assistantMessage(
  messageId: string,
  turnId: string | null,
  timestamp: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function event(eventId: string, timestamp: number): ChatEvent {
  return {
    eventId,
    type: "turn.completed",
    timestamp,
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
  };
}

function skeletonEntry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000 + ordinal,
    role: "user",
    byteLength: 128,
    bodyDigest: `d-${rowId}`,
  };
}

function skeletonEntries(
  fromOrdinal: number,
  count: number,
): RowSkeletonEntry[] {
  return Array.from({ length: count }, (_unused, index) =>
    skeletonEntry(`row-${fromOrdinal + index}`, fromOrdinal + index),
  );
}

function rangeResponse(input: {
  readonly epoch: number;
  readonly fromOrdinal: number;
  readonly rowIds: readonly string[];
  readonly incompleteRowIds?: readonly string[];
  readonly messages: readonly Message[];
  readonly events?: readonly ChatEvent[];
}): ChatRangeResponse {
  return {
    requestId: `req-${input.fromOrdinal}`,
    epoch: input.epoch,
    fromOrdinal: input.fromOrdinal,
    rowIds: [...input.rowIds],
    incompleteRowIds: [...(input.incompleteRowIds ?? [])],
    messages: [...input.messages],
    events: [...(input.events ?? [])],
    rowContext: {},
    reachedStart: input.fromOrdinal === 0,
    reachedEnd: false,
  };
}

/** A window with a complete 10-row skeleton at epoch 1 and nothing hydrated. */
function windowWithSkeleton(rowCount: number): TranscriptWindow {
  const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
    epoch: 1,
    rowCount,
    indexRevision: null,
    tail: { fromOrdinal: rowCount, messages: [], events: [] },
  });
  return applySkeletonChunk(seeded, {
    epoch: 1,
    fromOrdinal: 0,
    entries: skeletonEntries(0, rowCount),
    isFinal: true,
  });
}

describe("windowed snapshot seating", () => {
  it("seats the inline tail as a hydrated span", () => {
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 5,
      indexRevision: null,
      tail: {
        fromOrdinal: 3,
        messages: [userMessage("m-3", 3), userMessage("m-4", 4)],
        events: [],
      },
    });
    expect(window.rowCount).toBe(5);
    expect(window.spans).toHaveLength(1);
    expect(window.spans[0]?.fromOrdinal).toBe(3);
    expect(window.hydratedBytes).toBeGreaterThan(0);
  });

  it("keeps the scrollback a reader is looking at when the epoch is unchanged", () => {
    // An aux-only re-broadcast (a queue change, an approval) re-sends the
    // snapshot. Dropping hydrated history on one of those would make ordinary
    // chat activity evict the rows on screen.
    const seeded = applyRangeResponse(windowWithSkeleton(10), {
      ...rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0)],
      }),
    });
    expect(seeded.spans).toHaveLength(1);

    const refreshed = applyWindowedSnapshot(seeded, {
      epoch: 1,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 9, messages: [userMessage("m-9", 9)], events: [] },
    });
    expect(refreshed.spans.map((span) => span.fromOrdinal)).toEqual([0, 9]);
  });

  it("drops every held body when the epoch moves", () => {
    const seeded = applyRangeResponse(
      windowWithSkeleton(10),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    const rebased = applyWindowedSnapshot(seeded, {
      epoch: 2,
      rowCount: 4,
      indexRevision: null,
      tail: { fromOrdinal: 4, messages: [], events: [] },
    });
    expect(rebased.spans).toEqual([]);
    expect(rebased.skeleton).toEqual([]);
    expect(rebased.hydratedBytes).toBe(0);
  });

  it("seats nothing for an empty tail, which is a real answer and not a bug", () => {
    // The host's tail walks backwards under a hard byte ceiling with no
    // always-serve-one exception, so a chat whose last row is a 1.27 MB tool
    // result ships zero rows.
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 40,
      indexRevision: null,
      tail: { fromOrdinal: 40, messages: [], events: [] },
    });
    expect(window.spans).toEqual([]);
    expect(window.rowCount).toBe(40);
  });
});

describe("skeleton chunks", () => {
  it("places entries sparsely and completes only on the final chunk", () => {
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 6,
      indexRevision: null,
      tail: { fromOrdinal: 6, messages: [], events: [] },
    });
    const first = applySkeletonChunk(seeded, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 3),
      isFinal: false,
    });
    expect(first.skeletonComplete).toBe(false);
    expect(first.skeleton[2]?.rowId).toBe("row-2");
    expect(first.skeleton[5]).toBeUndefined();

    const second = applySkeletonChunk(first, {
      epoch: 1,
      fromOrdinal: 3,
      entries: skeletonEntries(3, 3),
      isFinal: true,
    });
    expect(second.skeletonComplete).toBe(true);
    expect(second.invalidated).toBe(false);
  });

  it("declares the index void when the final chunk leaves it short", () => {
    // Chunks were lost. Serving ordinals off an index the client KNOWS is
    // incomplete renders a transcript that is silently missing rows.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 9,
      indexRevision: null,
      tail: { fromOrdinal: 9, messages: [], events: [] },
    });
    const short = applySkeletonChunk(seeded, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 4),
      isFinal: true,
    });
    expect(short.invalidated).toBe(true);
    expect(short.skeletonComplete).toBe(false);
  });

  it("declares the index void when a dropped INTERIOR chunk leaves a hole", () => {
    // The sparse-array trap: the final chunk reaches `rowCount`, so length
    // agrees and the skeleton reads complete while ordinals 3-5 are holes.
    // Length is not coverage.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 9,
      indexRevision: null,
      tail: { fromOrdinal: 9, messages: [], events: [] },
    });
    const first = applySkeletonChunk(seeded, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 3),
      isFinal: false,
    });
    // The chunk covering 3-5 never arrives; the final chunk covering 6-8 does.
    const withHole = applySkeletonChunk(first, {
      epoch: 1,
      fromOrdinal: 6,
      entries: skeletonEntries(6, 3),
      isFinal: true,
    });

    expect(withHole.skeleton).toHaveLength(9);
    expect(withHole.skeleton[4]).toBeUndefined();
    expect(withHole.skeletonComplete).toBe(false);
    expect(withHole.invalidated).toBe(true);
  });

  it("ignores a chunk from a coordinate space the client has left", () => {
    const window = windowWithSkeleton(4);
    const stale = applySkeletonChunk(window, {
      epoch: 0,
      fromOrdinal: 0,
      entries: [skeletonEntry("other-0", 0)],
      isFinal: true,
    });
    expect(stale.skeleton[0]?.rowId).toBe("row-0");
  });

  it("runs the DELAYED identity check on a tail seated before the skeleton arrived", () => {
    // The tail rides the snapshot, which is emitted before any skeleton chunk,
    // so it is seated with no ids to check against. The chunk that later
    // reaches those ordinals is the first authority - and if it names
    // different rows, the tail was hydrated from a projection this client no
    // longer holds.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 3,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [userMessage("m-1", 1)], events: [] },
    });
    expect(seeded.spans).toHaveLength(1);

    // First the skeleton agrees (fills the empty ids) - the body survives.
    const agreeing = applySkeletonChunk(seeded, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 3),
      isFinal: true,
    });
    expect(agreeing.spans).toHaveLength(1);

    // Now a span whose ids are KNOWN and contradicted must go.
    const hydrated = applyRangeResponse(
      agreeing,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    const contradicting = applySkeletonChunk(hydrated, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("row-0-rewritten", 0)],
      isFinal: false,
    });
    expect(contradicting.spans.some((span) => span.fromOrdinal === 0)).toBe(
      false,
    );
  });
});

describe("index deltas", () => {
  it("appends without invalidating anything already held", () => {
    const held = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    const appended = applyIndexChange(held, {
      epoch: 1,
      rowCount: 6,
      indexRevision: 1,
      changes: [{ type: "appended", entries: skeletonEntries(4, 2) }],
    });
    expect(appended.rowCount).toBe(6);
    expect(appended.skeleton[5]?.rowId).toBe("row-5");
    expect(appended.spans).toHaveLength(1);
  });

  it("seats an append at rowCount while the skeleton is still streaming", () => {
    // `windowWithSkeleton` delivers a COMPLETE skeleton, where `length` and
    // `rowCount` happen to agree - so every other case here would pass with
    // either rule. This one separates them: only 30 of 100 ordinals have
    // arrived, so appending at `skeleton.length` would seat the two new tail
    // rows at ordinals 30 and 31, over scrollback whose real entries are still
    // in flight. Then the identity check rejects a valid range for 30-31 while
    // 100-101 stay holes forever.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 100,
      indexRevision: null,
      tail: { fromOrdinal: 100, messages: [], events: [] },
    });
    const partial = applySkeletonChunk(seeded, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 30),
      isFinal: false,
    });
    expect(partial.skeleton).toHaveLength(30);

    const appended = applyIndexChange(partial, {
      epoch: 1,
      rowCount: 102,
      indexRevision: 1,
      changes: [{ type: "appended", entries: skeletonEntries(100, 2) }],
    });

    expect(appended.skeleton[100]?.rowId).toBe("row-100");
    expect(appended.skeleton[101]?.rowId).toBe("row-101");
    expect(appended.skeleton[30]).toBeUndefined();
    expect(appended.rowCount).toBe(102);
    expect(appended.skeletonComplete).toBe(false);
  });

  it("voids the coordinate when a lost frame makes the append growth discontinuous", () => {
    // The host's pump keeps drop-and-continue for a non-deterministic send
    // failure, so an `indexChanged` can be lost while the stream survives.
    // The next frame then reports a `rowCount` two larger while carrying one
    // entry. Seating it from the stale `rowCount` puts row-101 at ordinal 100
    // - a wrong entry at a real ordinal, with 101 left a hole and nothing
    // later repairing either.
    const held = windowWithSkeleton(100);

    const afterLoss = applyIndexChange(held, {
      epoch: 1,
      rowCount: 102,
      indexRevision: 1,
      changes: [{ type: "appended", entries: skeletonEntries(101, 1) }],
    });

    expect(afterLoss.invalidated).toBe(true);
    expect(afterLoss.rowCount).toBe(102);
    // Nothing was seated at the ordinal the lost frame owned.
    expect(afterLoss.skeleton[100]).toBeUndefined();
  });

  it("accepts an append whose entry count accounts for the whole growth", () => {
    // The positive control for the discontinuity guard: without it the test
    // above passes for a window that rejects every append.
    const held = windowWithSkeleton(100);

    const appended = applyIndexChange(held, {
      epoch: 1,
      rowCount: 102,
      indexRevision: 1,
      changes: [{ type: "appended", entries: skeletonEntries(100, 2) }],
    });

    expect(appended.invalidated).toBe(false);
    expect(appended.skeleton[100]?.rowId).toBe("row-100");
    expect(appended.skeleton[101]?.rowId).toBe("row-101");
  });

  it("applies an append whose rows a snapshot already counted, at the frame's own ordinals", () => {
    // The host's append republish emits the bounded snapshot FIRST - stamped
    // with the post-append `rowCount` and the subscriber's pre-delta
    // `indexRevision` - and the delta for the same append right behind it. So
    // the delta lands on a window whose `rowCount` already includes its rows.
    // Read against `window.rowCount`, that has the `0 !== appendedRows`
    // signature of a lost frame; voiding on it blanked the transcript and
    // forced a resnapshot on EVERY append for the life of a turn, which is an
    // empty chat under an active stream. The frame is self-consistent - its
    // entries occupy `[rowCount - appended, rowCount)` - so it must apply, and
    // seat at the frame-derived base rather than one past it.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 0,
      rowCount: 1,
      indexRevision: 0,
      tail: {
        fromOrdinal: 0,
        messages: [userMessage("m-0", 0)],
        events: [],
      },
    });
    expect(seeded.rowCount).toBe(1);

    const appended = applyIndexChange(seeded, {
      epoch: 0,
      rowCount: 1,
      indexRevision: 1,
      changes: [{ type: "appended", entries: [skeletonEntry("m-0", 0)] }],
    });

    expect(appended.invalidated).toBe(false);
    expect(appended.rowCount).toBe(1);
    // At ordinal 0 - the ordinal the frame names - not at `window.rowCount`.
    expect(appended.skeleton[0]?.rowId).toBe("m-0");
    expect(appended.skeleton[1]).toBeUndefined();
    // And the same baseline governs the stream prefix. The snapshot moved
    // `rowCount` to 1 while the prefix was still 0, so an equality against
    // `window.rowCount` never holds again: the prefix freezes below `rowCount`
    // for the rest of the epoch, `skeletonComplete` can never be re-established
    // from it, and the completion watchdog reads a healthy stream as stalled.
    expect(appended.skeletonStreamCoveredThrough).toBe(1);
    expect(appended.skeletonComplete).toBe(true);
  });

  it("leaves the skeleton incomplete when the append does not fill what the snapshot got ahead by", () => {
    // The negative that keeps the assertion above from passing for the wrong
    // reason: re-establishing completeness is conditional on the append
    // actually accounting for what the snapshot got ahead by, not on the frame
    // being an append. Here the snapshot moved `rowCount` by three and the
    // delta names only the last of them, so ordinals 0 and 1 are undelivered -
    // whatever the cause - and the client must keep saying so.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 0,
      rowCount: 3,
      indexRevision: 0,
      tail: {
        fromOrdinal: 0,
        messages: [userMessage("m-0", 0)],
        events: [],
      },
    });

    const appended = applyIndexChange(seeded, {
      epoch: 0,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "appended", entries: [skeletonEntry("m-2", 2)] }],
    });

    expect(appended.invalidated).toBe(false);
    expect(appended.skeleton[2]?.rowId).toBe("m-2");
    expect(appended.skeleton[1]).toBeUndefined();
    expect(appended.skeletonStreamCoveredThrough).toBe(0);
    expect(appended.skeletonComplete).toBe(false);
  });

  it("drops the whole span containing a row that was rewritten in place", () => {
    // The whole span, not the row: a span's records are a DEDUPLICATED union
    // across its rows, so the client cannot say which records belong to the
    // row that changed. Keeping the span would mean guessing, and a wrong
    // guess leaves a stale body rendered as current.
    const held = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1", "row-2"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
    );
    expect(held.spans).toHaveLength(1);

    const updated = applyIndexChange(held, {
      epoch: 1,
      rowCount: 4,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 1, entry: skeletonEntry("row-1", 1) }],
        },
      ],
    });
    expect(updated.spans).toEqual([]);
    expect(updated.hydratedBytes).toBe(0);
  });

  it("applies an append and an in-place update from ONE frame atomically", () => {
    // A turn finishing is routinely both at once: it appends rows and rewrites
    // the streaming row that preceded them. Applied together, the skeleton's
    // length and its entries agree; applied apart, the length already equals
    // `rowCount` while one entry is wrong, which neither side can detect.
    const held = applyRangeResponse(
      windowWithSkeleton(3),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 2,
        rowIds: ["row-2"],
        messages: [userMessage("m-2", 2)],
      }),
    );
    const next = applyIndexChange(held, {
      epoch: 1,
      rowCount: 5,
      indexRevision: 1,
      changes: [
        { type: "appended", entries: skeletonEntries(3, 2) },
        {
          type: "updated",
          entries: [{ ordinal: 2, entry: skeletonEntry("row-2", 2) }],
        },
      ],
    });
    expect(next.rowCount).toBe(5);
    expect(next.skeleton).toHaveLength(5);
    expect(next.skeleton[4]?.rowId).toBe("row-4");
    // The rewritten row's body went with its span.
    expect(next.spans).toEqual([]);
  });

  it("wipes and invalidates on reindexed", () => {
    const held = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    const reindexed = applyIndexChange(held, {
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(reindexed.invalidated).toBe(true);
    expect(reindexed.spans).toEqual([]);
    expect(reindexed.skeleton).toEqual([]);
    expect(reindexed.epoch).toBe(2);
  });

  it("ignores a non-reindexed delta stamped with an OLDER epoch", () => {
    // A straggler: its ordinals were renumbered by the change that moved this
    // window on, so there is nothing to apply and nothing to learn.
    const window = applyWindowedSnapshot(windowWithSkeleton(4), {
      epoch: 7,
      rowCount: 4,
      indexRevision: null,
      tail: { fromOrdinal: 4, messages: [], events: [] },
    });
    const stale = applyIndexChange(window, {
      epoch: 1,
      rowCount: 99,
      indexRevision: 1,
      changes: [{ type: "appended", entries: skeletonEntries(4, 1) }],
    });
    expect(stale).toBe(window);
  });

  it("voids the index on a non-reindexed delta stamped with a NEWER epoch", () => {
    // The other direction is not a straggler, it is a LOSS: the snapshot (or
    // the `reindexed` beside it) that would have carried the new coordinate
    // space here never arrived. Discarding this frame the way a straggler is
    // discarded leaves the client rendering the superseded space while the host
    // - which records the index as held on EMIT, not on delivery - sends only
    // deltas from here on. Nothing else re-requests: the skeleton is complete,
    // so the completion watchdog is disarmed, and a chat that has just been
    // reindexed by a restore is typically idle, so no later snapshot comes.
    const held = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    expect(held.spans).toHaveLength(1);
    const ahead = applyIndexChange(held, {
      epoch: 2,
      rowCount: 6,
      indexRevision: 3,
      changes: [{ type: "appended", entries: skeletonEntries(4, 2) }],
    });
    // Identical to what an observed `reindexed` produces, because that is what
    // this IS - the same reindex, learned late.
    expect(ahead.invalidated).toBe(true);
    expect(ahead.spans).toEqual([]);
    expect(ahead.skeleton).toEqual([]);
    // The frame's own coordinates are adopted, so the resnapshot this triggers
    // is asked for - and latched on - the space the client is moving into.
    expect(ahead.epoch).toBe(2);
    expect(ahead.rowCount).toBe(6);
    expect(ahead.indexRevision).toBe(3);
  });

  it("does not seat the newer epoch's appended entries at the old ordinals", () => {
    // The failure this prevents is not "the delta was dropped", it is the delta
    // being APPLIED against a skeleton it does not describe. `rowCount` and the
    // append cursor both belong to the space the client is leaving, so seating
    // the entries would put real rows at ordinals they do not occupy - the same
    // silent mis-seating the append-count detector exists for, one epoch over.
    const ahead = applyIndexChange(windowWithSkeleton(4), {
      epoch: 2,
      rowCount: 5,
      indexRevision: 1,
      changes: [{ type: "appended", entries: skeletonEntries(4, 1) }],
    });
    expect(ahead.skeleton).toEqual([]);
    expect(ahead.skeletonComplete).toBe(false);
  });
});

describe("range responses", () => {
  it("discards a response whose row ids contradict the skeleton", () => {
    // The identity check is what makes the ordinal coordinate safe: a missed
    // invalidation must cost a wasted round trip, never bodies under the wrong
    // rows.
    const window = windowWithSkeleton(4);
    const seated = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 1,
        rowIds: ["row-1", "SOMETHING-ELSE"],
        messages: [userMessage("m-1", 1)],
      }),
    );
    expect(seated.spans).toEqual([]);
  });

  it("invalidates on a contradiction so the planner cannot spin on it", () => {
    // Codex P1 (#1459): dropping the response and leaving the window valid
    // makes the planner re-request the SAME ordinals, which the host answers
    // with the same contradicting ids under the same epoch - forever. Only a
    // resnapshot can repair a coordinate disagreement, so raise the flag that
    // asks for one.
    const window = windowWithSkeleton(4);
    const seated = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 1,
        rowIds: ["row-1", "SOMETHING-ELSE"],
        messages: [userMessage("m-1", 1)],
      }),
    );

    expect(seated.invalidated).toBe(true);
    // And the planner now asks for a resnapshot rather than the same range.
    expect(
      planTranscriptHydration(seated, { fromOrdinal: 0, toOrdinal: 4 }, []),
    ).toBeNull();
  });

  it("does not invalidate on a superseded epoch, which repairs itself", () => {
    // The contrast that makes the case above a real distinction: a newer epoch
    // is already on its way and will re-seat the coordinate space, so dropping
    // the response is the whole of the correct response.
    const window = windowWithSkeleton(4);
    const seated = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 0,
        fromOrdinal: 1,
        rowIds: ["row-1"],
        messages: [userMessage("m-1", 1)],
      }),
    );

    expect(seated.invalidated).toBe(false);
  });

  it("discards a response from a superseded epoch", () => {
    const window = windowWithSkeleton(4);
    const seated = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 0,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    expect(seated.spans).toEqual([]);
  });

  it("merges abutting spans and keeps one copy of a turn that straddles them", () => {
    // A folded assistant turn belongs to several rows, so a span boundary
    // drawn through it puts the SAME records in both responses. Left
    // unmerged - or merged without a dedupe - the renderer would fold that
    // turn twice.
    const shared = userMessage("m-shared", 2);
    const sharedEvent = event("e-shared", 2);
    const window = windowWithSkeleton(6);
    const first = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1", "row-2"],
        messages: [userMessage("m-0", 0), shared],
        events: [sharedEvent],
      }),
    );
    const second = applyRangeResponse(
      first,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 3,
        rowIds: ["row-3", "row-4"],
        messages: [shared, userMessage("m-4", 4)],
        events: [sharedEvent, event("e-4", 4)],
      }),
    );
    expect(second.spans).toHaveLength(1);
    const merged = second.spans[0];
    expect(merged.fromOrdinal).toBe(0);
    expect(merged.rowIds).toEqual([
      "row-0",
      "row-1",
      "row-2",
      "row-3",
      "row-4",
    ]);
    expect(merged.messages.map((message) => message.messageId)).toEqual([
      "m-0",
      "m-shared",
      "m-4",
    ]);
    expect(merged.events.map((entry) => entry.eventId)).toEqual([
      "e-shared",
      "e-4",
    ]);
  });
});

describe("gaps and what to request next", () => {
  it("reports the unhydrated sub-ranges, clamped to the row count", () => {
    const window = applyRangeResponse(
      windowWithSkeleton(10),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 4,
        rowIds: ["row-4", "row-5"],
        messages: [userMessage("m-4", 4)],
      }),
    );
    expect(
      transcriptHydrationGaps(window, { fromOrdinal: 0, toOrdinal: 50 }),
    ).toEqual([
      { fromOrdinal: 0, toOrdinal: 4 },
      { fromOrdinal: 6, toOrdinal: 10 },
    ]);
  });

  it("counts every row no client-side scan can see", () => {
    const window = applyRangeResponse(
      windowWithSkeleton(10),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 4,
        rowIds: ["row-4", "row-5"],
        messages: [userMessage("m-4", 4)],
      }),
    );
    // Two rows hydrated out of ten - the number find has to disclose.
    expect(unhydratedRowCount(window)).toBe(8);
  });

  it("counts unavailable rows as unhydrated while suppressing their retries", () => {
    const partial = applyRangeResponse(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-before-skeleton"],
        incompleteRowIds: ["row-before-skeleton"],
        messages: [userMessage("row-before-skeleton", 1)],
      }),
    );

    expect(partial.unavailableRowOrdinals).toEqual([0]);
    expect(
      transcriptHydrationGaps(partial, { fromOrdinal: 0, toOrdinal: 1 }),
    ).toEqual([]);
    expect(unhydratedRowCount(partial)).toBe(1);
  });

  it("counts nothing unhydrated on the legacy line's inert window", () => {
    // `rowCount` 0 with no spans is what the legacy line hands the renderer.
    // A caveat there would fire on every non-windowed chat in the app.
    expect(unhydratedRowCount(emptyTranscriptWindow())).toBe(0);
  });

  it("asks for the tail when the snapshot arrived with rows but no bodies", () => {
    // The obligation the empty-tail case creates. Without it the chat has rows
    // in it and displays as empty, with nothing on screen to suggest a retry.
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 40,
      indexRevision: null,
      tail: { fromOrdinal: 40, messages: [], events: [] },
    });
    expect(planTranscriptHydration(window, null, [])).toEqual({
      fromOrdinal: 20,
      toOrdinal: 40,
    });
  });

  it("moves on to the visible span once the tail is hydrated", () => {
    const window = applyRangeResponse(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 40,
        indexRevision: null,
        tail: { fromOrdinal: 40, messages: [], events: [] },
      }),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 20,
        rowIds: Array.from({ length: 20 }, (_u, i) => `row-${20 + i}`),
        messages: [userMessage("m-20", 20)],
      }),
    );
    expect(planTranscriptHydration(window, null, [])).toBeNull();
    expect(
      planTranscriptHydration(window, { fromOrdinal: 0, toOrdinal: 10 }, []),
    ).toEqual({ fromOrdinal: 0, toOrdinal: 10 });
  });

  it("asks for nothing while the index is void - that owes a resnapshot, not a range", () => {
    const window = applyIndexChange(windowWithSkeleton(10), {
      epoch: 2,
      rowCount: 10,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(
      planTranscriptHydration(window, { fromOrdinal: 0, toOrdinal: 5 }, []),
    ).toBeNull();
  });

  /**
   * The third obligation: rows something other than the viewport is blocked on.
   *
   * Today that is a pending interview's question, whose card renders in the
   * COMPOSER - so no amount of scrolling will ever bring its row into view and
   * viewport-driven hydration would never fetch it. Without this the client
   * correctly stops offering to dismiss a cold question and then renders
   * nothing at all, which is a chat blocked with no affordance.
   */
  describe("required ordinals", () => {
    /** A 40-row window whose eager tail is hydrated and nothing else. */
    function tailHydrated(): TranscriptWindow {
      return applyRangeResponse(
        applyWindowedSnapshot(emptyTranscriptWindow(), {
          epoch: 1,
          rowCount: 40,
          indexRevision: null,
          tail: { fromOrdinal: 40, messages: [], events: [] },
        }),
        rangeResponse({
          epoch: 1,
          fromOrdinal: 20,
          rowIds: Array.from({ length: 20 }, (_u, i) => `row-${20 + i}`),
          messages: [userMessage("m-20", 20)],
        }),
      );
    }

    it("asks for a required row the window does not hold, one row wide", () => {
      // One row, not the gap around it: the host always serves the first
      // requested row whatever it costs, so a single-row ask cannot be
      // squeezed out by scrollback nobody asked for.
      expect(planTranscriptHydration(tailHydrated(), null, [4])).toEqual({
        fromOrdinal: 4,
        toOrdinal: 5,
      });
    });

    it("outranks the visible span", () => {
      // A reader scrolled elsewhere must not starve the row the chat is
      // blocked on - the viewport keeps re-planning itself every frame.
      expect(
        planTranscriptHydration(
          tailHydrated(),
          { fromOrdinal: 0, toOrdinal: 3 },
          [9],
        ),
      ).toEqual({ fromOrdinal: 9, toOrdinal: 10 });
    });

    it("yields to the missing tail, which is the cheaper way to the same row", () => {
      const noTail = applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 40,
        indexRevision: null,
        tail: { fromOrdinal: 40, messages: [], events: [] },
      });
      expect(planTranscriptHydration(noTail, null, [4])).toEqual({
        fromOrdinal: 20,
        toOrdinal: 40,
      });
    });

    it("skips a required row the window already holds", () => {
      // Ordinal 25 is inside the hydrated tail. Re-asking for it would put the
      // planner in a loop that never reaches the viewport.
      expect(
        planTranscriptHydration(
          tailHydrated(),
          { fromOrdinal: 0, toOrdinal: 3 },
          [25],
        ),
      ).toEqual({ fromOrdinal: 0, toOrdinal: 3 });
    });

    it("takes the lowest required ordinal first", () => {
      expect(planTranscriptHydration(tailHydrated(), null, [12, 4, 9])).toEqual(
        {
          fromOrdinal: 4,
          toOrdinal: 5,
        },
      );
    });

    it("ignores an ordinal outside the transcript", () => {
      // A judgement carried across a `rowCount` change names a row that does
      // not exist, and a range framed against it comes back empty forever - a
      // hydration loop with nothing on the other end. There is no bounds check
      // for this: `transcriptHydrationGaps` clamps, so an absent row reports
      // itself hydrated. This pins the COMPOSED behaviour, which is what a
      // second bound here would have restated.
      expect(
        planTranscriptHydration(tailHydrated(), null, [40, 99, -1]),
      ).toBeNull();
    });
  });
});

describe("eviction", () => {
  it("evicts the coldest span first and never the tail", () => {
    let window = windowWithSkeleton(30);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("cold", 0)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("warm", 10)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 28,
        rowIds: ["row-28", "row-29"],
        messages: [userMessage("tail", 28)],
      }),
    );

    // A budget that only two of the three spans can fit.
    const evicted = evictTranscriptWindowToBudget(
      window,
      window.hydratedBytes - 1,
      null,
      [],
    );
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([10, 28]);
  });

  it("keeps the tail even when it is the coldest span", () => {
    // It is where the live turn happens and where every snapshot re-seats
    // content, so evicting it trades a bounded cache for a re-fetch loop.
    let window = windowWithSkeleton(20);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 18,
        rowIds: ["row-18", "row-19"],
        messages: [userMessage("tail", 18)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("warmer", 0)],
      }),
    );
    const evicted = evictTranscriptWindowToBudget(window, 1, null, []);
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([18]);
  });

  it("touching a span reorders eviction away from it", () => {
    let window = windowWithSkeleton(30);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("old", 0)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("new", 10)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 28,
        rowIds: ["row-28", "row-29"],
        messages: [userMessage("tail", 28)],
      }),
    );

    // The reader is looking at the OLDEST-loaded span. Touching it must
    // reorder eviction, or scrolling up evicts exactly what is on screen.
    const oldTouchedAt = window.spans.find(
      (span) => span.fromOrdinal === 0,
    )?.touchedAt;
    const touched = touchTranscriptRange(window, {
      fromOrdinal: 0,
      toOrdinal: 2,
    });
    expect(
      touched.spans.find((span) => span.fromOrdinal === 0)?.touchedAt,
    ).toBeGreaterThan(oldTouchedAt ?? -1);

    const evicted = evictTranscriptWindowToBudget(
      touched,
      touched.hydratedBytes - 1,
      null,
      [],
    );
    // The now-untouched span at 10 is the coldest, so it goes instead of 0.
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([0, 28]);
  });

  it("touchTranscriptRange is identity-stable when nothing overlaps", () => {
    let window = windowWithSkeleton(30);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("mid", 10)],
      }),
    );

    const touched = touchTranscriptRange(window, {
      fromOrdinal: 20,
      toOrdinal: 22,
    });
    expect(touched).toBe(window);
  });
});

describe("eviction protects the visible span", () => {
  it("never evicts a span overlapping visible, even when it alone exceeds the budget, and drops a cold non-overlapping span first", () => {
    let window = windowWithSkeleton(30);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("cold", 0)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("visible", 10)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 28,
        rowIds: ["row-28", "row-29"],
        messages: [userMessage("tail", 28)],
      }),
    );

    // A budget of 1 byte: everything alone exceeds it. The visible span (10)
    // must survive - the host's range read always serves the first requested
    // row whatever it costs, so evicting the visible span here would only
    // re-request it and evict it again, forever - while the cold span (0),
    // which nothing is looking at, is fair game.
    const evicted = evictTranscriptWindowToBudget(
      window,
      1,
      { fromOrdinal: 10, toOrdinal: 12 },
      [],
    );
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([10, 28]);
    // The budget is SOFT against the protected spans: the result stays over
    // budget rather than sacrificing them.
    expect(evicted.hydratedBytes).toBeGreaterThan(1);
  });

  it("never evicts a span holding a required row", () => {
    // The same re-fetch loop as the visible span, in its purest form: a
    // required ordinal is re-planned with no viewport to scroll away from, so
    // evicting its span means fetching that one row forever.
    let window = windowWithSkeleton(30);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("question", 0)],
      }),
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("cold", 10)],
      }),
    );

    // Nothing visible, so only the tail rule and the required rule can save a
    // span - and ordinal 0's span is the coldest by insertion order.
    const evicted = evictTranscriptWindowToBudget(window, 1, null, [0]);
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([0]);
  });
});

describe("reading a long chat upward from the tail", () => {
  /** ~400 KiB in one message, so a few rows cross the span merge cap. */
  function fatMessage(messageId: string, timestamp: number): Message {
    return {
      role: "user",
      messageId,
      sender: { type: "user", userId: "owner-1" },
      message: {
        kind: "user",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "x".repeat(400 * 1024) }],
            },
          ],
        },
        browserAnnotations: [],
      },
      timestamp,
      sessionAnchor: null,
    };
  }

  /**
   * The ordinary way to read history: hydrate the tail, then walk backwards,
   * each response adjacent to the one before it.
   */
  function walkUpwardFromTail(
    rowCount: number,
    steps: number,
  ): TranscriptWindow {
    let window = windowWithSkeleton(rowCount);
    for (let step = 0; step < steps; step += 1) {
      const fromOrdinal = rowCount - (step + 1) * 2;
      window = applyRangeResponse(
        window,
        rangeResponse({
          epoch: 1,
          fromOrdinal,
          rowIds: [`row-${fromOrdinal}`, `row-${fromOrdinal + 1}`],
          messages: [fatMessage(`m-${fromOrdinal}`, fromOrdinal)],
        }),
      );
    }
    return window;
  }

  it("does not coalesce the whole visited history into the tail span", () => {
    const window = walkUpwardFromTail(20, 6);

    // Every response was adjacent to the last. Before the merge cap this was
    // ONE span [8,20) whose end touches rowCount - the tail span - and the
    // tail exemption then covered all of it.
    expect(window.spans.length).toBeGreaterThan(1);
    const tailSpan = window.spans.find(
      (span) => span.fromOrdinal + span.rowIds.length >= window.rowCount,
    );
    expect(tailSpan).toBeDefined();
    expect(tailSpan?.bytes).toBeLessThanOrEqual(SPAN_MERGE_MAX_BYTES);
  });

  it("evicts the cold scrollback behind the tail instead of protecting all of it", () => {
    const window = walkUpwardFromTail(20, 6);
    const budget = 1024 * 1024;
    expect(window.hydratedBytes).toBeGreaterThan(budget);

    // The reader is at the tail; everything behind it is fair game.
    const evicted = evictTranscriptWindowToBudget(
      window,
      budget,
      { fromOrdinal: 18, toOrdinal: 20 },
      [],
    );

    expect(evicted.hydratedBytes).toBeLessThan(window.hydratedBytes);
    expect(evicted.spans.length).toBeLessThan(window.spans.length);
    // The tail survived: it is where the live turn lands and where every
    // snapshot re-seats content.
    expect(
      evicted.spans.some(
        (span) => span.fromOrdinal + span.rowIds.length >= evicted.rowCount,
      ),
    ).toBe(true);
  });

  it("still answers the downward-scan question across touching spans", () => {
    const window = walkUpwardFromTail(20, 6);
    // Coverage runs [8,20) unbroken, just not as a single span - the record at
    // the oldest visited row still has every later record held.
    expect(holdsEveryRecordFrom(window, "m-8")).toBe(true);
    // A record the window never hydrated is not held.
    expect(holdsEveryRecordFrom(window, "m-0")).toBe(false);
  });
});

describe("records the index has not placed yet", () => {
  it("holds them, reports them last, and drops duplicates of what a span already has", () => {
    const window = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    const withLive = appendLiveRecords(window, {
      // `m-0` is already hydrated; the host re-sends it on a reconnect
      // retransmitting an accepted send. The placed copy is the one to keep.
      messages: [userMessage("m-0", 0), userMessage("m-live", 9)],
      events: [event("e-live", 9)],
    });

    expect(withLive.liveMessages.map((m) => m.messageId)).toEqual(["m-live"]);
    const records = hydratedRecords(withLive);
    // Spans first, unplaced last - which is also chronological, since an
    // unplaced record is the newest thing the client has.
    expect(records.messages.map((m) => m.messageId)).toEqual(["m-0", "m-live"]);
    expect(records.events.map((e) => e.eventId)).toEqual(["e-live"]);
  });

  it("bounds row-less live events instead of growing for the session", () => {
    // Supersession cannot reach this class at all. A live record leaves via a
    // span carrying it, which requires it to belong to a ROW - and
    // `send.accepted`, the `queue.*` family and their siblings materialize no
    // row, so no span will ever name them however far the reader scrolls.
    // `hydratedBytes` is `totalBytes(spans)`, so they are not charged to the
    // budget either and nothing else notices them accumulating.
    let window = windowWithSkeleton(4);
    const total = MAX_LIVE_EVENTS + 200;
    for (let index = 0; index < total; index += 1) {
      window = appendLiveRecords(window, {
        messages: [],
        events: [event(`row-less-${index}`, index)],
      });
    }

    expect(window.liveEvents).toHaveLength(MAX_LIVE_EVENTS);
    // The NEWEST are kept: those are the ones with any chance of being live-
    // relevant, and an older one that genuinely belongs to a row is re-served
    // by that row's hydration.
    expect(window.liveEvents[window.liveEvents.length - 1].eventId).toBe(
      `row-less-${total - 1}`,
    );
    expect(window.liveEvents[0].eventId).toBe(
      `row-less-${total - MAX_LIVE_EVENTS}`,
    );
  });

  it("updates a message wherever it lives, and says so when it lives nowhere", () => {
    const seeded = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
    );
    const window = appendLiveRecords(seeded, {
      messages: [userMessage("m-live", 9)],
      events: [],
    });

    const hydrated = updateWindowMessage(window, "m-0", (message) => ({
      ...message,
      timestamp: 111,
    }));
    expect(hydrated.held).toBe(true);
    expect(hydrated.window.spans[0].messages[0].timestamp).toBe(111);

    const live = updateWindowMessage(hydrated.window, "m-live", (message) => ({
      ...message,
      timestamp: 222,
    }));
    expect(live.held).toBe(true);
    expect(live.window.liveMessages[0].timestamp).toBe(222);

    // Outside the window entirely. `held: false` is not an error - it is the
    // case the caller answers by dropping the change and letting hydration
    // serve the host's own version.
    const absent = updateWindowMessage(live.window, "m-nowhere", (message) => ({
      ...message,
      timestamp: 333,
    }));
    expect(absent.held).toBe(false);
    expect(absent.window).toBe(live.window);
  });

  it("charges the byte delta exactly, in both directions", () => {
    // The bytes are charged incrementally because two callers run at streaming
    // frequency, and a whole-span recompute would serialize every record the
    // span holds once per token. Incremental is only safe if it is EXACT, so
    // this pins it against a from-scratch measure of the same span - and in
    // both directions, because `+ next - previous` and a naive `+ next` agree
    // on every growing rewrite and disagree only when a row sheds bytes.
    const seeded = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
    );
    const spanBytes = (window: TranscriptWindow): number =>
      window.spans[0].messages.reduce(
        (sum, message) => sum + recordByteLength(message),
        0,
      );

    const grown = updateWindowMessage(seeded, "m-0", (message) =>
      messageWithText(message, "a much longer body ".repeat(40)),
    );
    expect(grown.held).toBe(true);
    expect(grown.window.spans[0].bytes).toBe(spanBytes(grown.window));
    expect(grown.window.hydratedBytes).toBe(spanBytes(grown.window));
    // And it moved: an incremental charge that silently did nothing would also
    // satisfy an equality written against a span that never changed.
    expect(grown.window.spans[0].bytes).toBeGreaterThan(seeded.spans[0].bytes);

    const shrunk = updateWindowMessage(grown.window, "m-0", (message) =>
      messageWithText(message, "x"),
    );
    expect(shrunk.window.spans[0].bytes).toBe(spanBytes(shrunk.window));
    expect(shrunk.window.spans[0].bytes).toBeLessThan(
      grown.window.spans[0].bytes,
    );
  });
});

describe("the streaming row's byte charge", () => {
  function windowWithColdAndTail(): TranscriptWindow {
    let window = windowWithSkeleton(30);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("cold", 0)],
      }),
    );
    return applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 29,
        rowIds: ["row-29"],
        messages: [userMessage("live", 29)],
      }),
    );
  }

  it("leaves the figure alone while streaming, and names the row it owes", () => {
    const seeded = windowWithColdAndTail();
    const streamed = streamWindowMessage(seeded, "live", (message) =>
      messageWithText(message, "streamed body ".repeat(200)),
    );

    expect(streamed.held).toBe(true);
    // The row grew; the figure deliberately did not move.
    expect(streamed.window.hydratedBytes).toBe(seeded.hydratedBytes);
    expect(streamed.window.unsettledByteMessageIds).toEqual(["live"]);
  });

  it("settles to the same number an exact charge would have reached", () => {
    const seeded = windowWithColdAndTail();
    const text = "streamed body ".repeat(200);
    const deferred = streamWindowMessage(seeded, "live", (message) =>
      messageWithText(message, text),
    );
    const exact = updateWindowMessage(seeded, "live", (message) =>
      messageWithText(message, text),
    );

    const settled = settleWindowBytes(deferred.window);
    expect(settled.hydratedBytes).toBe(exact.window.hydratedBytes);
    expect(settled.unsettledByteMessageIds).toEqual([]);
  });

  it("does not name the same row twice across a turn's worth of deltas", () => {
    let window = windowWithColdAndTail();
    for (let index = 0; index < 50; index += 1) {
      window = streamWindowMessage(window, "live", (message) =>
        messageWithText(message, `body ${index}`),
      ).window;
    }
    expect(window.unsettledByteMessageIds).toEqual(["live"]);
  });

  it("evicts on the settled figure, not the stale one", () => {
    // The whole design rests on this. Eviction is the ONLY reader of the byte
    // figure, so deferring is sound exactly as long as eviction settles first.
    // A window carrying a turn's worth of deferred growth must not read as
    // under budget and evict nothing.
    const seeded = windowWithColdAndTail();
    const budget = seeded.hydratedBytes + 100;
    const streamed = streamWindowMessage(seeded, "live", (message) =>
      messageWithText(message, "streamed body ".repeat(200)),
    ).window;

    // Under the STALE figure this window fits, so nothing would be dropped.
    expect(streamed.hydratedBytes).toBeLessThan(budget);

    const evicted = evictTranscriptWindowToBudget(streamed, budget, null, []);
    // The tail is exempt, so the cold span is what has to go.
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([29]);
  });

  it("still reports being under budget when the settled figure fits", () => {
    // The other half: settling must not become a reason to evict. A row that
    // grew by a little stays inside a budget that accommodates it.
    const seeded = windowWithColdAndTail();
    const streamed = streamWindowMessage(seeded, "live", (message) =>
      messageWithText(message, "a bit more"),
    ).window;
    const evicted = evictTranscriptWindowToBudget(
      streamed,
      TRANSCRIPT_WINDOW_MAX_BYTES,
      null,
      [],
    );
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([0, 29]);
    // Settled on the way through, so the next read costs nothing.
    expect(evicted.unsettledByteMessageIds).toEqual([]);
  });
});

describe("holdsEveryRecordFrom", () => {
  /**
   * 30 rows: a cold span at the top (0-4) and a live tail (25-29), with a
   * 20-row hole between them. The shape a reader who scrolled back to the
   * start of a long chat is actually in.
   */
  function splitWindow(): TranscriptWindow {
    const seeded = applyWindowedSnapshot(windowWithSkeleton(30), {
      epoch: 1,
      rowCount: 30,
      indexRevision: null,
      tail: {
        fromOrdinal: 25,
        messages: Array.from({ length: 5 }, (_unused, index) =>
          userMessage(`m-${25 + index}`, 25 + index),
        ),
        events: [],
      },
    });
    return applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1", "row-2", "row-3", "row-4"],
        messages: Array.from({ length: 5 }, (_unused, index) =>
          userMessage(`m-${index}`, index),
        ),
      }),
    );
  }

  it("holds everything from a message in the span that reaches the end", () => {
    expect(holdsEveryRecordFrom(splitWindow(), "m-25")).toBe(true);
  });

  it("does NOT hold everything from a message above the hole", () => {
    // The message itself is hydrated - the user can see it and click edit on
    // it - and everything below it is not. This is the case that made both
    // downward scans answer "nothing below" on a transcript full of edits.
    expect(holdsEveryRecordFrom(splitWindow(), "m-2")).toBe(false);
  });

  it("does not hold a message the window has never seen", () => {
    expect(holdsEveryRecordFrom(splitWindow(), "m-12")).toBe(false);
  });

  it("holds everything from a live record once the tail is in", () => {
    // An accepted-but-unplaced record is newer than every placed row, so
    // nothing follows it but other live records.
    const window = appendLiveRecords(splitWindow(), {
      messages: [userMessage("m-live", 30)],
      events: [],
    });
    expect(holdsEveryRecordFrom(window, "m-live")).toBe(true);
  });

  it("does not hold a live record while the tail is still missing", () => {
    // The rows between the last placed row and this record are the gap, and
    // a checkpoint captured in one of them is exactly what a scan would miss.
    const window = appendLiveRecords(windowWithSkeleton(30), {
      messages: [userMessage("m-live", 30)],
      events: [],
    });
    expect(holdsEveryRecordFrom(window, "m-live")).toBe(false);
  });

  it("holds everything from the tail of a fully hydrated transcript", () => {
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 2,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
        events: [],
      },
    });
    expect(holdsEveryRecordFrom(window, "m-0")).toBe(true);
  });
});

/**
 * What a merge, a re-seat and a skeleton chunk do to bodies they already hold.
 *
 * All three are cases where the window holds TWO answers for one row and has
 * to pick. Picking wrong is silent in the same way the rest of this file is
 * about: the transcript renders, it is just not the transcript the host has.
 */
describe("what an overlap keeps", () => {
  it("takes the incoming body where a merge overlaps a held span", () => {
    const stale = applyRangeResponse(windowWithSkeleton(10), {
      ...rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [
          messageWithText(userMessage("row-0", 1), "stale"),
          userMessage("row-1", 2),
        ],
      }),
    });
    // A later response under the same epoch, overlapping ordinal 0 with an
    // updated body - the shape a reconnect's authoritative tail produces.
    const merged = applyRangeResponse(stale, {
      ...rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [
          messageWithText(userMessage("row-0", 1), "fresh"),
          userMessage("row-1", 2),
        ],
      }),
    });
    const held = hydratedRecords(merged).messages.find(
      (message) => message.messageId === "row-0",
    );
    expect(held).toBeDefined();
    expect(JSON.stringify(held)).toContain("fresh");
    // Order is still the ordinal order, not "incoming first".
    expect(hydratedRecords(merged).messages.map((m) => m.messageId)).toEqual([
      "row-0",
      "row-1",
    ]);
  });

  it("drops a retained tail the new snapshot could not serve", () => {
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 3,
      indexRevision: null,
      tail: {
        fromOrdinal: 2,
        messages: [messageWithText(userMessage("row-2", 3), "half-written")],
        events: [],
      },
    });
    expect(seeded.spans).toHaveLength(1);
    // Same epoch, and the last row has since grown past the inline budget - so
    // the host legitimately ships an EMPTY tail. Keeping the old span would
    // leave `isTailHydrated` true and nothing would ever fetch the real body.
    const reconnected = applyWindowedSnapshot(seeded, {
      epoch: 1,
      rowCount: 3,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
    });
    expect(reconnected.spans).toHaveLength(0);
    expect(
      planTranscriptHydration(
        reconnected,
        { fromOrdinal: 0, toOrdinal: 3 },
        [],
      ),
    ).not.toBeNull();
  });

  it("keeps a frozen live assistant across a rebase until its oversized row loads", () => {
    const turnId = "turn-oversized";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [assistantMessage(transientId, turnId, 1)],
      events: [],
    });

    // The completion snapshot arrives before the held subscriber's synchronous
    // reindexed delta. Its only row exceeds the inline-tail budget.
    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });
    expect(hydratedRecords(rebased).messages.map((m) => m.messageId)).toEqual([
      transientId,
    ]);

    const voided = applyIndexChange(rebased, {
      epoch: 1,
      rowCount: 1,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(hydratedRecords(voided).messages.map((m) => m.messageId)).toEqual([
      transientId,
    ]);

    const resnapshot = applyWindowedSnapshot(voided, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });
    expect(
      hydratedRecords(resnapshot).messages.map((m) => m.messageId),
    ).toEqual([transientId]);

    const indexed = applySkeletonChunk(resnapshot, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry(assistantRowId(turnId), 0)],
      isFinal: true,
    });
    const hydrated = applyRangeResponse(
      indexed,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [assistantMessage("assistant-durable", turnId, 1)],
      }),
    );

    // The durable body takes over by turn identity; the stand-in id is
    // intentionally different and must not leave a duplicate tail row.
    expect(hydratedRecords(hydrated).messages.map((m) => m.messageId)).toEqual([
      "assistant-durable",
    ]);
    expect(hydrated.liveMessages).toEqual([]);
  });

  it("keeps a frozen live assistant when a snapshot revision gap voids the index", () => {
    const turnId = "turn-snapshot-gap";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(
      {
        ...emptyTranscriptWindow(),
        epoch: 1,
        indexRevision: 1,
        indexRevisionRebuilding: false,
      },
      {
        messages: [assistantMessage(transientId, turnId, 1)],
        events: [],
      },
    );

    const gapped = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: 3,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });

    expect(gapped.invalidated).toBe(true);
    expect(hydratedRecords(gapped).messages.map((m) => m.messageId)).toEqual([
      transientId,
    ]);
  });

  it("keeps an accepted user when a same-epoch snapshot revision gap voids the index", () => {
    const live = appendLiveRecords(
      {
        ...emptyTranscriptWindow(),
        epoch: 1,
        rowCount: 1,
        indexRevision: 1,
        indexRevisionRebuilding: false,
      },
      { messages: [userMessage("accepted-user-gap", 1)], events: [] },
    );

    const gapped = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 2,
      indexRevision: 3,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(gapped.invalidated).toBe(true);
    expect(gapped.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-user-gap",
    ]);

    const replacement = applyWindowedSnapshot(gapped, {
      epoch: 1,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(
      replacement.liveMessages.map((message) => message.messageId),
    ).toEqual(["accepted-user-gap"]);
  });

  it("keeps an invalidated user when a delayed replacement skeleton omits it", () => {
    const invalidated = {
      ...appendLiveRecords(emptyTranscriptWindow(), {
        messages: [userMessage("accepted-user-removed", 1)],
        events: [],
      }),
      epoch: 1,
      rowCount: 1,
      invalidated: true,
    };
    const replacement = applyWindowedSnapshot(invalidated, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const rebuilt = applySkeletonChunk(replacement, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("different-user", 0)],
      isFinal: true,
    });

    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-user-removed",
    ]);
  });

  it("keeps a retained user through a delayed non-invalidated null rebuild", () => {
    const live = appendLiveRecords(
      {
        ...emptyTranscriptWindow(),
        epoch: 1,
        rowCount: 1,
        indexRevision: 1,
        indexRevisionRebuilding: false,
      },
      { messages: [userMessage("accepted-user-removed", 1)], events: [] },
    );
    const replacement = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const rebuilt = applySkeletonChunk(replacement, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("different-user", 0)],
      isFinal: true,
    });

    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-user-removed",
    ]);
  });

  it("keeps a just-accepted user record through an index void", () => {
    const live = appendLiveRecords(
      {
        ...emptyTranscriptWindow(),
        epoch: 1,
        rowCount: 1,
        indexRevision: 1,
        indexRevisionRebuilding: false,
      },
      { messages: [userMessage("accepted-user", 1)], events: [] },
    );

    const voided = applyIndexChange(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: 2,
      changes: [{ type: "reindexed" }],
    });

    expect(voided.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-user",
    ]);
  });

  it("keeps a provisional user that overtakes a same-epoch empty snapshot", () => {
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage("accepted-user-deleted", 1)],
      events: [],
    });

    const empty = applyWindowedSnapshot(live, {
      epoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });

    expect(empty.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-user-deleted",
    ]);
  });

  it("keeps a provisional user after an established empty skeleton", () => {
    const establishedEmpty = applySkeletonChunk(emptyTranscriptWindow(), {
      epoch: 0,
      fromOrdinal: 0,
      entries: [],
      isFinal: true,
    });
    const live = appendLiveRecords(establishedEmpty, {
      messages: [userMessage("accepted-after-empty", 1)],
      events: [],
    });

    const empty = applyWindowedSnapshot(live, {
      epoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });

    expect(empty.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-after-empty",
    ]);
  });

  it("keeps an accepted user that overtakes a rebasing snapshot", () => {
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage("accepted-after-rebase-snapshot", 2)],
      events: [],
    });

    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(rebased.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-after-rebase-snapshot",
    ]);
  });

  it("keeps a live event that overtakes a rebasing snapshot", () => {
    const setup: ChatEvent = {
      eventId: "setup-after-rebase-snapshot",
      type: "setup.running",
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    };
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [],
      events: [setup],
    });

    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(rebased.liveEvents.map((event) => event.eventId)).toEqual([
      setup.eventId,
    ]);
  });

  it("retires a carried setup event after completed authority omits it", () => {
    const setup: ChatEvent = {
      eventId: "setup-deleted-by-rebuild",
      type: "setup.running",
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    };
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [],
      events: [setup],
    });
    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(confirmed.liveEvents).toEqual([]);
  });

  it("tracks retained events across a same-epoch null-revision rebuild", () => {
    const setup: ChatEvent = {
      eventId: "setup-same-epoch-rebuild",
      type: "setup.running",
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    };
    const live = appendLiveRecords(
      {
        ...emptyTranscriptWindow(),
        epoch: 1,
        rowCount: 1,
        indexRevision: 7,
        indexRevisionRebuilding: false,
      },
      { messages: [], events: [setup] },
    );
    const rebuilding = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(rebuilding.snapshotProvisionalEventIds).toContain(setup.eventId);
    const rebuilt = applySkeletonChunk(rebuilding, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(confirmed.liveEvents).toEqual([]);
  });

  it("tracks a live decorating event using its span-backed assistant", () => {
    const seeded = applyRangeResponse(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId("turn-1")],
        messages: [assistantMessage("assistant-durable", "turn-1", 1)],
      }),
    );
    const completion = event("completion-live", 2);
    const live = appendLiveRecords(seeded, {
      messages: [],
      events: [completion],
    });

    const rebased = applyWindowedSnapshot(live, {
      epoch: 2,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(rebased.snapshotProvisionalEventIds).toContain(completion.eventId);
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [skeletonEntry(assistantRowId("turn-1"), 0)],
      isFinal: true,
    });
    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 2,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(confirmed.liveEvents.map((entry) => entry.eventId)).toContain(
      completion.eventId,
    );
  });

  it("does not retain an independent notification from an assistant turn match", () => {
    const turnId = "turn-with-deleted-notification";
    const seeded = applyRangeResponse(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [assistantMessage("assistant-notification", turnId, 1)],
      }),
    );
    const failed: ChatEvent = {
      ...event("send-failed-deleted", 2),
      type: "send.failed",
      turnId,
      message: "failed",
      metadata: { notificationAnchor: true },
    };
    const live = appendLiveRecords(seeded, {
      messages: [],
      events: [failed],
    });
    const rebased = applyWindowedSnapshot(live, {
      epoch: 2,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(rebased.snapshotProvisionalEventIds).toContain(failed.eventId);
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [skeletonEntry(assistantRowId(turnId), 0)],
      isFinal: true,
    });
    expect(rebuilt.skeletonComplete).toBe(true);

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 2,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(confirmed.liveEvents).toEqual([]);
  });

  it("matches same-timestamp provisional setup windows one-to-one", () => {
    const setupEvent = (
      eventId: string,
      type: ChatEvent["type"],
    ): ChatEvent => ({
      eventId,
      type,
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    });
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [],
      events: [
        setupEvent("setup-first", "setup.running"),
        setupEvent("setup-boundary", "worktree.missing"),
        setupEvent("setup-second", "setup.running"),
      ],
    });
    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("setup-card:chat-1:9:2", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(confirmed.liveEvents.map((event) => event.eventId)).toEqual([
      "setup-boundary",
      "setup-second",
    ]);
  });

  it("keeps an assistant through its overtaken empty stream", () => {
    const turnId = "turn-after-empty-rebase";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [assistantMessage(transientId, turnId, 2)],
      events: [],
    });

    const snapshot = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });
    expect(snapshot.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);

    const rebuilt = applySkeletonChunk(snapshot, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [],
      isFinal: true,
    });
    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("keeps a user accepted after a snapshot through its older skeleton", () => {
    const rebuilding = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 0,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const live = appendLiveRecords(rebuilding, {
      messages: [userMessage("accepted-user-absent", 1)],
      events: [],
    });

    const rebuilt = applySkeletonChunk(live, {
      epoch: 0,
      fromOrdinal: 0,
      entries: [skeletonEntry("different-user", 0)],
      isFinal: true,
    });

    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-user-absent",
    ]);
  });

  it("keeps an assistant completed after a snapshot through its older skeleton", () => {
    const rebuilding = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 0,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const transientId = transientLiveAssistantMessageId("turn-after-snapshot");
    const live = appendLiveRecords(rebuilding, {
      messages: [assistantMessage(transientId, "turn-after-snapshot", 1)],
      events: [],
    });

    const rebuilt = applySkeletonChunk(live, {
      epoch: 0,
      fromOrdinal: 0,
      entries: [skeletonEntry("different-user", 0)],
      isFinal: true,
    });

    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("retires a legacy transient by the projection timestamp turn key", () => {
    const turnKey = "ts:42";
    const transientId = transientLiveAssistantMessageId(turnKey);
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [assistantMessage(transientId, null, 42)],
      events: [],
    });
    const indexed = applySkeletonChunk(
      { ...live, epoch: 1, rowCount: 1 },
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [skeletonEntry(assistantRowId(turnKey), 0)],
        isFinal: true,
      },
    );
    const hydrated = applyRangeResponse(
      indexed,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnKey)],
        messages: [assistantMessage("assistant-legacy-durable", null, 42)],
      }),
    );

    expect(hydrated.liveMessages).toEqual([]);
    expect(hydratedRecords(hydrated).messages.map((m) => m.messageId)).toEqual([
      "assistant-legacy-durable",
    ]);
  });

  it("drops retained live records on the next confirmed-empty snapshot", () => {
    const turnId = "turn-deleted";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [
        assistantMessage(transientLiveAssistantMessageId(turnId), turnId, 1),
        userMessage("accepted-deleted", 1),
      ],
      events: [],
    });

    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });

    const streamed = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [],
      isFinal: true,
    });
    expect(streamed.liveMessages).toHaveLength(2);
    const confirmed = applyWindowedSnapshot(streamed, {
      epoch: 1,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });

    expect(confirmed.liveMessages).toEqual([]);
    expect(hydratedRecords(confirmed).messages).toEqual([]);
  });

  it("retires a provisional user after a completed nonempty rebuild omits it", () => {
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage("accepted-before-rebuild", 1)],
      events: [],
    });
    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(confirmed.liveMessages).toEqual([]);
  });

  it("keeps provisional provenance through an intermediate snapshot", () => {
    const messageId = "accepted-before-intermediate";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage(messageId, 1)],
      events: [],
    });
    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const intermediate = applyWindowedSnapshot(rebased, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(intermediate.snapshotProvisionalMessageIds).toContain(messageId);
    const rebuilt = applySkeletonChunk(intermediate, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(confirmed.liveMessages).toEqual([]);
  });

  it("prunes provisional ids after their live records are span-superseded", () => {
    const messageId = "accepted-before-span-supersession";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage(messageId, 1)],
      events: [],
    });
    const rebuilding = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
    });
    expect(rebuilding.snapshotProvisionalMessageIds).toContain(messageId);
    const superseded = applyRangeResponse(
      rebuilding,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [messageId],
        messages: [userMessage(messageId, 1)],
      }),
    );
    expect(superseded.liveMessages).toEqual([]);

    const intermediate = applyWindowedSnapshot(superseded, {
      epoch: 1,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
    });
    expect(intermediate.skeletonComplete).toBe(false);
    expect(intermediate.snapshotProvisionalMessageIds).toEqual([]);
  });

  it("tracks retained users across a same-epoch null-revision rebuild", () => {
    const messageId = "accepted-before-same-epoch-rebuild";
    const live = appendLiveRecords(
      {
        ...emptyTranscriptWindow(),
        epoch: 1,
        rowCount: 1,
        indexRevision: 7,
        indexRevisionRebuilding: false,
      },
      { messages: [userMessage(messageId, 1)], events: [] },
    );
    const rebuilding = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(rebuilding.snapshotProvisionalMessageIds).toContain(messageId);
    const rebuilt = applySkeletonChunk(rebuilding, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    expect(confirmed.liveMessages).toEqual([]);
  });

  it("retains a provisional user named by the completed rebuild", () => {
    const messageId = "accepted-in-rebuild";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage(messageId, 1)],
      events: [],
    });
    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry(messageId, 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(rebuilt, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(confirmed.liveMessages.map((message) => message.messageId)).toEqual([
      messageId,
    ]);
  });

  it("keeps a frozen assistant across an ambiguous same-epoch empty rebuild", () => {
    const turnId = "turn-restart-deleted";
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 0,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      }),
      {
        epoch: 0,
        fromOrdinal: 0,
        entries: [skeletonEntry(assistantRowId(turnId), 0)],
        isFinal: true,
      },
    );
    const live = appendLiveRecords(indexed, {
      messages: [
        assistantMessage(transientLiveAssistantMessageId(turnId), turnId, 1),
      ],
      events: [],
    });

    const rebuilt = applyWindowedSnapshot(live, {
      epoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });

    expect(rebuilt.skeleton).toEqual([]);
    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      transientLiveAssistantMessageId(turnId),
    ]);
  });

  it("truncates a same-epoch rebuild without retiring its ambiguous stand-in", () => {
    const turnId = "turn-restart-shortened";
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      }),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry("user-kept", 0),
          skeletonEntry(assistantRowId(turnId), 1),
        ],
        isFinal: true,
      },
    );
    const live = appendLiveRecords(indexed, {
      messages: [
        assistantMessage(transientLiveAssistantMessageId(turnId), turnId, 1),
      ],
      events: [],
    });
    const rebuilding = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(rebuilding.skeleton).toHaveLength(1);
    expect(rebuilding.liveMessages).toHaveLength(1);

    const rebuilt = applySkeletonChunk(rebuilding, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("user-kept", 0)],
      isFinal: true,
    });
    expect(rebuilt.skeletonComplete).toBe(true);
    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      transientLiveAssistantMessageId("turn-restart-shortened"),
    ]);
  });

  it("clamps skeleton stream coverage when a concrete snapshot shrinks", () => {
    const held: TranscriptWindow = {
      ...windowWithSkeleton(3),
      indexRevision: 2,
      indexRevisionRebuilding: false,
      skeletonStreamCoveredThrough: 3,
    };

    const shrunk = applyWindowedSnapshot(held, {
      epoch: 1,
      rowCount: 1,
      indexRevision: 2,
      tail: { fromOrdinal: 1, messages: [], events: [] },
    });

    expect(shrunk.skeleton).toHaveLength(1);
    expect(shrunk.skeletonStreamCoveredThrough).toBe(1);
  });

  it("does not retire a completion stand-in because an older span has the turn", () => {
    const turnId = "turn-stale-span";
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      }),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry(assistantRowId(turnId), 0),
          skeletonEntry("user-later", 1),
        ],
        isFinal: true,
      },
    );
    const beforeCompletion = applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [assistantMessage("assistant-streaming-copy", turnId, 1)],
      }),
    );
    const transientId = transientLiveAssistantMessageId(turnId);
    const completed = appendLiveRecords(beforeCompletion, {
      messages: [assistantMessage(transientId, turnId, 2)],
      events: [],
    });

    const unrelatedServe = applyRangeResponse(
      completed,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 1,
        rowIds: ["user-later"],
        messages: [userMessage("user-later-record", 3)],
      }),
    );

    expect(
      unrelatedServe.liveMessages.map((message) => message.messageId),
    ).toEqual([transientId]);
  });

  it("does not retire a completion stand-in when only a steer row is served", () => {
    const turnId = "turn-steer-only";
    const steerRowId = queueSteerRowId("queue-1");
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      }),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry(assistantRowId(turnId), 0),
          skeletonEntry(steerRowId, 1),
        ],
        isFinal: true,
      },
    );
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(indexed, {
      messages: [assistantMessage(transientId, turnId, 2)],
      events: [],
    });

    const steerOnly = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 1,
        rowIds: [steerRowId],
        messages: [assistantMessage("assistant-shared", turnId, 1)],
      }),
    );

    expect(steerOnly.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("retires a stand-in when a complete steer row serves its assistant turn", () => {
    const turnId = "turn-complete-steer";
    const steerRowId = queueSteerRowId("queue-complete");
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      { messages: [assistantMessage(transientId, turnId, 2)], events: [] },
    );
    const durable = {
      ...assistantMessage("assistant-steer-durable", turnId, 3),
      blocks: [
        {
          type: "steer" as const,
          blockId: "steer-block",
          status: "completed" as const,
          timestamp: 3,
          queueItemId: "queue-complete",
          messageId: "missing-steered-user",
          content: CONTENT,
          mode: "safe_point" as const,
          sender: null,
        },
      ],
    };

    const hydrated = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [steerRowId],
        messages: [durable],
      }),
    );

    expect(hydrated.liveMessages).toEqual([]);
  });

  it("does not retire a newer completion stand-in from an older assistant serve", () => {
    const turnId = "turn-delayed-serve";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      {
        messages: [assistantMessage(transientId, turnId, 2)],
        events: [],
      },
    );

    const delayed = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [assistantMessage("assistant-stale", turnId, 1)],
      }),
    );

    expect(delayed.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("does not retire a finalized stand-in from a same-timestamp stale body", () => {
    const turnId = "turn-tied-stale-serve";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      {
        messages: [
          {
            ...assistantMessage(transientId, turnId, 2),
            blocks: [
              {
                type: "text",
                blockId: "block-1",
                status: "completed",
                timestamp: 2,
                text: "done",
                providerNotice: null,
              },
            ],
          },
        ],
        events: [],
      },
    );

    const delayed = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          {
            ...assistantMessage("assistant-stale", turnId, 2),
            blocks: [
              {
                type: "text",
                blockId: "block-1",
                status: "streaming",
                timestamp: 2,
                text: "done",
                providerNotice: null,
              },
            ],
          },
        ],
      }),
    );

    expect(delayed.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("does not retire a completion stand-in when its assistant row has no body", () => {
    const turnId = "turn-row-without-body";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(
      {
        ...emptyTranscriptWindow(),
        epoch: 1,
        rowCount: 1,
      },
      {
        messages: [assistantMessage(transientId, turnId, 2)],
        events: [],
      },
    );

    const bodyless = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [],
      }),
    );

    expect(bodyless.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("does not retire a completion stand-in from a partial turn response", () => {
    const turnId = "turn-partial-body";
    const firstBlock = {
      type: "text" as const,
      blockId: "block-1",
      status: "completed" as const,
      timestamp: 1,
      text: "first",
      providerNotice: null,
    };
    const secondBlock = { ...firstBlock, blockId: "block-2", text: "second" };
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = applySkeletonChunk(
      appendLiveRecords(
        { ...emptyTranscriptWindow(), epoch: 1, rowCount: 3 },
        {
          messages: [
            {
              ...assistantMessage(transientId, turnId, 2),
              blocks: [firstBlock, secondBlock],
            },
          ],
          events: [],
        },
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry("user-before", 0),
          skeletonEntry(assistantRowId(turnId), 1),
          skeletonEntry("user-after", 2),
        ],
        isFinal: true,
      },
    );

    const partial = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["user-before", assistantRowId(turnId), "user-after"],
        incompleteRowIds: [assistantRowId(turnId)],
        messages: [
          userMessage("user-before", 0),
          {
            ...assistantMessage("assistant-first", turnId, 1),
            blocks: [firstBlock],
          },
          userMessage("user-after", 3),
        ],
      }),
    );

    expect(partial.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
    expect(partial.spans.map((span) => span.rowIds)).toEqual([
      ["user-before"],
      ["user-after"],
    ]);
    expect(
      partial.spans.map((span) =>
        span.messages.map((message) => message.messageId),
      ),
    ).toEqual([["user-before"], ["user-after"]]);
    expect(partial.hydratedBytes).toBe(
      recordByteLength(userMessage("user-before", 0)) +
        recordByteLength(userMessage("user-after", 3)),
    );
    expect(
      hydratedRecords(partial).messages.map((message) => message.messageId),
    ).toEqual(["user-before", "user-after", transientId]);
  });

  it("seats complete tail siblings around an incomplete live assistant", () => {
    const turnId = "turn-partial-tail";
    const transientId = transientLiveAssistantMessageId(turnId);
    const indexed = applySkeletonChunk(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 3 },
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry("user-before", 0),
          skeletonEntry(assistantRowId(turnId), 1),
          skeletonEntry("user-after", 2),
        ],
        isFinal: true,
      },
    );
    const oldTail = applyRangeResponse(
      indexed,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["user-before", assistantRowId(turnId), "user-after"],
        messages: [
          userMessage("user-before", 0),
          assistantMessage("assistant-stale", turnId, 1),
          userMessage("user-after", 3),
        ],
      }),
    );
    const live = appendLiveRecords(oldTail, {
      messages: [assistantMessage(transientId, turnId, 2)],
      events: [],
    });

    const snapshot = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 3,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        rowIds: ["user-before", assistantRowId(turnId), "user-after"],
        incompleteRowIds: [assistantRowId(turnId)],
        messages: [
          userMessage("user-before", 0),
          assistantMessage("assistant-partial", turnId, 1),
          userMessage("user-after", 3),
        ],
        events: [],
      },
    });

    expect(snapshot.spans.map((span) => span.rowIds)).toEqual([
      ["user-before"],
      ["user-after"],
    ]);
    expect(
      snapshot.spans.map((span) =>
        span.messages.map((message) => message.messageId),
      ),
    ).toEqual([["user-before"], ["user-after"]]);
    expect(
      hydratedRecords(snapshot).messages.map((message) => message.messageId),
    ).toEqual(["user-before", "user-after", transientId]);
  });

  it("retains a globally indexed setup card when a partial assistant splits the range", () => {
    const turnId = "turn-after-setup";
    const transientId = transientLiveAssistantMessageId(turnId);
    const setupRowId = "setup-card:chat-1:1:100";
    const setup: ChatEvent = {
      eventId: "setup-second-window",
      type: "setup.running",
      timestamp: 100,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    };
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 2 },
      {
        messages: [assistantMessage(transientId, turnId, 2)],
        events: [],
      },
    );

    const partial = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [setupRowId, assistantRowId(turnId)],
        incompleteRowIds: [assistantRowId(turnId)],
        messages: [assistantMessage("assistant-partial", turnId, 1)],
        events: [setup],
      }),
    );

    expect(partial.spans.map((held) => held.rowIds)).toEqual([[setupRowId]]);
    expect(partial.spans[0].events.map((event) => event.eventId)).toEqual([
      setup.eventId,
    ]);
  });

  it("does not assign same-timestamp setup windows to each other's rows", () => {
    const turnId = "turn-between-setup-windows";
    const transientId = transientLiveAssistantMessageId(turnId);
    const setupEvent = (
      eventId: string,
      type: ChatEvent["type"],
    ): ChatEvent => ({
      eventId,
      type,
      timestamp: 100,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    });
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 3 },
      {
        messages: [assistantMessage(transientId, turnId, 2)],
        events: [],
      },
    );

    const partial = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [
          "setup-card:chat-1:1:100",
          assistantRowId(turnId),
          "setup-card:chat-1:2:100",
        ],
        incompleteRowIds: [assistantRowId(turnId)],
        messages: [assistantMessage("assistant-partial", turnId, 1)],
        events: [
          setupEvent("setup-first", "setup.running"),
          setupEvent("setup-boundary", "worktree.missing"),
          setupEvent("setup-second", "setup.running"),
        ],
      }),
    );

    expect(
      partial.spans.map((span) => span.events.map((event) => event.eventId)),
    ).toEqual([["setup-first"], ["setup-second"]]);
  });

  it("counts a withheld setup row before seating a later range setup", () => {
    const setupEvent = (
      eventId: string,
      type: ChatEvent["type"],
      timestamp: number,
    ): ChatEvent => ({
      eventId,
      type,
      timestamp,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    });
    const partial = applyRangeResponse(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 2 },
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["setup-card:chat-1:1:100", "setup-card:chat-1:2:200"],
        incompleteRowIds: ["setup-card:chat-1:1:100"],
        messages: [],
        events: [
          setupEvent("setup-first", "setup.running", 100),
          setupEvent("setup-boundary", "worktree.missing", 150),
          setupEvent("setup-second", "setup.running", 200),
        ],
      }),
    );

    expect(partial.spans.map((span) => span.rowIds)).toEqual([
      ["setup-card:chat-1:2:200"],
    ]);
    expect(partial.spans[0].events.map((event) => event.eventId)).toEqual([
      "setup-second",
    ]);
  });

  it("counts a withheld setup row before seating a later inline-tail setup", () => {
    const setupEvent = (
      eventId: string,
      type: ChatEvent["type"],
      timestamp: number,
    ): ChatEvent => ({
      eventId,
      type,
      timestamp,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    });
    const partial = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 2,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        rowIds: ["setup-card:chat-1:1:100", "setup-card:chat-1:2:200"],
        incompleteRowIds: ["setup-card:chat-1:1:100"],
        messages: [],
        events: [
          setupEvent("setup-first", "setup.running", 100),
          setupEvent("setup-boundary", "worktree.missing", 150),
          setupEvent("setup-second", "setup.running", 200),
        ],
      },
    });

    expect(partial.spans.map((span) => span.rowIds)).toEqual([
      ["setup-card:chat-1:2:200"],
    ]);
    expect(partial.spans[0].events.map((event) => event.eventId)).toEqual([
      "setup-second",
    ]);
  });

  it("withholds an incomplete steer row that shares the live assistant turn", () => {
    const turnId = "turn-partial-steer";
    const transientId = transientLiveAssistantMessageId(turnId);
    const steerBlock = {
      blockId: "steer-block",
      status: "completed" as const,
      timestamp: 1,
      type: "steer" as const,
      queueItemId: "queue-partial",
      messageId: "missing-user",
      content: { type: "doc" as const },
      mode: "safe_point" as const,
      sender: null,
    };
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      {
        messages: [
          {
            ...assistantMessage(transientId, turnId, 2),
            blocks: [steerBlock],
          },
        ],
        events: [],
      },
    );

    const partial = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["steer:queue-partial"],
        incompleteRowIds: ["steer:queue-partial"],
        messages: [
          {
            ...assistantMessage("assistant-partial", turnId, 1),
            blocks: [],
          },
        ],
      }),
    );

    expect(partial.spans).toEqual([]);
    expect(partial.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("withholds every declared incomplete row without a live assistant", () => {
    const partial = applyRangeResponse(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["user-incomplete"],
        incompleteRowIds: ["user-incomplete"],
        messages: [userMessage("user-incomplete", 1)],
      }),
    );

    expect(partial.spans).toEqual([]);
  });

  it("does not retry an incomplete row until the index changes", () => {
    const partial = applyRangeResponse(
      windowWithSkeleton(1),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        incompleteRowIds: ["row-0"],
        messages: [userMessage("row-0", 1)],
      }),
    );

    expect(partial.unavailableRowIds).toEqual(["row-0"]);
    expect(
      planTranscriptHydration(partial, { fromOrdinal: 0, toOrdinal: 1 }, []),
    ).toBeNull();

    const updated = applyIndexChange(partial, {
      epoch: 1,
      rowCount: 1,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0", 0) }],
        },
      ],
    });
    expect(updated.unavailableRowIds).toEqual([]);
    expect(
      planTranscriptHydration(updated, { fromOrdinal: 0, toOrdinal: 1 }, []),
    ).toEqual({ fromOrdinal: 0, toOrdinal: 1 });
  });

  it("re-arms a pre-skeleton unavailable ordinal when the skeleton names a new row", () => {
    const partial = applyRangeResponse(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["stale-before-skeleton"],
        incompleteRowIds: ["stale-before-skeleton"],
        messages: [userMessage("stale-before-skeleton", 1)],
      }),
    );
    const indexed = applySkeletonChunk(partial, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-row", 0)],
      isFinal: true,
    });

    expect(indexed.unavailableRowIds).toEqual([]);
    expect(indexed.unavailableRowOrdinals).toEqual([]);
    expect(
      planTranscriptHydration(indexed, { fromOrdinal: 0, toOrdinal: 1 }, []),
    ).toEqual({ fromOrdinal: 0, toOrdinal: 1 });
  });

  it("retires a stand-in when a complete authoritative row rewrites block status", () => {
    const turnId = "turn-authoritative-status";
    const transientId = transientLiveAssistantMessageId(turnId);
    const block = {
      type: "text" as const,
      blockId: "block-1",
      status: "errored" as const,
      timestamp: 1,
      text: "done",
      providerNotice: null,
    };
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      {
        messages: [
          { ...assistantMessage(transientId, turnId, 2), blocks: [block] },
        ],
        events: [],
      },
    );

    const hydrated = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          {
            ...assistantMessage("assistant-durable", turnId, 3),
            blocks: [{ ...block, status: "completed" }],
          },
        ],
      }),
    );

    expect(hydrated.liveMessages).toEqual([]);
  });

  it("retires structurally equal stand-ins despite nested key insertion order", () => {
    const turnId = "turn-structural-body";
    const transientId = transientLiveAssistantMessageId(turnId);
    const transient = {
      ...assistantMessage(transientId, turnId, 2),
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        contextWindow: 4,
      },
    };
    const durable = {
      ...assistantMessage("assistant-structural-body", turnId, 2),
      usage: {
        contextWindow: 4,
        totalTokens: 3,
        outputTokens: 2,
        inputTokens: 1,
      },
    };
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      { messages: [transient], events: [] },
    );

    const hydrated = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [durable],
      }),
    );

    expect(hydrated.liveMessages).toEqual([]);
  });

  it("folds complete assistant records before comparing a stand-in", () => {
    const turnId = "turn-multi-record";
    const transientId = transientLiveAssistantMessageId(turnId);
    const firstBlock = {
      type: "text" as const,
      blockId: "block-1",
      status: "completed" as const,
      timestamp: 1,
      text: "first",
      providerNotice: null,
    };
    const secondBlock = { ...firstBlock, blockId: "block-2", text: "second" };
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      {
        messages: [
          {
            ...assistantMessage(transientId, turnId, 2),
            blocks: [firstBlock, secondBlock],
          },
        ],
        events: [],
      },
    );

    const hydrated = applyRangeResponse(
      live,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          {
            ...assistantMessage("assistant-part-1", turnId, 2),
            blocks: [firstBlock],
          },
          {
            ...assistantMessage("assistant-part-2", turnId, 2),
            blocks: [secondBlock],
          },
        ],
      }),
    );

    expect(hydrated.liveMessages).toEqual([]);
  });

  it("retains legacy range retirement when completeness metadata is absent", () => {
    const turnId = "turn-legacy-range";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(
      { ...emptyTranscriptWindow(), epoch: 1, rowCount: 1 },
      {
        messages: [assistantMessage(transientId, turnId, 2)],
        events: [],
      },
    );
    const { incompleteRowIds: _omitted, ...legacyResponse } = rangeResponse({
      epoch: 1,
      fromOrdinal: 0,
      rowIds: [assistantRowId(turnId)],
      messages: [assistantMessage("assistant-durable", turnId, 2)],
    });

    const hydrated = applyRangeResponse(live, legacyResponse);

    expect(hydrated.liveMessages).toEqual([]);
  });

  it("does not retire a stand-in from legacy positional tail identities", () => {
    const turnId = "turn-legacy-tail";
    const transientId = transientLiveAssistantMessageId(turnId);
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      }),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [skeletonEntry(assistantRowId(turnId), 0)],
        isFinal: true,
      },
    );
    const live = appendLiveRecords(indexed, {
      messages: [assistantMessage(transientId, turnId, 2)],
      events: [],
    });

    const replacement = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        messages: [assistantMessage("shared-steer-record", turnId, 1)],
        events: [],
      },
    });

    expect(
      replacement.liveMessages.map((message) => message.messageId),
    ).toEqual([transientId]);
  });

  it("retires a legacy positional-tail stand-in after skeleton identity adoption", () => {
    const turnId = "turn-legacy-tail-adopted";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [assistantMessage(transientId, turnId, 2)],
      events: [],
    });
    const replacement = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        messages: [assistantMessage("assistant-durable", turnId, 2)],
        events: [],
      },
    });
    expect(replacement.liveMessages).toHaveLength(1);

    const identified = applySkeletonChunk(replacement, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry(assistantRowId(turnId), 0)],
      isFinal: true,
    });

    expect(identified.liveMessages).toEqual([]);
  });

  it("does not reconcile stand-ins against a completed void skeleton", () => {
    const turnId = "turn-void-skeleton";
    const transientId = transientLiveAssistantMessageId(turnId);
    const live: TranscriptWindow = {
      ...appendLiveRecords(emptyTranscriptWindow(), {
        messages: [assistantMessage(transientId, turnId, 1)],
        events: [],
      }),
      epoch: 1,
      rowCount: 1,
      invalidated: true,
    };

    const completed = applySkeletonChunk(live, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("different-user", 0)],
      isFinal: true,
    });

    expect(completed.invalidated).toBe(true);
    expect(completed.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
  });

  it("keeps a newer frozen assistant when a delayed rebasing skeleton omits its turn", () => {
    const turnId = "turn-rewritten-away";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [
        assistantMessage(transientLiveAssistantMessageId(turnId), turnId, 1),
      ],
      events: [],
    });
    const rebased = applyWindowedSnapshot(live, {
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
    });
    expect(rebased.liveMessages).toHaveLength(1);

    const indexed = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user-row", 0)],
      isFinal: true,
    });

    expect(indexed.skeletonComplete).toBe(true);
    expect(indexed.liveMessages).toHaveLength(1);
    expect(hydratedRecords(indexed).messages).toHaveLength(1);
  });

  it("leaves a transcript with no tail rows alone", () => {
    // The other `null` from the same helper, which must NOT drop anything:
    // `fromOrdinal === rowCount` is "there is no tail", not "the tail was
    // withheld". Without this the positive control above passes for the wrong
    // reason and every aux re-broadcast would wipe the scrollback.
    const seeded = applyRangeResponse(windowWithSkeleton(3), {
      ...rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("row-0", 1)],
      }),
    });
    expect(seeded.spans).toHaveLength(1);
    const rebroadcast = applyWindowedSnapshot(seeded, {
      epoch: 1,
      rowCount: 3,
      indexRevision: null,
      tail: { fromOrdinal: 3, messages: [], events: [] },
    });
    expect(rebroadcast.spans).toHaveLength(1);
  });

  it("fills the inline tail's empty ids from the skeleton that names them", () => {
    // The snapshot precedes the skeleton, so the tail is always seated with no
    // ids to carry. Until the chunk backfills them the row merge cannot match
    // these ordinals to their models at all.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 3,
      indexRevision: null,
      tail: {
        fromOrdinal: 2,
        messages: [userMessage("row-2", 3)],
        events: [],
      },
    });
    expect(seeded.spans[0].rowIds).toEqual([""]);
    const described = applySkeletonChunk(seeded, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 3),
      isFinal: true,
    });
    expect(described.spans[0].rowIds).toEqual(["row-2"]);
    // And the span survives - adopting is not the same as contradicting.
    expect(hydratedRecords(described).messages.map((m) => m.messageId)).toEqual(
      ["row-2"],
    );
  });

  it("fills them from an appended delta when no chunk will reach them again", () => {
    // The other authority, and the only one for a row appended AFTER the
    // skeleton stream finished: a chunk backfilled the tail above, but nothing
    // re-streams for a row the delta itself introduces. Left unadopted the span
    // keeps `""` at that ordinal, `transcriptListRows` finds no model with that
    // id and suppresses the ordinal, and then drops the real model as one the
    // skeleton has already placed - so the row renders nowhere at all.
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 1,
      indexRevision: 0,
      tail: {
        fromOrdinal: 0,
        messages: [userMessage("row-0", 1)],
        events: [],
      },
    });
    expect(seeded.spans[0].rowIds).toEqual([""]);

    const described = applyIndexChange(seeded, {
      epoch: 1,
      rowCount: 1,
      indexRevision: 1,
      changes: [{ type: "appended", entries: [skeletonEntry("row-0", 0)] }],
    });

    expect(described.spans[0].rowIds).toEqual(["row-0"]);
    expect(hydratedRecords(described).messages.map((m) => m.messageId)).toEqual(
      ["row-0"],
    );
  });

  it("still drops a tail whose id the skeleton contradicts", () => {
    const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 3,
      indexRevision: null,
      tail: {
        fromOrdinal: 2,
        messages: [userMessage("row-2", 3)],
        events: [],
      },
    });
    const contradicted = applyRangeResponse(seeded, {
      ...rangeResponse({
        epoch: 1,
        fromOrdinal: 2,
        rowIds: ["someone-else"],
        messages: [userMessage("someone-else", 3)],
      }),
    });
    const described = applySkeletonChunk(contradicted, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 3),
      isFinal: true,
    });
    expect(described.spans).toHaveLength(0);
  });
});

describe("one record across several spans", () => {
  /**
   * A steered turn is MANY rows over ONE record set, and `SPAN_MERGE_MAX_BYTES`
   * stops touching spans from always merging - so one turn's slices can sit in
   * several spans, each holding its own copy of the turn's records.
   *
   * Two questions fall out of that, and they are answered in different places.
   * Which COPY renders is `servedAt`'s job, here in the window. Whether a span
   * survives is geometry's job, and must not depend on the records, because
   * record-sharing is SYMMETRIC and a rule that drops the sharer makes two
   * slices of one turn evict each other forever.
   */
  function spanCarrying(
    window: TranscriptWindow,
    input: {
      readonly fromOrdinal: number;
      readonly rowIds: readonly string[];
      readonly messages: readonly Message[];
    },
  ): TranscriptWindow {
    return applyRangeResponse(window, rangeResponse({ epoch: 1, ...input }));
  }

  /** Both slices of one turn, held as disjoint spans with a gap between them. */
  function splitTurn(
    window: TranscriptWindow,
    order: "earlier-first" | "later-first",
  ): TranscriptWindow {
    const earlier = {
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [messageWithText(userMessage("shared", 1), "old")],
    };
    const later = {
      fromOrdinal: 4,
      rowIds: ["row-4", "row-5"],
      messages: [messageWithText(userMessage("shared", 1), "new")],
    };
    return order === "earlier-first"
      ? spanCarrying(spanCarrying(window, earlier), later)
      : spanCarrying(spanCarrying(window, later), earlier);
  }

  it.each(["earlier-first", "later-first"] as const)(
    "keeps both slices of a split turn when they arrive %s",
    (order) => {
      // Ordinals 2-3 are a gap, so these never touch - which is exactly the
      // shape a turn straddling an evicted slice produces. Dropping the sharer
      // is unbounded here rather than merely lossy: the drop is symmetric, so
      // whichever slice is re-fetched evicts the other, and a reader looking at
      // the whole turn drives that forever.
      const window = splitTurn(windowWithSkeleton(10), order);
      expect(window.spans.map((span) => span.fromOrdinal)).toEqual([0, 4]);
      // Neither slice is a gap, so nothing re-requests either one.
      expect(
        transcriptHydrationGaps(window, { fromOrdinal: 0, toOrdinal: 2 }),
      ).toEqual([]);
      expect(
        transcriptHydrationGaps(window, { fromOrdinal: 4, toOrdinal: 6 }),
      ).toEqual([]);
    },
  );

  it.each(["earlier-first", "later-first"] as const)(
    "renders the newest SERVE of a shared record, not the earliest span's, when they arrive %s",
    (order) => {
      // The question the dropped-sharer rule was really answering. Position
      // decides where the record renders; freshness decides what it says, so
      // the answer does not depend on which slice happens to sit lower.
      const records = hydratedRecords(splitTurn(windowWithSkeleton(10), order));
      expect(records.messages).toHaveLength(1);
      const rendered = JSON.stringify(records.messages[0]);
      expect(rendered).toContain(order === "earlier-first" ? "new" : "old");
    },
  );

  it("keeps an unmerged span that shares no record with the incoming one", () => {
    const held = spanCarrying(windowWithSkeleton(10), {
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 1)],
    });
    const added = spanCarrying(held, {
      fromOrdinal: 4,
      rowIds: ["row-4", "row-5"],
      messages: [userMessage("m-4", 5)],
    });
    expect(added.spans).toHaveLength(2);
  });

  it("drops every COPY of a rewritten row's records, not only its own span", () => {
    // The reader is parked on an EARLIER slice of one turn while a later slice
    // is rewritten. Geometry alone leaves this span holding a stale copy of the
    // very record that changed - and once the containing span goes it is the
    // ONLY copy, rendered under rows the planner sees as covered. So the
    // invalidation follows the records rather than the ordinal.
    const later = splitTurn(windowWithSkeleton(10), "earlier-first");
    expect(later.spans).toHaveLength(2);
    const rewritten = applyIndexChange(later, {
      epoch: 1,
      rowCount: 10,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 4, entry: skeletonEntry("row-4", 4) }],
        },
      ],
    });
    expect(rewritten.spans).toHaveLength(0);
    expect(hydratedRecords(rewritten).messages).toHaveLength(0);
    // And the rows are gaps again, so the planner re-requests them - which is
    // what makes dropping the far span a repair rather than a silent deletion.
    expect(
      transcriptHydrationGaps(rewritten, { fromOrdinal: 0, toOrdinal: 2 }),
    ).toEqual([{ fromOrdinal: 0, toOrdinal: 2 }]);
  });

  it("leaves an unrelated span alone when a row is rewritten", () => {
    // The other half of the same rule: following the records must not become
    // "drop everything". A span holding none of the stale turn's records is
    // untouched.
    const held = spanCarrying(windowWithSkeleton(10), {
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 1)],
    });
    const other = spanCarrying(held, {
      fromOrdinal: 4,
      rowIds: ["row-4", "row-5"],
      messages: [userMessage("m-4", 5)],
    });
    const rewritten = applyIndexChange(other, {
      epoch: 1,
      rowCount: 10,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 4, entry: skeletonEntry("row-4", 4) }],
        },
      ],
    });
    expect(rewritten.spans.map((span) => span.fromOrdinal)).toEqual([0]);
  });

  /**
   * One turn's rows across ordinals 4-6, with only the FIRST slice hydrated.
   *
   * `assistant:t-1:part:0` (4), its steer bubble `steer:q-1` (5), and
   * `assistant:t-1:part:1` (6). Ordinals 0-3 and 7-9 are ordinary user rows, so
   * the turn has a real boundary on both sides.
   */
  function turnWithOnlyTheFirstSliceHydrated(): TranscriptWindow {
    const entries = skeletonEntries(0, 10);
    entries[4] = skeletonEntry("assistant:t-1:part:0", 4);
    entries[5] = skeletonEntry("steer:q-1", 5);
    entries[6] = skeletonEntry("assistant:t-1:part:1", 6);
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      }),
      { epoch: 1, fromOrdinal: 0, entries, isFinal: true },
    );
    // The range that served slice 0 carried the TURN's shared record, which is
    // the same record slice 1 renders from.
    return spanCarrying(seeded, {
      fromOrdinal: 4,
      rowIds: ["assistant:t-1:part:0"],
      messages: [messageWithText(userMessage("shared", 5), "old")],
    });
  }

  it("drops a sibling slice's copy when the rewritten row is NOT hydrated", () => {
    // The case the containing-span seed cannot see. Nothing holds ordinal 6, so
    // there is no span to collect stale record ids FROM - and the span at
    // ordinal 4 holds the very record the host just rewrote. Left behind it is
    // the only copy, under a row the planner sees as covered.
    const window = turnWithOnlyTheFirstSliceHydrated();
    expect(window.spans).toHaveLength(1);

    const rewritten = applyIndexChange(window, {
      epoch: 1,
      rowCount: 10,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [
            { ordinal: 6, entry: skeletonEntry("assistant:t-1:part:1", 6) },
          ],
        },
      ],
    });

    expect(rewritten.spans).toHaveLength(0);
    // A gap is the whole point: the drop is a repair only if something re-asks.
    expect(
      transcriptHydrationGaps(rewritten, { fromOrdinal: 4, toOrdinal: 5 }),
    ).toEqual([{ fromOrdinal: 4, toOrdinal: 5 }]);
  });

  it("stops at the turn boundary rather than invalidating the transcript", () => {
    // The other half, and the one that would make this rule too expensive to
    // keep: widening must not walk past the user rows that bound the turn, or
    // every streaming `updated` would drop every span in the chat.
    const window = spanCarrying(turnWithOnlyTheFirstSliceHydrated(), {
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 1)],
    });

    const rewritten = applyIndexChange(window, {
      epoch: 1,
      rowCount: 10,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [
            { ordinal: 6, entry: skeletonEntry("assistant:t-1:part:1", 6) },
          ],
        },
      ],
    });

    expect(rewritten.spans.map((span) => span.fromOrdinal)).toEqual([0]);
  });

  it("widens nothing for a rewritten USER row, which shares no turn", () => {
    // `rowRecordIds` gives a user row its own message and nothing else, so the
    // conservative widening must not fire here - it would cost a discard and a
    // refetch on the most common `updated` there is.
    const window = spanCarrying(windowWithSkeleton(10), {
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 1)],
    });

    const rewritten = applyIndexChange(window, {
      epoch: 1,
      rowCount: 10,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 5, entry: skeletonEntry("row-5", 5) }],
        },
      ],
    });

    expect(rewritten.spans.map((span) => span.fromOrdinal)).toEqual([0]);
  });
});

describe("the inline tail's row context", () => {
  it("seats the row ids and context the tail names", () => {
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 5,
      indexRevision: null,
      tail: {
        fromOrdinal: 3,
        rowIds: ["row-3", "row-4"],
        messages: [userMessage("row-3", 3), userMessage("row-4", 4)],
        events: [],
        rowContext: { "row-3": { legacyRowAnchorAt: 1234 } },
      },
    });
    expect(window.spans[0]?.rowIds).toEqual(["row-3", "row-4"]);
    expect(hydratedRecords(window).rowContext).toEqual({
      "row-3": { legacyRowAnchorAt: 1234 },
    });
  });

  it("falls back to the positional read when the tail names no rows", () => {
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 5,
      indexRevision: null,
      tail: {
        fromOrdinal: 3,
        messages: [userMessage("row-3", 3), userMessage("row-4", 4)],
        events: [],
      },
    });
    // Unverified ids: the snapshot precedes the skeleton, so there is nothing
    // to fill them from yet.
    expect(window.spans[0]?.rowIds).toEqual(["", ""]);
    expect(hydratedRecords(window).rowContext).toEqual({});
  });

  it("treats a tail that named NO rows as no tail to seat", () => {
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 5,
      indexRevision: null,
      tail: {
        fromOrdinal: 3,
        rowIds: [],
        messages: [userMessage("row-3", 3)],
        events: [],
      },
    });
    expect(window.spans).toHaveLength(0);
  });
});

describe("what a span charges the byte budget", () => {
  const CONTEXT = {
    "row-0": { legacyRowAnchorAt: 1234 },
    "row-1": { legacyRowAnchorAt: 5678 },
  };

  function hydrated(rowContext: ChatRangeResponse["rowContext"]) {
    return applyRangeResponse(windowWithSkeleton(10), {
      ...rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
      rowContext,
    });
  }

  it("charges the row context it retains, not only the records", () => {
    const bare = hydrated({});
    const withContext = hydrated(CONTEXT);

    // Same rows, same records: the entire difference is context the span holds
    // for exactly as long as it holds them, since eviction takes a span whole.
    expect(withContext.hydratedBytes).toBeGreaterThan(bare.hydratedBytes);
    expect(withContext.spans[0].contextBytes).toBeGreaterThan(0);
    // Sparse by construction, so the common span pays nothing for the empty
    // map rather than a constant that describes none of what it holds.
    expect(bare.spans[0].contextBytes).toBe(0);
  });

  it("keeps the context charge when a streaming row settles", () => {
    // `settleWindowBytes` re-measures the RECORDS of a span holding an
    // unsettled row. Re-deriving the whole charge from records there would
    // un-charge the context one turn after it was charged - the same defect as
    // never charging it, reached by a different door.
    //
    // Asserted as the GAP between two otherwise identical windows, because the
    // tempting single-window forms are vacuous: `bytes` still exceeds
    // `bytes - contextBytes` when the context was never added, and the
    // `contextBytes` field itself survives any re-measure that spreads a span.
    const grow = (message: Message): Message =>
      messageWithText(message, "streamed body ".repeat(50));
    const withContext = settleWindowBytes(
      streamWindowMessage(hydrated(CONTEXT), "m-0", grow).window,
    );
    const bare = settleWindowBytes(
      streamWindowMessage(hydrated({}), "m-0", grow).window,
    );

    expect(withContext.spans[0].contextBytes).toBeGreaterThan(0);
    expect(withContext.hydratedBytes - bare.hydratedBytes).toBe(
      withContext.spans[0].contextBytes,
    );
  });

  it("keeps the context charge when records are remapped", () => {
    const rewrite = (message: Message): Message =>
      messageWithText(message, "a rewritten body");
    const withContext = mapWindowMessages(hydrated(CONTEXT), rewrite);
    const bare = mapWindowMessages(hydrated({}), rewrite);

    // Same gap, same reason: a remap rewrites records and leaves the context
    // map untouched, so the difference after it must still be exactly the
    // context - not merely "more than zero".
    expect(withContext.spans[0].contextBytes).toBeGreaterThan(0);
    expect(withContext.hydratedBytes - bare.hydratedBytes).toBe(
      withContext.spans[0].contextBytes,
    );
  });

  it("measures a merged span's context once rather than summing its members", () => {
    // The merge DEDUPES the context map exactly as it dedupes records, so a
    // charge summed from the members would bill a re-served row twice and
    // leave the window reporting bytes it does not hold.
    const first = hydrated(CONTEXT);
    const reserved = applyRangeResponse(first, {
      ...rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
      rowContext: CONTEXT,
    });

    expect(reserved.spans).toHaveLength(1);
    expect(reserved.spans[0].contextBytes).toBe(first.spans[0].contextBytes);
    // And the merged span's own charge still INCLUDES that context. Re-serving
    // the identical rows must leave the figure exactly where it was: lower
    // means the merge dropped the context, higher means it billed it twice.
    expect(reserved.spans[0].bytes).toBe(first.spans[0].bytes);
    expect(reserved.spans[0].bytes).toBeGreaterThan(
      reserved.spans[0].contextBytes,
    );
  });

  it("charges the context that rides the snapshot tail", () => {
    const bare = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 2,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
        events: [],
      },
    });
    const withContext = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 2,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
        events: [],
        rowContext: CONTEXT,
      },
    });

    // The tail is the OTHER way a span is built, and it carries context for
    // the same rows a range would.
    expect(withContext.hydratedBytes).toBeGreaterThan(bare.hydratedBytes);
  });

  it("evicts a span whose context is what put the window over budget", () => {
    // The point of charging it. A window whose records fit and whose retained
    // context does not must still evict, or the bound is a number that agrees
    // with itself and not with memory.
    const seeded = hydrated(CONTEXT);
    const bare = hydrated({});
    const budget = bare.hydratedBytes;

    expect(seeded.hydratedBytes).toBeGreaterThan(budget);

    // Nothing visible and nothing required, so the only thing standing between
    // this span and eviction is whether the budget can see what it holds.
    const evicted = evictTranscriptWindowToBudget(seeded, budget, null, []);

    expect(evicted.spans).toHaveLength(0);
  });
});

function messageWithText(message: Message, text: string): Message {
  if (message.role !== "user") return message;
  return {
    ...message,
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [],
    },
  };
}
