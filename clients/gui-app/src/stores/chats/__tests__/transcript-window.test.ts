import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatEvent,
  ImageResolutionEntry,
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
import { createImageWitnessStore } from "@/stores/chats/image-witness-store";
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
  isActiveTurnStreamingEcho,
  mapWindowMessages,
  planTranscriptHydration,
  settleWindowBytes,
  spanChargeBytes,
  spanMessages,
  spanServeStamp,
  spanTouchStamp,
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
  const seeded = applyWindowedSnapshot(
    emptyTranscriptWindow(),
    {
      epoch: 1,
      rowCount,
      indexRevision: null,
      tail: { fromOrdinal: rowCount, messages: [], events: [] },
    },
    null,
    null,
  );
  return applySkeletonChunk(seeded, {
    epoch: 1,
    fromOrdinal: 0,
    entries: skeletonEntries(0, rowCount),
    isFinal: true,
  });
}

describe("windowed snapshot seating", () => {
  it("seats the inline tail as a hydrated span", () => {
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 5,
        indexRevision: null,
        tail: {
          fromOrdinal: 3,
          messages: [userMessage("m-3", 3), userMessage("m-4", 4)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(window.rowCount).toBe(5);
    expect(window.spans).toHaveLength(1);
    expect(window.spans[0]?.fromOrdinal).toBe(3);
    expect(window.hydratedBytes).toBeGreaterThan(0);
  });

  it("keeps the scrollback a reader is looking at when the epoch is unchanged", () => {
    // An aux-only re-broadcast (a queue change, an approval) re-sends the
    // snapshot. Dropping hydrated history on one of those would make ordinary
    // chat activity evict the rows on screen.
    const seeded = applyRangeResponse(
      windowWithSkeleton(10),
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0)],
        }),
      },
      null,
      null,
    );
    expect(seeded.spans).toHaveLength(1);

    const refreshed = applyWindowedSnapshot(
      seeded,
      {
        epoch: 1,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 9, messages: [userMessage("m-9", 9)], events: [] },
      },
      null,
      null,
    );
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
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 4,
        indexRevision: null,
        tail: { fromOrdinal: 4, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(rebased.spans).toEqual([]);
    expect(rebased.skeleton).toEqual([]);
    expect(rebased.hydratedBytes).toBe(0);
  });

  it("seats nothing for an empty tail, which is a real answer and not a bug", () => {
    // The host's tail walks backwards under a hard byte ceiling with no
    // always-serve-one exception, so a chat whose last row is a 1.27 MB tool
    // result ships zero rows.
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 40,
        indexRevision: null,
        tail: { fromOrdinal: 40, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(window.spans).toEqual([]);
    expect(window.rowCount).toBe(40);
  });
});

describe("skeleton chunks", () => {
  it("places entries sparsely and completes only on the final chunk", () => {
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 6,
        indexRevision: null,
        tail: { fromOrdinal: 6, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 9,
        indexRevision: null,
        tail: { fromOrdinal: 9, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 9,
        indexRevision: null,
        tail: { fromOrdinal: 9, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [userMessage("m-1", 1)], events: [] },
      },
      null,
      null,
    );
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
      null,
      null,
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
      null,
      null,
    );
    const appended = applyIndexChange(held, {
      activeTurnId: null,
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 100,
        indexRevision: null,
        tail: { fromOrdinal: 100, messages: [], events: [] },
      },
      null,
      null,
    );
    const partial = applySkeletonChunk(seeded, {
      epoch: 1,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 30),
      isFinal: false,
    });
    expect(partial.skeleton).toHaveLength(30);

    const appended = applyIndexChange(partial, {
      activeTurnId: null,
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
      activeTurnId: null,
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
      activeTurnId: null,
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 0,
        rowCount: 1,
        indexRevision: 0,
        tail: {
          fromOrdinal: 0,
          messages: [userMessage("m-0", 0)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(seeded.rowCount).toBe(1);

    const appended = applyIndexChange(seeded, {
      activeTurnId: null,
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 0,
        rowCount: 3,
        indexRevision: 0,
        tail: {
          fromOrdinal: 0,
          messages: [userMessage("m-0", 0)],
          events: [],
        },
      },
      null,
      null,
    );

    const appended = applyIndexChange(seeded, {
      activeTurnId: null,
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
      null,
      null,
    );
    expect(held.spans).toHaveLength(1);

    const updated = applyIndexChange(held, {
      activeTurnId: null,
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
      null,
      null,
    );
    const next = applyIndexChange(held, {
      activeTurnId: null,
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
      null,
      null,
    );
    const reindexed = applyIndexChange(held, {
      activeTurnId: null,
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
    const window = applyWindowedSnapshot(
      windowWithSkeleton(4),
      {
        epoch: 7,
        rowCount: 4,
        indexRevision: null,
        tail: { fromOrdinal: 4, messages: [], events: [] },
      },
      null,
      null,
    );
    const stale = applyIndexChange(window, {
      activeTurnId: null,
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
      null,
      null,
    );
    expect(held.spans).toHaveLength(1);
    const ahead = applyIndexChange(held, {
      activeTurnId: null,
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
      activeTurnId: null,
      epoch: 2,
      rowCount: 5,
      indexRevision: 1,
      changes: [{ type: "appended", entries: skeletonEntries(4, 1) }],
    });
    expect(ahead.skeleton).toEqual([]);
    expect(ahead.skeletonComplete).toBe(false);
  });
});

describe("idempotent voiding", () => {
  // Hydrated on one span so `staleCarrySpans` has material to carry, matching
  // the "wipes and invalidates on reindexed" setup above.
  function heldWindowWithHydratedSpan(): TranscriptWindow {
    return applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
      null,
      null,
    );
  }

  it("a repeat same-epoch reindexed at unchanged rowCount returns the same window by identity", () => {
    const held = heldWindowWithHydratedSpan();
    const voided = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(voided.staleSpans).toHaveLength(1);

    const repeat = applyIndexChange(voided, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    // The pin: without the no-op guard this rebuilds a fresh object every
    // time, which is exactly what re-announcing at the current epoch would do
    // to `projectedRowCache` and the rest of window-identity-keyed state.
    expect(repeat).toBe(voided);
    expect(repeat.staleSpans).toBe(voided.staleSpans);
    expect(repeat.clock).toBe(voided.clock);
  });

  it("a repeat void with a moved rowCount takes the full void path and adopts it", () => {
    const held = heldWindowWithHydratedSpan();
    const voided = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    const moved = applyIndexChange(voided, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 4,
      indexRevision: 2,
      changes: [{ type: "reindexed" }],
    });

    expect(moved).not.toBe(voided);
    expect(moved.rowCount).toBe(4);
    expect(moved.invalidated).toBe(true);
  });

  it("a repeat void announcing zero rows drops the carry and live state", () => {
    const held = heldWindowWithHydratedSpan();
    const voided = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(voided.staleSpans).toHaveLength(1);

    const zeroed = applyIndexChange(voided, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 0,
      indexRevision: 2,
      changes: [{ type: "reindexed" }],
    });

    expect(zeroed).not.toBe(voided);
    expect(zeroed.staleSpans).toEqual([]);
    expect(zeroed.liveEvents).toEqual([]);
  });

  it("a newer epoch is never a repeat", () => {
    const held = heldWindowWithHydratedSpan();
    const voided = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    const ahead = applyIndexChange(voided, {
      activeTurnId: null,
      epoch: 3,
      rowCount: 3,
      indexRevision: 2,
      changes: [{ type: "reindexed" }],
    });

    expect(ahead).not.toBe(voided);
    expect(ahead.epoch).toBe(3);
  });

  it("a same-epoch reindexed on a rebuilt (non-void) window still voids", () => {
    // This is the wedge guard: matching epoch and rowCount is not enough on
    // its own, `window.invalidated` has to hold too, or a window that was
    // never voided (freshly rebuilt, ordinary hydrated state) would ignore a
    // `reindexed` it has never actually applied.
    const held = heldWindowWithHydratedSpan();
    expect(held.invalidated).toBe(false);

    const reindexed = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 1,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    expect(reindexed.invalidated).toBe(true);
    expect(reindexed).not.toBe(held);
  });

  it("pending byte measurements survive an idempotent repeat void", () => {
    // Pending byte measurements USED to force the full void path (a third
    // exclusion from the repeat guard), when the full void's carry settled
    // eagerly and a no-op repeat would silently skip that work. The ledger now
    // carries the debt (`unsettledByteMessageIds` and the entries both
    // survive) through a void, so a repeat with pending measurements is safe
    // to short-circuit: it skips nothing because there is nothing left to
    // settle-on-void.
    const held = heldWindowWithHydratedSpan();
    const voided = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    // `voidedTranscriptWindow` rebuilds from `emptyTranscriptWindow()`, which
    // never carries a pending byte measurement - so this marker can only be
    // organic here if something streamed into the window AFTER this void.
    // Spread it in directly to isolate the guard from that timing.
    const pending = { ...voided, unsettledByteMessageIds: ["m1"] };

    const repeat = applyIndexChange(pending, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    expect(repeat).toBe(pending);
    expect(repeat.unsettledByteMessageIds).toEqual(["m1"]);
  });
});

describe("isActiveTurnStreamingEcho", () => {
  const turnId = "T";
  const rowId = assistantRowId(turnId);

  it("is false when the frame carries a reindexed change", () => {
    expect(
      isActiveTurnStreamingEcho(
        [
          {
            type: "updated",
            entries: [{ ordinal: 0, entry: skeletonEntry(rowId, 0) }],
          },
          { type: "reindexed" },
        ],
        turnId,
      ),
    ).toBe(false);
  });

  it("is false when an updated entry names a row outside the active turn", () => {
    // An event row id, not an assistant row of any turn.
    expect(
      isActiveTurnStreamingEcho(
        [
          {
            type: "updated",
            entries: [{ ordinal: 0, entry: skeletonEntry("event-row-1", 0) }],
          },
        ],
        turnId,
      ),
    ).toBe(false);
  });

  it("is false when the frame carries no updated change at all", () => {
    expect(
      isActiveTurnStreamingEcho(
        [{ type: "appended", entries: skeletonEntries(0, 1) }],
        turnId,
      ),
    ).toBe(false);
  });

  it("is false when there is no active turn", () => {
    expect(
      isActiveTurnStreamingEcho(
        [
          {
            type: "updated",
            entries: [{ ordinal: 0, entry: skeletonEntry(rowId, 0) }],
          },
        ],
        null,
      ),
    ).toBe(false);
  });
});

describe("the active turn's streaming echo exemption in applyIndexChange", () => {
  function heldAssistantTurnWindow(turnId: string): TranscriptWindow {
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 1,
          indexRevision: null,
          tail: { fromOrdinal: 1, messages: [], events: [] },
        },
        null,
        null,
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [skeletonEntry(assistantRowId(turnId), 0)],
        isFinal: true,
      },
    );
    return applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [assistantMessage("assistant-streaming", turnId, 1)],
      }),
      null,
      null,
    );
  }

  it("an updated frame naming only the active turn's assistant rows keeps the turn's spans", () => {
    const turnId = "T";
    const held = heldAssistantTurnWindow(turnId);
    expect(held.spans).toHaveLength(1);

    const rewrittenEntry = {
      ...skeletonEntry(assistantRowId(turnId), 0),
      byteLength: 999,
    };
    const updated = applyIndexChange(held, {
      activeTurnId: turnId,
      epoch: 1,
      rowCount: 1,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: rewrittenEntry }],
        },
      ],
    });

    // The span is exempt from the drop while it names only the active turn.
    expect(updated.spans).toHaveLength(1);
    expect(updated.spans).toBe(held.spans);
    // The skeleton entry the frame carried is folded in regardless.
    expect(updated.skeleton[0]?.byteLength).toBe(999);
  });

  it("drops the span when there is no active turn", () => {
    const turnId = "T";
    const held = heldAssistantTurnWindow(turnId);

    const updated = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 1,
      rowCount: 1,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [
            { ordinal: 0, entry: skeletonEntry(assistantRowId(turnId), 0) },
          ],
        },
      ],
    });

    expect(updated.spans).toEqual([]);
  });

  it("drops the span when the updated entry names a DIFFERENT turn", () => {
    const turnId = "T";
    const held = heldAssistantTurnWindow(turnId);

    const updated = applyIndexChange(held, {
      activeTurnId: "OTHER",
      epoch: 1,
      rowCount: 1,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [
            { ordinal: 0, entry: skeletonEntry(assistantRowId(turnId), 0) },
          ],
        },
      ],
    });

    expect(updated.spans).toEqual([]);
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
    expect(merged.messageIds).toEqual(["m-0", "m-shared", "m-4"]);
    expect(merged.eventIds).toEqual(["e-shared", "e-4"]);
  });
});

describe("held-copy preference for the active turn", () => {
  const firstBlock = {
    type: "text" as const,
    blockId: "block-1",
    status: "completed" as const,
    timestamp: 1,
    text: "first",
    providerNotice: null,
  };
  const secondBlock = { ...firstBlock, blockId: "block-2", text: "second" };

  function seatedAssistantBlocks(
    window: TranscriptWindow,
    messageId: string,
  ): Extract<Message, { role: "assistant" }>["blocks"] {
    const seated = hydratedRecords(window).messages.find(
      (message) => message.messageId === messageId,
    );
    if (seated === undefined || seated.role !== "assistant") {
      throw new Error(`expected an assistant message named ${messageId}`);
    }
    return seated.blocks;
  }

  function windowHoldingAssistant(
    turnId: string,
    message: Extract<Message, { role: "assistant" }>,
  ): TranscriptWindow {
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 1,
          indexRevision: null,
          tail: { fromOrdinal: 1, messages: [], events: [] },
        },
        null,
        null,
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [skeletonEntry(assistantRowId(turnId), 0)],
        isFinal: true,
      },
    );
    return appendLiveRecords(seeded, { messages: [message], events: [] });
  }

  function heldLongerCopyWindow(turnId: string, messageId: string) {
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 1,
          indexRevision: null,
          tail: { fromOrdinal: 1, messages: [], events: [] },
        },
        null,
        null,
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [skeletonEntry(assistantRowId(turnId), 0)],
        isFinal: true,
      },
    );
    return appendLiveRecords(seeded, {
      messages: [
        {
          ...assistantMessage(messageId, turnId, 2),
          blocks: [firstBlock, secondBlock],
        },
      ],
      events: [],
    });
  }

  it("a stale range answer cannot regress the actively streaming body", () => {
    const turnId = "turn-streaming";
    const messageId = "assistant-streaming";
    const held = heldLongerCopyWindow(turnId, messageId);

    const seated = applyRangeResponse(
      held,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          { ...assistantMessage(messageId, turnId, 2), blocks: [firstBlock] },
        ],
      }),
      turnId,
      null,
    );

    // The held (longer) body wins over the served (shorter, stale) one.
    expect(seatedAssistantBlocks(seated, messageId)).toEqual([
      firstBlock,
      secondBlock,
    ]);
  });

  it("yields to a served copy the host stamped newer than the held one", () => {
    // Holding a copy is not the same as having applied every delta to it. A
    // block write can be lost while the stream stays open, and then the held
    // copy is behind - but the row is hydrated, so it leaves no gap for the
    // planner and no later request repairs it. This seat is the only place
    // the two copies meet, and `blocksVersion` is the host's own monotonic
    // write counter, so it is answerable here at no cost.
    const turnId = "turn-lost-write";
    const messageId = "assistant-lost-write";
    const held = windowHoldingAssistant(turnId, {
      ...assistantMessage(messageId, turnId, 2),
      blocks: [firstBlock],
      blocksVersion: 3,
    });

    const seated = applyRangeResponse(
      held,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          {
            ...assistantMessage(messageId, turnId, 2),
            blocks: [firstBlock, secondBlock],
            blocksVersion: 5,
          },
        ],
      }),
      turnId,
      null,
    );

    expect(seatedAssistantBlocks(seated, messageId)).toEqual([
      firstBlock,
      secondBlock,
    ]);
  });

  it("keeps the held copy when the host stamped it newer", () => {
    // The ordinary streaming case with stamps present on both sides: the
    // client's delta-rewritten copy is ahead, and the freshness gate must not
    // become a reason to discard it.
    const turnId = "turn-ahead";
    const messageId = "assistant-ahead";
    const held = windowHoldingAssistant(turnId, {
      ...assistantMessage(messageId, turnId, 2),
      blocks: [firstBlock, secondBlock],
      blocksVersion: 7,
    });

    const seated = applyRangeResponse(
      held,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          {
            ...assistantMessage(messageId, turnId, 2),
            blocks: [firstBlock],
            blocksVersion: 5,
          },
        ],
      }),
      turnId,
      null,
    );

    expect(seatedAssistantBlocks(seated, messageId)).toEqual([
      firstBlock,
      secondBlock,
    ]);
  });

  it("prefers the later-served copy when a record sits in two spans", () => {
    // One turn's records reach every span its rows do, and adjacent spans are
    // not always merged, so the same id sits in several spans at different
    // serves. `hydratedRecords` bodies a duplicate from the greatest
    // `servedAt`; answering this preference from the earliest ORDINAL instead
    // compares the served copy against a record the reader is not looking at,
    // and seats that verdict at the newest stamp - so the freshest body is
    // displaced and every later delta builds on the regressed one.
    const turnId = "turn-two-spans";
    const messageId = "assistant-two-spans";
    const rowId = assistantRowId(turnId);
    // Stamped, so the growth survives its OWN seat: without a version the
    // preference below would substitute the older copy into the later span
    // too, and the fixture would pin nothing.
    const grown = {
      ...assistantMessage(messageId, turnId, 2),
      blocks: [firstBlock, secondBlock],
      blocksVersion: 5,
    };
    const short = {
      ...assistantMessage(messageId, turnId, 2),
      blocks: [firstBlock],
      blocksVersion: 3,
    };
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 3,
          indexRevision: null,
          tail: { fromOrdinal: 3, messages: [], events: [] },
        },
        null,
        null,
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry(rowId, 0),
          skeletonEntry("row-1", 1),
          skeletonEntry("row-2", 2),
        ],
        isFinal: true,
      },
    );

    // The earliest ordinal, served first and so carrying the older body...
    const early = applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [rowId],
        messages: [short],
      }),
      turnId,
      null,
    );
    // ...and a LATER serve of a later ordinal carrying the same record grown.
    // Ordinal 1 stays a gap, so these never merge into one span.
    const later = applyRangeResponse(
      early,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 2,
        rowIds: ["row-2"],
        messages: [grown],
      }),
      turnId,
      null,
    );

    // A bulk answer for the earliest row, generated before the growth. The
    // held copy it must be measured against is span 2's.
    const seated = applyRangeResponse(
      later,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [rowId],
        messages: [short],
      }),
      turnId,
      null,
    );

    expect(seatedAssistantBlocks(seated, messageId)).toEqual([
      firstBlock,
      secondBlock,
    ]);
  });

  it("seats the served copy verbatim when there is no active turn", () => {
    const turnId = "turn-idle";
    const messageId = "assistant-idle";
    const held = heldLongerCopyWindow(turnId, messageId);

    const seated = applyRangeResponse(
      held,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          { ...assistantMessage(messageId, turnId, 2), blocks: [firstBlock] },
        ],
      }),
      null,
      null,
    );

    expect(seatedAssistantBlocks(seated, messageId)).toEqual([firstBlock]);
  });

  it("a reordered snapshot tail cannot regress the actively streaming body", () => {
    // A bulk snapshot serialized before newer block deltas can arrive after
    // they were applied. Its tail seat must apply the same held-copy
    // preference as the range seat - `insertSpan` would otherwise make the
    // older served copy win and later deltas would build on the regressed
    // body.
    const turnId = "turn-snapshot";
    const messageId = "assistant-snapshot";
    const held = heldLongerCopyWindow(turnId, messageId);

    const seated = applyWindowedSnapshot(
      held,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: {
          fromOrdinal: 0,
          messages: [
            { ...assistantMessage(messageId, turnId, 2), blocks: [firstBlock] },
          ],
          events: [],
        },
      },
      turnId,
      null,
    );

    expect(seatedAssistantBlocks(seated, messageId)).toEqual([
      firstBlock,
      secondBlock,
    ]);
  });

  it("prefers a copy held only by a STALE span over a delayed range answer", () => {
    // A same-epoch non-echo `updated` demotes the active turn's span while
    // its deltas keep arriving - the stale copy is then the freshest one the
    // client holds, and a delayed bulk-lane answer must not displace it.
    const turnId = "turn-demoted";
    const messageId = "assistant-demoted";
    const seated = applyRangeResponse(
      heldLongerCopyWindow(turnId, messageId),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          {
            ...assistantMessage(messageId, turnId, 2),
            blocks: [firstBlock, secondBlock],
          },
        ],
      }),
      turnId,
      null,
    );
    // A non-echo rewrite (no active turn from the store's point of view)
    // demotes the turn's span to stale.
    const demoted = applyIndexChange(seated, {
      activeTurnId: null,
      epoch: 1,
      rowCount: 1,
      indexRevision: 2,
      changes: [
        {
          type: "updated",
          entries: [
            { ordinal: 0, entry: skeletonEntry(assistantRowId(turnId), 0) },
          ],
        },
      ],
    });
    expect(demoted.spans).toEqual([]);
    expect(demoted.staleSpans).toHaveLength(1);

    const reserved = applyRangeResponse(
      demoted,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId(turnId)],
        messages: [
          { ...assistantMessage(messageId, turnId, 2), blocks: [firstBlock] },
        ],
      }),
      turnId,
      null,
    );

    expect(seatedAssistantBlocks(reserved, messageId)).toEqual([
      firstBlock,
      secondBlock,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 40,
        indexRevision: null,
        tail: { fromOrdinal: 40, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(planTranscriptHydration(window, null, [])).toEqual({
      fromOrdinal: 20,
      toOrdinal: 40,
    });
  });

  it("moves on to the visible span once the tail is hydrated", () => {
    const window = applyRangeResponse(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 40,
          indexRevision: null,
          tail: { fromOrdinal: 40, messages: [], events: [] },
        },
        null,
        null,
      ),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 20,
        rowIds: Array.from({ length: 20 }, (_u, i) => `row-${20 + i}`),
        messages: [userMessage("m-20", 20)],
      }),
      null,
      null,
    );
    expect(planTranscriptHydration(window, null, [])).toBeNull();
    expect(
      planTranscriptHydration(window, { fromOrdinal: 0, toOrdinal: 10 }, []),
    ).toEqual({ fromOrdinal: 0, toOrdinal: 10 });
  });

  it("asks for nothing while the index is void - that owes a resnapshot, not a range", () => {
    const window = applyIndexChange(windowWithSkeleton(10), {
      activeTurnId: null,
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
        applyWindowedSnapshot(
          emptyTranscriptWindow(),
          {
            epoch: 1,
            rowCount: 40,
            indexRevision: null,
            tail: { fromOrdinal: 40, messages: [], events: [] },
          },
          null,
          null,
        ),
        rangeResponse({
          epoch: 1,
          fromOrdinal: 20,
          rowIds: Array.from({ length: 20 }, (_u, i) => `row-${20 + i}`),
          messages: [userMessage("m-20", 20)],
        }),
        null,
        null,
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
      const noTail = applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 40,
          indexRevision: null,
          tail: { fromOrdinal: 40, messages: [], events: [] },
        },
        null,
        null,
      );
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

describe("stale spans", () => {
  it("a rebased snapshot carries the previous spans into staleSpans, and the fresh spans hold only the new inline tail", () => {
    const seeded = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
      null,
      null,
    );
    expect(seeded.spans).toHaveLength(1);

    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 5,
        indexRevision: null,
        tail: { fromOrdinal: 4, messages: [userMessage("m-4", 4)], events: [] },
      },
      null,
      null,
    );

    expect(rebased.epoch).toBe(2);
    expect(rebased.staleSpans).toHaveLength(1);
    expect(rebased.staleSpans[0].rowIds).toEqual(["row-0", "row-1"]);
    // The fresh spans hold only the newly seated inline tail.
    expect(rebased.spans).toHaveLength(1);
    expect(rebased.spans[0].fromOrdinal).toBe(4);
  });

  it("carries nothing when the rebased snapshot's rowCount is zero", () => {
    const seeded = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
      null,
      null,
    );

    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(rebased.staleSpans).toEqual([]);
  });

  it("a reindexed index change carries prior spans into staleSpans and voids the window", () => {
    const held = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
      null,
      null,
    );

    const reindexed = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    expect(reindexed.invalidated).toBe(true);
    expect(reindexed.staleSpans).toHaveLength(1);
    expect(reindexed.staleSpans[0].rowIds).toEqual(["row-0"]);
  });

  it("carries nothing when the reindexed frame's rowCount is zero", () => {
    const held = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
      null,
      null,
    );

    const reindexed = applyIndexChange(held, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 0,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    expect(reindexed.staleSpans).toEqual([]);
  });

  it("retires a stale span once a fresh range response serves all of its row ids", () => {
    const seeded = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 5,
        indexRevision: null,
        tail: { fromOrdinal: 4, messages: [userMessage("m-4", 4)], events: [] },
      },
      null,
      null,
    );
    expect(rebased.staleSpans).toHaveLength(1);

    const skeletoned = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 5),
      isFinal: true,
    });

    const reserved = applyRangeResponse(
      skeletoned,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0-new", 0), userMessage("m-1-new", 1)],
      }),
      null,
      null,
    );

    expect(reserved.staleSpans).toEqual([]);
  });

  it("retires a stale span the complete replacement skeleton does not name, keeping the ones it does", () => {
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 4,
          indexRevision: null,
          tail: { fromOrdinal: 4, messages: [], events: [] },
        },
        null,
        null,
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry("keep-0", 0),
          skeletonEntry("mid-1", 1),
          skeletonEntry("drop-2", 2),
          skeletonEntry("mid-3", 3),
        ],
        isFinal: true,
      },
    );
    const seededA = applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["keep-0"],
        messages: [userMessage("m-keep", 0)],
      }),
      null,
      null,
    );
    const seededB = applyRangeResponse(
      seededA,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 2,
        rowIds: ["drop-2"],
        messages: [userMessage("m-drop", 2)],
      }),
      null,
      null,
    );
    expect(seededB.spans).toHaveLength(2);

    const reindexed = applyIndexChange(seededB, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 4,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(reindexed.staleSpans).toHaveLength(2);

    const finalSkeleton = applySkeletonChunk(reindexed, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [
        skeletonEntry("keep-0", 0),
        skeletonEntry("unrelated-1", 1),
        skeletonEntry("unrelated-2", 2),
        skeletonEntry("unrelated-3", 3),
      ],
      isFinal: true,
    });

    expect(finalSkeleton.skeletonComplete).toBe(true);
    expect(finalSkeleton.staleSpans).toHaveLength(1);
    expect(finalSkeleton.staleSpans[0].rowIds).toEqual(["keep-0"]);
  });

  it("still plans a fetch for a visible range only stale spans cover - stale is display-only", () => {
    const seeded = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 5,
        indexRevision: null,
        tail: { fromOrdinal: 4, messages: [userMessage("m-4", 4)], events: [] },
      },
      null,
      null,
    );
    expect(rebased.staleSpans).toHaveLength(1);
    expect(rebased.invalidated).toBe(false);

    const plan = planTranscriptHydration(
      rebased,
      { fromOrdinal: 0, toOrdinal: 2 },
      [],
    );

    expect(plan).toEqual({ fromOrdinal: 0, toOrdinal: 2 });
  });

  /**
   * The split-block / doubled-in-progress-segment regression: a streaming
   * rewrite must reach a copy held ONLY by a stale span. If it reported
   * `held: false` instead, the store's applier would restart an empty live
   * accumulator mid-turn, and the turn would render as two blocks - the
   * frozen stale prefix plus the post-demotion remainder - with any
   * in-progress block (a compaction bar) duplicated across both.
   */
  it("a streaming rewrite reaches a copy held only by a stale span", () => {
    const seeded = applyRangeResponse(
      windowWithSkeleton(4),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 5,
        indexRevision: null,
        tail: { fromOrdinal: 4, messages: [userMessage("m-4", 4)], events: [] },
      },
      null,
      null,
    );
    // The only FRESH span is the new inline tail; "m-0" survives in a stale
    // span alone.
    expect(rebased.spans).toHaveLength(1);
    expect(rebased.spans[0].fromOrdinal).toBe(4);
    expect(rebased.staleSpans.flatMap((span) => span.rowIds)).toEqual([
      "row-0",
    ]);

    const rewritten = streamWindowMessage(
      rebased,
      "m-0",
      (message) => ({
        ...message,
        timestamp: message.timestamp + 1,
      }),
      null,
    );

    expect(rewritten.held).toBe(true);
    const held = hydratedRecords(rewritten.window).messages.find(
      (message) => message.messageId === "m-0",
    );
    expect(held?.timestamp).toBe(1);
  });

  it("retires a mixed stale span once the rows the replacement skeleton kept are served", () => {
    // The span names one surviving row and one the complete replacement
    // skeleton dropped, so `retireUnnamedStaleSpans` keeps it - correctly, for
    // the survivor. The deleted row can then never appear in a fresh serve, so
    // a coverage test that only asks "served yet?" pins the span in the tier
    // for the rest of the session: holding shared budget, and keeping a record
    // in `hydratedRecords` that the row merger will never draw.
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 2,
          indexRevision: null,
          tail: { fromOrdinal: 2, messages: [], events: [] },
        },
        null,
        null,
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [skeletonEntry("keep-0", 0), skeletonEntry("gone-1", 1)],
        isFinal: true,
      },
    );
    const hydrated = applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["keep-0", "gone-1"],
        messages: [userMessage("m-keep", 0), userMessage("m-gone", 1)],
      }),
      null,
      null,
    );
    expect(hydrated.spans).toHaveLength(1);

    const reindexed = applyIndexChange(hydrated, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 1,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    const replacement = applySkeletonChunk(reindexed, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [skeletonEntry("keep-0", 0)],
      isFinal: true,
    });
    // Kept for its survivor, exactly as the unnamed-span rule intends.
    expect(replacement.skeletonComplete).toBe(true);
    expect(replacement.staleSpans).toHaveLength(1);

    const reserved = applyRangeResponse(
      replacement,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 0,
        rowIds: ["keep-0"],
        messages: [userMessage("m-keep-new", 0)],
      }),
      null,
      null,
    );

    expect(reserved.staleSpans).toEqual([]);
    expect(
      hydratedRecords(reserved).messages.map((message) => message.messageId),
    ).toEqual(["m-keep-new"]);
  });

  it("keeps a marker-only stale span through a seat, and lets the complete skeleton retire it", () => {
    // The other side of the same rule. A tail the host served without row ids
    // is seated on positional markers, and that tail is also where the ACTIVE
    // turn's row lives - so "no resolvable row left, drop it" would destroy
    // the only copy of a streaming body at the next seat. A marker proves
    // neither served nor deleted; only the complete replacement skeleton does.
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: {
          fromOrdinal: 0,
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(seeded.spans[0].rowIds).toEqual(["", ""]);

    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 3,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [userMessage("m-2", 2)], events: [] },
      },
      null,
      null,
    );

    // The tail seat runs the coverage retirement, and the marker-only carry
    // survives it with its bodies intact.
    expect(rebased.staleSpans).toHaveLength(1);
    expect(
      hydratedRecords(rebased).messages.map((message) => message.messageId),
    ).toEqual(["m-0", "m-1", "m-2"]);

    const named = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 3),
      isFinal: true,
    });

    expect(named.staleSpans).toEqual([]);
  });

  it("keeps the carried span the reader is looking at when the budget rebalances", () => {
    // Warmth is the only thing that speaks for a stale span - it has no tail,
    // viewport or required-ordinal protection - and a viewport report used to
    // touch fresh spans only. So the carry ON SCREEN aged while an off-screen
    // one stayed warmer, and the first unrelated range to grow the fresh tier
    // discarded exactly the rows the reader was reading.
    const bulk = "x".repeat(Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.47));
    // Seated first, so it is the COLDER of the two by seat order; only the
    // viewport touch can make it the survivor.
    // Message ids match their row ids (production seats a plain user row at
    // `message.messageId` - `row-projection.ts`), which is what lets the
    // viewport touch below find a record on "row-0" to warm.
    const withOnScreen = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [messageWithText(userMessage("row-0", 0), bulk)],
      }),
      null,
      null,
    );
    const seeded = applyRangeResponse(
      withOnScreen,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10"],
        messages: [messageWithText(userMessage("row-10", 10), bulk)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: {
          fromOrdinal: 29,
          messages: [userMessage("m-29", 29)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(rebased.staleSpans.map((span) => span.rowIds)).toEqual([
      ["row-0"],
      ["row-10"],
    ]);

    // The replacement index names the carried row at ordinal 0, which is
    // where the row merger draws it - so that is where "on screen" is decided,
    // not at the span's own stale coordinates.
    const named = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [skeletonEntry("row-0", 0)],
      isFinal: false,
    });
    const read = touchTranscriptRange(named, {
      fromOrdinal: 0,
      toOrdinal: 2,
    });

    // A late, unrelated range grows the fresh tier past what both carries fit
    // beside, so the rebalance has to choose one.
    const rebalanced = applyRangeResponse(
      read,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 20,
        rowIds: ["row-20"],
        messages: [
          messageWithText(
            userMessage("m-20", 20),
            "y".repeat(Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.15)),
          ),
        ],
      }),
      null,
      null,
    );

    expect(rebalanced.staleSpans.map((span) => span.rowIds)).toEqual([
      ["row-0"],
    ]);
  });

  it("does not warm a carry for a row the FRESH tier is the one drawing", () => {
    // Warmth has to mean "this carry is putting a row on screen", because it
    // is the only thing that speaks for a carry under a squeeze. A row the
    // fresh tier has re-served is drawn from the fresh copy - `seatStaleRows`
    // refuses it on `placedRowIds` - so crediting the carry for it lets a span
    // retained purely for an OFF-screen row outrank one that is really on
    // screen, which is the inversion the viewport bump exists to prevent.
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: {
          fromOrdinal: 29,
          messages: [userMessage("m-29", 29)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(rebased.staleSpans.map((span) => span.rowIds)).toEqual([
      ["row-0", "row-1"],
    ]);

    // The replacement serves row-0 only. The carry survives for row-1, which
    // is what makes this the MIXED span the retirement rule deliberately keeps
    // - and row-0 is now the fresh tier's to draw.
    const served = applyRangeResponse(
      rebased,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
      null,
      null,
    );
    expect(served.staleSpans.map((span) => span.rowIds)).toEqual([
      ["row-0", "row-1"],
    ]);

    const before = served.staleSpans.map((span) =>
      spanTouchStamp(served, span),
    );
    const read = touchTranscriptRange(served, {
      fromOrdinal: 0,
      toOrdinal: 1,
    });

    expect(read.staleSpans.map((span) => spanTouchStamp(read, span))).toEqual(
      before,
    );
  });

  it("does not warm a carry through the old ordinal of a row the index names off screen", () => {
    // Name and hole are a PRIORITY in `seatStaleRows`, not a choice: a row the
    // replacement index has named draws at that name and never falls back to
    // its old ordinal. Read as either-or, a row named far off screen still
    // counts as visible whenever its old ordinal happens to land in a hole the
    // replacement skeleton has not reached yet - which, mid-restream, is most
    // of them.
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        // The message's own id names its row, matching production
        // (`row-projection.ts` seats a plain user row at `message.messageId`)
        // - the touch below warms the record a span DRAWS, which is decided by
        // that identity, not by the span's `fromOrdinal`.
        messages: [userMessage("row-5", 5)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: {
          fromOrdinal: 29,
          messages: [userMessage("row-29", 29)],
          events: [],
        },
      },
      null,
      null,
    );
    // The replacement index renumbers the carried row from 5 to 20 and has not
    // reached ordinal 5, so 5 is still a hole.
    const renamed = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 20,
      entries: [skeletonEntry("row-5", 20)],
      isFinal: false,
    });
    expect(renamed.skeleton[5]).toBeUndefined();
    expect(renamed.staleSpans.map((span) => span.rowIds)).toEqual([["row-5"]]);

    const before = renamed.staleSpans.map((span) =>
      spanTouchStamp(renamed, span),
    );
    const atOldOrdinal = touchTranscriptRange(renamed, {
      fromOrdinal: 5,
      toOrdinal: 6,
    });

    expect(
      atOldOrdinal.staleSpans.map((span) => spanTouchStamp(atOldOrdinal, span)),
    ).toEqual(before);

    // The other direction, so this cannot pass by never warming anything: at
    // the ordinal the index actually names, the carry IS on screen.
    const atName = touchTranscriptRange(renamed, {
      fromOrdinal: 20,
      toOrdinal: 21,
    });

    expect(
      atName.staleSpans.map((span) => spanTouchStamp(atName, span)),
    ).not.toEqual(before);
  });

  it("does not warm a carry whose rows are all unverified-identity markers", () => {
    // `seatStaleRows` returns on the marker before it considers position, so a
    // marker row is never drawn - not at its old ordinal, not anywhere. This
    // is only safe because the marker span that MATTERS is the active turn's,
    // and that one is warmed by the write path
    // (`rewriteWindowMessage` bumps `touchedAt` on every delta) rather than by
    // the viewport.
    const legacyTail = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 10,
        indexRevision: null,
        // No skeleton has arrived, so the tail is seated positionally and its
        // row ids are markers.
        tail: {
          fromOrdinal: 8,
          messages: [userMessage("m-8", 8), userMessage("m-9", 9)],
          events: [],
        },
      },
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      legacyTail,
      {
        epoch: 2,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(rebased.staleSpans.map((span) => span.rowIds)).toEqual([["", ""]]);

    const before = rebased.staleSpans.map((span) =>
      spanTouchStamp(rebased, span),
    );
    const read = touchTranscriptRange(rebased, {
      fromOrdinal: 8,
      toOrdinal: 10,
    });

    expect(read.staleSpans.map((span) => spanTouchStamp(read, span))).toEqual(
      before,
    );
  });

  it("keeps both carries when their markers collide only across coordinate spaces", () => {
    // Spans are disjoint WITHIN a coordinate space, so two candidates can share
    // an ordinal only when they come from different ones - where the same
    // number names different rows. Deduplicating markers by ordinal could
    // therefore never fire except on that coincidence, and firing it discarded
    // a held body whose replacement had not arrived.
    //
    // Two rebases with no skeleton in between is the shape: each tail seats
    // positionally, so each carries markers, and the second rebase weighs the
    // space it is leaving against the carry from the first.
    const first = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 10,
        indexRevision: null,
        tail: {
          fromOrdinal: 8,
          messages: [userMessage("m-8", 8), userMessage("m-9", 9)],
          events: [],
        },
      },
      null,
      null,
    );
    const second = applyWindowedSnapshot(
      first,
      {
        epoch: 2,
        rowCount: 10,
        indexRevision: null,
        tail: {
          fromOrdinal: 8,
          messages: [userMessage("n-8", 8), userMessage("n-9", 9)],
          events: [],
        },
      },
      null,
      null,
    );
    // Epoch 1's tail is the carry; epoch 2's is fresh, and both are markers at
    // the same two ordinals.
    expect(second.staleSpans.map((span) => span.rowIds)).toEqual([["", ""]]);
    expect(second.spans.map((span) => span.rowIds)).toEqual([["", ""]]);

    // The third rebase weighs them against each other. Epoch 2's is warmer, so
    // an ordinal dedupe reads epoch 1's as contributing nothing.
    const third = applyWindowedSnapshot(
      second,
      {
        epoch: 3,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(third.staleSpans).toHaveLength(2);
    expect(third.staleSpans.flatMap((span) => span.messageIds).sort()).toEqual([
      "m-8",
      "m-9",
      "n-8",
      "n-9",
    ]);
  });

  it("keeps the carry the renderer draws from when two hold one row and warmth ties", () => {
    // `seatStaleRows` draws a duplicated row from the greatest `servedAt`, but
    // `boundedStaleSpans` decides which carry SURVIVES first-come in warmth
    // order - so ordering the two by anything else discards the copy the
    // renderer had selected and regresses that row to an older serve. No budget
    // pressure is involved: the coverage dedupe alone drops it.
    //
    // The tie is the ordinary case rather than a contrivance. A viewport report
    // bumps every carry holding a visible row, so two carries the reader can
    // see are equally warm, and a stable sort then falls back to input order -
    // which for the re-bound below is the STORED ordinal order, putting the
    // older carry first.
    //
    // Message ids match their row ids throughout, as production seats a plain
    // user row (`row-projection.ts`: `rowId: message.messageId`).
    //
    // Under single ownership this pin's ORIGINAL premise (a coverage dedupe
    // could discard the FRESHER carry's row while a redundant OLDER copy
    // survives) is unrepresentable: `older` and `fresher` both reference
    // "row-5" through the one ledger entry, so they tie in derived warmth AND
    // serve stamp by construction. `boundedStaleSpans`' admission pass then
    // sees `fresher` (processed second on the stable tie-break) contribute NO
    // uncovered row at all - `older` already covers "row-5" too - so `fresher`
    // is dropped as wholly redundant, not "discarded despite being the newer
    // copy". That is a correct consequence of single ownership, not the
    // regression this test used to guard: there is only one "row-5" body to
    // render, and it renders correctly (asserted below) whichever span
    // structurally carries the reference.
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5", "row-6"],
        messages: [userMessage("row-5", 5), userMessage("row-6", 6)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: { fromOrdinal: 30, messages: [], events: [] },
      },
      null,
      null,
    );
    // Epoch 2 re-serves `row-5` alone, at a new ordinal and with a body the
    // first serve did not have. The timestamp is the visible difference.
    const reserved = applyRangeResponse(
      rebased,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 12,
        rowIds: ["row-5"],
        messages: [userMessage("row-5", 555)],
      }),
      null,
      null,
    );
    // A second rebase before the replacement lands, which is what leaves two
    // carries holding `row-5`: the fresher one is admitted for it, the older
    // one for `row-6` beside it.
    const carried = applyWindowedSnapshot(
      reserved,
      {
        epoch: 3,
        rowCount: 30,
        indexRevision: null,
        tail: { fromOrdinal: 30, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(carried.staleSpans.map((span) => span.rowIds)).toEqual([
      ["row-5", "row-6"],
      ["row-5"],
    ]);
    // No per-span serve comparison here any more: both carries reference
    // "row-5" through the single ledger entry, so their derived serve stamps
    // tie BY CONSTRUCTION - there is no per-span copy left to disagree.

    // Both rows on screen, so both carries are warmed to the same clock.
    const named = applySkeletonChunk(carried, {
      epoch: 3,
      fromOrdinal: 20,
      entries: [skeletonEntry("row-5", 20), skeletonEntry("row-6", 21)],
      isFinal: false,
    });
    const warm = touchTranscriptRange(named, {
      fromOrdinal: 20,
      toOrdinal: 22,
    });
    expect(spanTouchStamp(warm, warm.staleSpans[0])).toBe(
      spanTouchStamp(warm, warm.staleSpans[1]),
    );

    // Any seat re-bounds the tier, and this one covers neither carry.
    const seat = applyRangeResponse(
      warm,
      rangeResponse({
        epoch: 3,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("row-0", 0)],
      }),
      null,
      null,
    );

    // `fresher` contributed no coverage the admitted `older` span did not
    // already have (see the migration note above), so only one carry survives.
    expect(seat.staleSpans.map((span) => span.rowIds)).toEqual([
      ["row-5", "row-6"],
    ]);
    // The consequence, stated on the body rather than on span identity: the
    // row still renders from the newer serve, regardless of which span
    // structurally references it.
    expect(
      hydratedRecords(seat).messages.find(
        (message) => message.messageId === "row-5",
      )?.timestamp,
    ).toBe(555);
  });

  it("keeps a locally-rewritten SETTLED record over a delayed older serve", () => {
    // The held-copy preference was active-turn-only, but a settled record is
    // rewritten in place too - a detached subagent's card, an image resolving.
    // A range sliced before that write arrives with the newest `servedAt`, so
    // `hydratedRecords` picks its older body; the row stays hydrated, so no
    // planner gap ever repairs it.
    //
    // Settled records take the OPPOSITE gate to the active turn: the host is
    // the authority, so the held copy is substituted only on positive proof
    // that it is ahead.
    const settled = {
      ...assistantMessage("a-settled", "t-old", 5),
      blocksVersion: 1,
    };
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settled],
      }),
      null,
      null,
    );
    // The local in-place rewrite, bumping the host's write counter the way
    // `accumulateTurnContent` does.
    const rewritten = updateWindowMessage(
      seeded,
      "a-settled",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, blocksVersion: 2, timestamp: 99 },
      null,
    );
    expect(rewritten.held).toBe(true);

    // A delayed range re-serves the SAME record at its pre-rewrite version.
    const delayed = applyRangeResponse(
      rewritten.window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settled],
      }),
      // No active turn, so only the settled rule can save this.
      null,
      null,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-settled",
    );
    expect(rendered?.timestamp).toBe(99);
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.blocksVersion
        : undefined,
    ).toBe(2);
  });

  it("clears the retained viewport when the reader reports no placed row", () => {
    // The retained range is a protection, so a stale one keeps exempting carry
    // the reader has scrolled away from - and an exemption is the one thing the
    // budget cannot argue with. `null` is the report the reader sends on
    // reaching the unplaced live tail; it warms nothing, but it has to clear.
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [userMessage("m-5", 5)],
      }),
      null,
      null,
    );
    const watching = touchTranscriptRange(seeded, {
      fromOrdinal: 5,
      toOrdinal: 6,
    });
    expect(watching.visibleOrdinals).toEqual({ fromOrdinal: 5, toOrdinal: 6 });

    const atTail = touchTranscriptRange(watching, null);

    expect(atTail.visibleOrdinals).toBeNull();
    // Clearing warms nothing and must not churn the clock.
    expect(atTail.clock).toBe(watching.clock);
    expect(atTail.spans).toBe(watching.spans);
    // Idempotent, so a resting tail viewport does not churn the store.
    expect(touchTranscriptRange(atTail, null)).toBe(atTail);
  });

  // ── The settled arm's image tiebreak decides on DIRECTIONAL evidence ──
  //
  // Two pins used to live here ("keeps a held copy whose image resolved after
  // the serve was sliced", "keeps a held copy whose image entry was REPLACED
  // for a source both list") pinning the any-difference-means-held-is-newer
  // preference. That preference was the defect: "different" is not "newer",
  // and a held copy seated from an OLDER slice differs from a fresher serve
  // in exactly the same way, so the preference pinned the stale copy with the
  // row hydrated and no gap left for the planner. Their scenarios return
  // below with the write WITNESSED, where rule 2 decides them correctly - and
  // the unwitnessed forms now pin the opposite outcome, so the preference
  // cannot be resurrected.

  function imageEntry(state: "pending" | "resolved", source: string) {
    return state === "pending"
      ? {
          source,
          canonicalSource: source,
          width: null,
          height: null,
          state: "consent-required" as const,
          attachmentHash: null,
          mediaType: null,
        }
      : {
          source,
          canonicalSource: source,
          width: 10,
          height: 10,
          state: "resolved" as const,
          attachmentHash: "a".repeat(64),
          mediaType: "image/png" as const,
        };
  }

  function settledWithImages(
    messageId: string,
    entries: readonly ImageResolutionEntry[],
  ): Extract<Message, { role: "assistant" }> {
    return {
      ...assistantMessage(messageId, `t-${messageId}`, 5),
      blocksVersion: 3,
      imageResolutions: [...entries],
    };
  }

  // Distinct RESOLVED content per (source, version) - unlike `imageEntry`'s
  // fixed pending/resolved pair, this gives a multi-write scenario as many
  // uniquely-matchable contents per source as it needs, so every witnessed
  // occurrence stays unambiguous under `servedStamp`'s unique-content match.
  function versionedImageEntry(
    source: string,
    version: number,
  ): ImageResolutionEntry {
    return {
      source,
      canonicalSource: source,
      width: 10,
      height: 10,
      state: "resolved" as const,
      attachmentHash: `${version}`.padStart(64, "0"),
      mediaType: "image/png" as const,
    };
  }

  it("a witnessed write defeats the delayed serve that predates it", () => {
    // The witness stream carried BOTH contents, so rule 2 has stamps on both
    // sides: held (rewritten, exact apply stamp) vs served (unique content
    // match on the pre-write content). The seeded serve is an ordinary range
    // seat, and the evidence recorded BEFORE it still decides the comparison
    // after it - range seats stamp, they never reset.
    const witnesses = createImageWitnessStore();
    const source = "https://example.test/b.png";
    const pendingEntry = imageEntry("pending", source);
    const resolvedEntry = imageEntry("resolved", source);
    witnesses.record("a-w", pendingEntry);
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-w", [pendingEntry])],
      }),
      null,
      witnesses,
    );
    const applied = witnesses.record("a-w", resolvedEntry);
    const upserted = updateWindowMessage(
      seeded,
      "a-w",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, imageResolutions: [resolvedEntry] },
      null,
    );
    expect(upserted.held).toBe(true);
    witnesses.stampRewrittenCopies(upserted.window, "a-w", source, applied);

    const delayed = applyRangeResponse(
      upserted.window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-w", [pendingEntry])],
      }),
      null,
      witnesses,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-w",
    );
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.imageResolutions[0].state
        : "missing",
    ).toBe("resolved");
  });

  it("an unwitnessed write no longer holds the row - the serve stands", () => {
    // The same scenario without the witness: the held rewrite brings no
    // rule-2 evidence, the source sets match so rule 3 is silent, and rule 4
    // seats the serve. The refuted held-preference must not decide this -
    // repair rides the host's `updated` index entry (the write moved the
    // row's digest), which re-plans the ordinal and fetches current state.
    const witnesses = createImageWitnessStore();
    const source = "https://example.test/b.png";
    const pendingEntry = imageEntry("pending", source);
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-uw", [pendingEntry])],
      }),
      null,
      witnesses,
    );
    const upserted = updateWindowMessage(
      seeded,
      "a-uw",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, imageResolutions: [imageEntry("resolved", source)] },
      null,
    );
    expect(upserted.held).toBe(true);

    const delayed = applyRangeResponse(
      upserted.window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-uw", [pendingEntry])],
      }),
      null,
      witnesses,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-uw",
    );
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.imageResolutions[0].state
        : "missing",
    ).toBe("consent-required");
  });

  it("witnesses recorded while the record was unheld stamp its first hydration", () => {
    // The witness is evidence about the source's write stream, not the
    // client's holdings: both writes were recorded before the client held any
    // copy, so the first hydration stamps by unique content match and then
    // defeats a delayed serve carrying the older write.
    const witnesses = createImageWitnessStore();
    const source = "https://example.test/u.png";
    const older = imageEntry("pending", source);
    const newer = imageEntry("resolved", source);
    witnesses.record("a-fh", older);
    witnesses.record("a-fh", newer);
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-fh", [newer])],
      }),
      null,
      witnesses,
    );

    const delayed = applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-fh", [older])],
      }),
      null,
      witnesses,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-fh",
    );
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.imageResolutions[0].state
        : "missing",
    ).toBe("resolved");
  });

  it("an ambiguous content match stamps nothing, so the superset rule decides", () => {
    // W1(X), W2(Y), W3(X): the served copy's content X appears at TWO
    // retained occurrences, so matching it to "the newest occurrence" would
    // fabricate "served is later" (3 > 2), break dominance, and suppress the
    // superset verdict below. Ambiguity yields NO stamp instead: every
    // differing source goes silent, and rule 3 seats the held copy - it
    // strictly supersets the served source set within the current lineage.
    const witnesses = createImageWitnessStore();
    const s1 = "https://example.test/s1.png";
    const s2 = "https://example.test/s2.png";
    const x = imageEntry("pending", s1);
    const y = imageEntry("resolved", s1);
    const z = imageEntry("resolved", s2);
    witnesses.record("a-amb", x);
    witnesses.record("a-amb", y);
    witnesses.record("a-amb", x);
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-amb", [y, z])],
      }),
      null,
      witnesses,
    );

    const delayed = applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-amb", [x])],
      }),
      null,
      witnesses,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-amb",
    );
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.imageResolutions.map((entry) => entry.canonicalSource)
        : [],
    ).toEqual([s1, s2]);
  });

  it("superset evidence predating the record's lineage reset is directionless", () => {
    // Same comparison twice around a reset. Before: the held copy's strictly
    // larger source set wins at witness silence (upsert-only, so larger is
    // later). After `resetServedRecord` moves the record's lineage floor, the
    // identical evidence predates the record's last authoritative replacement
    // and rule 3 refuses it - a snapshot may legitimately re-establish the
    // record with a smaller set.
    const witnesses = createImageWitnessStore();
    const s1 = "https://example.test/s1.png";
    const s2 = "https://example.test/s2.png";
    const wide = [imageEntry("resolved", s1), imageEntry("resolved", s2)];
    const narrow = [imageEntry("resolved", s1)];
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-lin", wide)],
      }),
      null,
      witnesses,
    );

    const before = applyRangeResponse(
      seeded,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-lin", narrow)],
      }),
      null,
      witnesses,
    );
    const beforeRendered = hydratedRecords(before).messages.find(
      (message) => message.messageId === "a-lin",
    );
    expect(
      beforeRendered !== undefined && beforeRendered.role === "assistant"
        ? beforeRendered.imageResolutions.length
        : -1,
    ).toBe(2);

    witnesses.resetServedRecord("a-lin");
    const after = applyRangeResponse(
      before,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-lin", narrow)],
      }),
      null,
      witnesses,
    );
    const afterRendered = hydratedRecords(after).messages.find(
      (message) => message.messageId === "a-lin",
    );
    expect(
      afterRendered !== undefined && afterRendered.role === "assistant"
        ? afterRendered.imageResolutions.length
        : -1,
    ).toBe(1);
  });

  it("a snapshot serving a record clears its evidence, and only its", () => {
    // Per-record grain, pinned from both sides: M's rule-2 protection dies
    // with the snapshot that served M, while N's - whose record the snapshot
    // did not serve - survives and still rejects the delayed stale serve.
    const witnesses = createImageWitnessStore();
    const sm = "https://example.test/m.png";
    const sn = "https://example.test/n.png";
    const mOld = imageEntry("pending", sm);
    const mNew = imageEntry("resolved", sm);
    const nOld = imageEntry("pending", sn);
    const nNew = imageEntry("resolved", sn);
    witnesses.record("a-m", mOld);
    witnesses.record("a-n", nOld);
    let window = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5", "row-6"],
        messages: [
          settledWithImages("a-m", [mOld]),
          settledWithImages("a-n", [nOld]),
        ],
      }),
      null,
      witnesses,
    );
    const mApplied = witnesses.record("a-m", mNew);
    const mRewritten = updateWindowMessage(
      window,
      "a-m",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, imageResolutions: [mNew] },
      null,
    );
    witnesses.stampRewrittenCopies(mRewritten.window, "a-m", sm, mApplied);
    const nApplied = witnesses.record("a-n", nNew);
    const nRewritten = updateWindowMessage(
      mRewritten.window,
      "a-n",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, imageResolutions: [nNew] },
      null,
    );
    witnesses.stampRewrittenCopies(nRewritten.window, "a-n", sn, nApplied);
    window = nRewritten.window;

    // The snapshot serves M (and only M) in its tail.
    window = applyWindowedSnapshot(
      window,
      {
        epoch: 1,
        rowCount: 30,
        indexRevision: null,
        tail: {
          fromOrdinal: 29,
          messages: [settledWithImages("a-m", [mNew])],
          events: [],
        },
      },
      null,
      witnesses,
    );

    const delayed = applyRangeResponse(
      applyRangeResponse(
        window,
        rangeResponse({
          epoch: 1,
          fromOrdinal: 5,
          rowIds: ["row-5"],
          messages: [settledWithImages("a-m", [mOld])],
        }),
        null,
        witnesses,
      ),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 6,
        rowIds: ["row-6"],
        messages: [settledWithImages("a-n", [nOld])],
      }),
      null,
      witnesses,
    );

    // Read the SEAT decisions off the spans the delayed serves produced -
    // `hydratedRecords` dedupes to the freshest copy, and the snapshot's own
    // tail copy of M would mask what the row-5 seat decided.
    const seatedStateOf = (fromOrdinal: number, messageId: string): string => {
      const span = delayed.spans.find(
        (candidate) =>
          candidate.fromOrdinal <= fromOrdinal &&
          fromOrdinal < candidate.fromOrdinal + candidate.rowIds.length &&
          candidate.messageIds.includes(messageId),
      );
      const seated = (
        span !== undefined ? spanMessages(delayed, span) : []
      ).find((message) => message.messageId === messageId);
      return seated !== undefined && seated.role === "assistant"
        ? seated.imageResolutions[0].state
        : "missing";
    };
    // M: evidence cleared by the snapshot serve, comparison silent, the
    // delayed serve stands (repair rides the `updated` channel).
    expect(seatedStateOf(5, "a-m")).toBe("consent-required");
    // N: evidence intact, rule 2 rejects the delayed stale serve.
    expect(seatedStateOf(6, "a-n")).toBe("resolved");
  });

  it("the active turn's held copy substitutes with no witness evidence at all", () => {
    // Arm isolation: the active arm never consults the settled evidence
    // rules. The same unwitnessed rewrite that loses on the settled arm
    // survives here, because the stream is the active turn's authority and
    // only `heldCopyIsBehindServed` displaces it.
    const witnesses = createImageWitnessStore();
    const source = "https://example.test/act.png";
    const pendingEntry = imageEntry("pending", source);
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-act", [pendingEntry])],
      }),
      "t-a-act",
      witnesses,
    );
    const upserted = updateWindowMessage(
      seeded,
      "a-act",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, imageResolutions: [imageEntry("resolved", source)] },
      null,
    );
    expect(upserted.held).toBe(true);

    const delayed = applyRangeResponse(
      upserted.window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-act", [pendingEntry])],
      }),
      "t-a-act",
      witnesses,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-act",
    );
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.imageResolutions[0].state
        : "missing",
    ).toBe("resolved");
  });

  it("multi-source dominance survives alternating applies across two sources", () => {
    // Rule 2's held-wins arm requires EVERY differing source to carry a
    // held-later verdict (dominance). Before `carryRewrittenCopy`, each
    // `updateWindowMessage` rewrite minted a fresh record object and
    // `stampRewrittenCopies` seeded a BRAND NEW evidence map on it, discarding
    // whatever the previous object held - so alternating writes across two
    // sources (S1, S2, S1, S2) stranded the OTHER source's stamp at every
    // step, and by W4 only S2 carried a stamp at all. S1 then reads
    // `heldStamp` 0 - silent - which breaks dominance outright, and the
    // held-wins arm becomes unreachable for any record with two or more
    // differing sources. `carryRewrittenCopy` fixes this by copying the
    // discarded object's stamps onto its replacement at every swap, so each
    // rewrite's `stampRewrittenCopies` call only ever MERGES its one source's
    // stamp into what the carry already restored.
    const witnesses = createImageWitnessStore();
    const s1 = "https://example.test/dom-s1.png";
    const s2 = "https://example.test/dom-s2.png";
    const recordWith = (
      s1Entry: ImageResolutionEntry,
      s2Entry: ImageResolutionEntry,
    ): Extract<Message, { role: "assistant" }> => ({
      ...assistantMessage("a-dom", "t-a-dom", 5),
      blocksVersion: 3,
      imageResolutions: [s1Entry, s2Entry],
    });
    const rewriteBoth =
      (s1Entry: ImageResolutionEntry, s2Entry: ImageResolutionEntry) =>
      (message: Message): Message =>
        message.role !== "assistant"
          ? message
          : { ...message, imageResolutions: [s1Entry, s2Entry] };

    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [
          recordWith(versionedImageEntry(s1, 0), versionedImageEntry(s2, 0)),
        ],
      }),
      null,
      witnesses,
    );

    // W1(S1)
    const w1 = witnesses.record("a-dom", versionedImageEntry(s1, 1));
    const afterW1 = updateWindowMessage(
      seeded,
      "a-dom",
      rewriteBoth(versionedImageEntry(s1, 1), versionedImageEntry(s2, 0)),
      witnesses,
    );
    expect(afterW1.held).toBe(true);
    witnesses.stampRewrittenCopies(afterW1.window, "a-dom", s1, w1);

    // W2(S2)
    const w2 = witnesses.record("a-dom", versionedImageEntry(s2, 1));
    const afterW2 = updateWindowMessage(
      afterW1.window,
      "a-dom",
      rewriteBoth(versionedImageEntry(s1, 1), versionedImageEntry(s2, 1)),
      witnesses,
    );
    witnesses.stampRewrittenCopies(afterW2.window, "a-dom", s2, w2);

    // W3(S1)
    const w3 = witnesses.record("a-dom", versionedImageEntry(s1, 2));
    const afterW3 = updateWindowMessage(
      afterW2.window,
      "a-dom",
      rewriteBoth(versionedImageEntry(s1, 2), versionedImageEntry(s2, 1)),
      witnesses,
    );
    witnesses.stampRewrittenCopies(afterW3.window, "a-dom", s1, w3);

    // W4(S2)
    const w4 = witnesses.record("a-dom", versionedImageEntry(s2, 2));
    const afterW4 = updateWindowMessage(
      afterW3.window,
      "a-dom",
      rewriteBoth(versionedImageEntry(s1, 2), versionedImageEntry(s2, 2)),
      witnesses,
    );
    witnesses.stampRewrittenCopies(afterW4.window, "a-dom", s2, w4);

    // The delayed slice carries W1's S1 content and W2's S2 content - each
    // uniquely witnessed (versions 0/1/2 per source are each recorded exactly
    // once), so rule 2 has a servedStamp for both differing sources.
    const delayed = applyRangeResponse(
      afterW4.window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [
          recordWith(versionedImageEntry(s1, 1), versionedImageEntry(s2, 1)),
        ],
      }),
      null,
      witnesses,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-dom",
    );
    // The held copy (W3's S1 content, W4's S2 content) must win on BOTH
    // sources - the delayed, older slice must not displace either.
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.imageResolutions.map((entry) => entry.attachmentHash)
        : [],
    ).toEqual([
      versionedImageEntry(s1, 2).attachmentHash,
      versionedImageEntry(s2, 2).attachmentHash,
    ]);
  });

  it("a non-image rewrite carries the held copy's image evidence across the swap", () => {
    // W1(S1) stamps the held copy with an exact apply sequence. A LATER
    // rewrite that touches an unrelated field (`reasoningEffort`, never
    // `imageResolutions`) still swaps the record object - `updateWindowMessage`
    // always mints a new copy via spread - and before `carryRewrittenCopy`
    // that swap stranded W1's stamp on the discarded object: nothing re-seeds
    // evidence for a rewrite that is not itself a witnessed image apply, so
    // `heldStamp` reads 0 for S1 on the new object, rule 2 goes silent, and
    // dominance is unreachable. An unrelated edit (a block delta, a steer
    // remap) would then silently revert a correctly-applied image resolution
    // back to its pre-write state on the next delayed serve.
    const witnesses = createImageWitnessStore();
    const s1 = "https://example.test/nonimg.png";
    const preWrite = imageEntry("pending", s1);
    const postWrite = imageEntry("resolved", s1);
    // W0: witnessed BEFORE the seed, so the served (pre-write) side gets its
    // own exact stamp later - mirrors "witnesses recorded while the record
    // was unheld stamp its first hydration" above.
    witnesses.record("a-nonimg", preWrite);
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-nonimg", [preWrite])],
      }),
      null,
      witnesses,
    );

    // W1(S1): the witnessed image apply, exact stamp.
    const w1 = witnesses.record("a-nonimg", postWrite);
    const afterImageWrite = updateWindowMessage(
      seeded,
      "a-nonimg",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, imageResolutions: [postWrite] },
      witnesses,
    );
    expect(afterImageWrite.held).toBe(true);
    witnesses.stampRewrittenCopies(afterImageWrite.window, "a-nonimg", s1, w1);

    // A NON-image rewrite of the same record - `imageResolutions` untouched,
    // and no `witnesses.record`/`stampRewrittenCopies` call accompanies it,
    // exactly as a real block delta or metadata rewrite would not.
    const afterNonImageWrite = updateWindowMessage(
      afterImageWrite.window,
      "a-nonimg",
      (message) =>
        message.role !== "assistant"
          ? message
          : { ...message, reasoningEffort: "high" },
      witnesses,
    );
    expect(afterNonImageWrite.held).toBe(true);

    // The delayed slice serves the PRE-W1 content, uniquely witnessed by W0.
    const delayed = applyRangeResponse(
      afterNonImageWrite.window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5"],
        messages: [settledWithImages("a-nonimg", [preWrite])],
      }),
      null,
      witnesses,
    );

    const rendered = hydratedRecords(delayed).messages.find(
      (message) => message.messageId === "a-nonimg",
    );
    expect(
      rendered !== undefined && rendered.role === "assistant"
        ? rendered.imageResolutions[0].state
        : "missing",
    ).toBe("resolved");
  });

  it("protects every carry drawing the viewport, not just the first admitted", () => {
    // The soft budget exemption was positional: `carried.length > 0` spared
    // whichever contributing span sorted first and dropped the rest. A reader
    // whose viewport crosses TWO carries therefore lost the second - and
    // because `applyRangeResponse` rebalances the tier BEFORE
    // `evictTranscriptWindowToBudget` frees the cold fresh spans, that drop is
    // decided against a fresh tier only transiently over budget, and is never
    // reconsidered once capacity returns. The rows flash back to placeholders
    // until a refetch lands.
    //
    // Warmth cannot fix this: both spans are equally and legitimately warm.
    // Visibility has to be a protection of its own.
    const bulk = "x".repeat(Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.6));
    const first = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [messageWithText(userMessage("m-0", 0), bulk)],
      }),
      null,
      null,
    );
    // Disjoint, so `insertSpan` cannot merge them into one carry.
    const seeded = applyRangeResponse(
      first,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10"],
        messages: [messageWithText(userMessage("m-10", 10), bulk)],
      }),
      null,
      null,
    );
    // The reader is across both, reported before the rebase demotes them.
    const watching = touchTranscriptRange(seeded, {
      fromOrdinal: 0,
      toOrdinal: 11,
    });

    const rebased = applyWindowedSnapshot(
      watching,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: { fromOrdinal: 30, messages: [], events: [] },
      },
      null,
      null,
    );

    // Together they are 120% of the budget, so the second is exactly what the
    // positional exemption dropped.
    expect(rebased.staleSpans.map((span) => span.fromOrdinal)).toEqual([0, 10]);
    // And the viewport travelled across the void with them, so the next
    // rebalance protects them too.
    expect(rebased.visibleOrdinals).toEqual({ fromOrdinal: 0, toOrdinal: 11 });
  });

  it("keeps the freshest carry of a row an OLDER mixed span is warmer than", () => {
    // Warmth is per SPAN, ownership is per ROW, so the sort's primary key can
    // separate two duplicates before the serve stamp is consulted. A partial
    // refetch leaves an older carry holding one still-uncovered row beside a
    // freshly covered one; viewing the uncovered row makes that whole span
    // warmer than the newer span holding the other. It then sorts first,
    // claims both ids, and eliminates its own fresher owner - warmth earned by
    // a different row deciding this one.
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5", "row-6"],
        messages: [userMessage("row-5", 5), userMessage("row-6", 6)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: { fromOrdinal: 30, messages: [], events: [] },
      },
      null,
      null,
    );
    // The partial refetch: only `row-5` comes back, with a newer body. The
    // carry is now mixed - `row-5` covered by the fresh tier, `row-6` not.
    const refetched = applyRangeResponse(
      rebased,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 12,
        rowIds: ["row-5"],
        messages: [userMessage("row-5", 555)],
      }),
      null,
      null,
    );
    const named = applySkeletonChunk(refetched, {
      epoch: 2,
      fromOrdinal: 20,
      entries: [skeletonEntry("row-6", 20)],
      isFinal: false,
    });
    // Viewing `row-6` warms the CARRY only: the fresh span sits at ordinal 12,
    // outside this range, and `row-5` is drawn by the fresh tier so it earns
    // the carry nothing.
    const warm = touchTranscriptRange(named, {
      fromOrdinal: 20,
      toOrdinal: 21,
    });
    expect(spanTouchStamp(warm, warm.staleSpans[0])).toBeGreaterThan(
      spanTouchStamp(warm, warm.spans[0]),
    );
    // Single ownership ties the serve stamps: both tiers reference the ONE
    // "row-5" ledger entry, so neither can be "fresher served" than the other
    // for that row. The scoping the touch stamps prove is visible at the
    // ledger too - the bump reached ONLY the record backing the row the carry
    // draws in range, never the fresh-drawn neighbour it merely holds.
    expect(spanServeStamp(warm, warm.spans[0])).toBe(
      spanServeStamp(warm, warm.staleSpans[0]),
    );
    expect(warm.records.messages.get("row-6")?.touchedAt).toBe(warm.clock);
    expect(warm.records.messages.get("row-5")?.touchedAt).toBeLessThan(
      warm.clock,
    );

    // The next rebase weighs them against each other, warmest first.
    const carried = applyWindowedSnapshot(
      warm,
      {
        epoch: 3,
        rowCount: 30,
        indexRevision: null,
        tail: { fromOrdinal: 30, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(carried.staleSpans.map((span) => span.rowIds)).toEqual([
      ["row-5", "row-6"],
      ["row-5"],
    ]);
    expect(
      hydratedRecords(carried).messages.find(
        (message) => message.messageId === "row-5",
      )?.timestamp,
    ).toBe(555);
  });

  it("warms a shared row's one record and nothing beside it", () => {
    // The pre-ledger pin here - "only the freshest carry warms" - rested on
    // two carries holding two COPIES of the row, where only the fresher copy
    // would render. Single ownership dissolves that premise: both carries
    // reference the ONE ledger entry, seat it at the same named ordinal, and
    // render the same bytes, so warming the record moves every span drawing
    // it together - that is the record grain working, not a leak. What stays
    // pinned is the SCOPING: the bump reaches only the record backing the
    // viewed row, so the older carry's private "row-6" record earns nothing
    // from a viewport it is not in, and a later squeeze still sees its
    // exclusive holdings at their true temperature.
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 5,
        rowIds: ["row-5", "row-6"],
        messages: [userMessage("row-5", 5), userMessage("row-6", 6)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: { fromOrdinal: 30, messages: [], events: [] },
      },
      null,
      null,
    );
    const reserved = applyRangeResponse(
      rebased,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 12,
        rowIds: ["row-5"],
        messages: [userMessage("row-5", 555)],
      }),
      null,
      null,
    );
    const carried = applyWindowedSnapshot(
      reserved,
      {
        epoch: 3,
        rowCount: 30,
        indexRevision: null,
        tail: { fromOrdinal: 30, messages: [], events: [] },
      },
      null,
      null,
    );
    // `row-6` stays unnamed and off screen throughout, so the older carry has
    // nothing of its own to earn warmth from.
    const named = applySkeletonChunk(carried, {
      epoch: 3,
      fromOrdinal: 20,
      entries: [skeletonEntry("row-5", 20)],
      isFinal: false,
    });
    const before = named.staleSpans.map((span) => spanTouchStamp(named, span));

    const warm = touchTranscriptRange(named, {
      fromOrdinal: 20,
      toOrdinal: 21,
    });

    expect(spanTouchStamp(warm, warm.staleSpans[0])).toBeGreaterThan(before[0]);
    expect(spanTouchStamp(warm, warm.staleSpans[1])).toBeGreaterThan(before[1]);
    expect(warm.records.messages.get("row-5")?.touchedAt).toBe(warm.clock);
    expect(warm.records.messages.get("row-6")?.touchedAt).toBeLessThan(
      warm.clock,
    );
  });

  it("retires a stale span mixing a marker with a survivor once the skeleton completes", () => {
    // A tail the skeleton had only partly reached is seated on real ids AND
    // markers, so this span is subject to both retirement rules at once.
    // Keeping it for the survivor while treating the marker as permanently
    // unproven would pin it for the rest of the session - the same defect as
    // counting a deleted row as coverage still owed, reached from the other
    // side. The complete skeleton settles the marker exactly as it settles any
    // row it does not name.
    const announced = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: { fromOrdinal: 3, messages: [], events: [] },
      },
      null,
      null,
    );
    const partiallyNamed = applySkeletonChunk(announced, {
      epoch: 1,
      fromOrdinal: 1,
      entries: [skeletonEntry("row-1", 1)],
      isFinal: false,
    });
    const seeded = applyWindowedSnapshot(
      partiallyNamed,
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: {
          fromOrdinal: 1,
          messages: [userMessage("m-1", 1), userMessage("m-2", 2)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(seeded.spans[0].rowIds).toEqual(["row-1", ""]);

    const reindexed = applyIndexChange(seeded, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 1,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(reindexed.staleSpans).toHaveLength(1);

    const replacement = applySkeletonChunk(reindexed, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [skeletonEntry("row-1", 0)],
      isFinal: true,
    });
    // Still held: the span names a survivor, so the unnamed-span rule keeps it.
    expect(replacement.staleSpans).toHaveLength(1);

    const reserved = applyRangeResponse(
      replacement,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 0,
        rowIds: ["row-1"],
        messages: [userMessage("m-1-new", 0)],
      }),
      null,
      null,
    );

    expect(reserved.staleSpans).toEqual([]);
  });

  it("carries two positional stale spans that cover different ordinals", () => {
    // Both candidates are seated on the unverified-identity marker, so a
    // coverage set that folds the marker into the row-id space reads every
    // unresolved row as the SAME row: the warmest span is admitted, and every
    // other positional span reads as contributing nothing and is dropped
    // however disjoint the ordinals it covers.
    const first = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 20,
        indexRevision: null,
        tail: {
          fromOrdinal: 18,
          messages: [userMessage("m-18", 18), userMessage("m-19", 19)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(first.spans[0].rowIds).toEqual(["", ""]);

    const second = applyWindowedSnapshot(
      first,
      {
        epoch: 2,
        rowCount: 6,
        indexRevision: null,
        tail: {
          fromOrdinal: 4,
          messages: [userMessage("m-4", 4), userMessage("m-5", 5)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(second.spans[0].rowIds).toEqual(["", ""]);
    expect(second.staleSpans.map((span) => span.fromOrdinal)).toEqual([18]);

    // A second rebase before either positional tail resolved: the epoch-2 tail
    // is demoted beside the epoch-1 one, and they describe different rows.
    const third = applyWindowedSnapshot(
      second,
      {
        epoch: 3,
        rowCount: 7,
        indexRevision: null,
        tail: { fromOrdinal: 6, messages: [userMessage("m-6", 6)], events: [] },
      },
      null,
      null,
    );

    expect(third.staleSpans.map((span) => span.fromOrdinal)).toEqual([4, 18]);
    expect(
      hydratedRecords(third).messages.map((message) => message.messageId),
    ).toEqual(["m-4", "m-5", "m-6", "m-18", "m-19"]);
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
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("warm", 10)],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 28,
        rowIds: ["row-28", "row-29"],
        messages: [userMessage("tail", 28)],
      }),
      null,
      null,
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
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [userMessage("warmer", 0)],
      }),
      null,
      null,
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
        // The message's own id names its row (matching production), so the
        // touch below has a record to warm.
        messages: [userMessage("row-0", 0)],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("row-10", 10)],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 28,
        rowIds: ["row-28", "row-29"],
        messages: [userMessage("row-28", 28)],
      }),
      null,
      null,
    );

    // The reader is looking at the OLDEST-loaded span. Touching it must
    // reorder eviction, or scrolling up evicts exactly what is on screen.
    const oldSpan = window.spans.find((span) => span.fromOrdinal === 0);
    const oldTouchedAt =
      oldSpan !== undefined ? spanTouchStamp(window, oldSpan) : undefined;
    const touched = touchTranscriptRange(window, {
      fromOrdinal: 0,
      toOrdinal: 2,
    });
    const touchedSpan = touched.spans.find((span) => span.fromOrdinal === 0);
    expect(
      touchedSpan !== undefined
        ? spanTouchStamp(touched, touchedSpan)
        : undefined,
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
      null,
      null,
    );

    // The range is RECORDED even when it warms nothing, so the first report of
    // a new range is a new window - see the field. What must stay stable is
    // RESTING: a viewport that has not moved, over rows no span holds.
    const touched = touchTranscriptRange(window, {
      fromOrdinal: 20,
      toOrdinal: 22,
    });
    expect(touched).not.toBe(window);
    expect(touched.spans).toBe(window.spans);
    expect(touched.clock).toBe(window.clock);

    const resting = touchTranscriptRange(touched, {
      fromOrdinal: 20,
      toOrdinal: 22,
    });
    expect(resting).toBe(touched);
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
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("visible", 10)],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 28,
        rowIds: ["row-28", "row-29"],
        messages: [userMessage("tail", 28)],
      }),
      null,
      null,
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
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [userMessage("cold", 10)],
      }),
      null,
      null,
    );

    // Nothing visible, so only the tail rule and the required rule can save a
    // span - and ordinal 0's span is the coldest by insertion order.
    const evicted = evictTranscriptWindowToBudget(window, 1, null, [0]);
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([0]);
  });
});

describe("the record ledger", () => {
  it("accepts staying over budget rather than dropping a protected span, and resets the terminal once a later evict lands under budget", () => {
    // A single span whose end touches `rowCount` is the tail - exempt from
    // eviction outright - so a window that is over budget with NOTHING else
    // to drop cannot make progress. That is not a bug to paper over: the
    // terminal names it so a caller can tell "nothing evictable was over
    // budget" apart from "eviction ran and still could not fit", which is
    // `evictionTerminal`'s whole reason to exist.
    const huge = messageWithText(
      userMessage("m-huge1", 0),
      "x".repeat(TRANSCRIPT_WINDOW_MAX_BYTES + 4096),
    );
    const window = applyRangeResponse(
      windowWithSkeleton(2),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [huge],
      }),
      null,
      null,
    );
    expect(window.hydratedBytes).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX_BYTES);

    const evicted = evictTranscriptWindowToBudget(
      window,
      TRANSCRIPT_WINDOW_MAX_BYTES,
      null,
      [],
    );
    // Nothing was dropped - the tail span is the only span there is.
    expect(evicted.spans).toEqual(window.spans);
    expect(evicted.hydratedBytes).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX_BYTES);
    expect(evicted.evictionTerminal).toBe("over-budget-accepted");

    // The reset: a later evict that DOES land under budget must not leave the
    // stale terminal standing, or a caller reading it after the window
    // recovered would keep reporting a squeeze that is long over.
    const recovered = evictTranscriptWindowToBudget(
      evicted,
      evicted.hydratedBytes,
      null,
      [],
    );
    expect(recovered.evictionTerminal).toBe("none");
  });

  it("names the alias-group as unbreakable when the only unprotected span's every record is shared with the protected tail", () => {
    // The cold span at ordinal 0 holds nothing of its own - its one record IS
    // the tail's record, re-served under the same id. Evicting it alone saves
    // nothing (the tail still references the record), and its alias closure
    // reaches the tail, so the closure can never be evicted either. That is a
    // DIFFERENT terminal from "over-budget-accepted": a caller that treated
    // the two alike could not tell a genuine leak (a closure that keeps
    // growing) from the ordinary tail exemption.
    const shared = "x".repeat(TRANSCRIPT_WINDOW_MAX_BYTES + 4096);
    const window = applyRangeResponse(
      applyRangeResponse(
        windowWithSkeleton(6),
        rangeResponse({
          epoch: 1,
          fromOrdinal: 4,
          rowIds: ["row-4", "row-5"],
          messages: [messageWithText(userMessage("m-shared2", 4), shared)],
        }),
        null,
        null,
      ),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        // Same record id as the tail's - this span's ENTIRE reference set is
        // shared, so its own `contextBytes` and exclusive records are both
        // zero.
        messages: [messageWithText(userMessage("m-shared2", 0), shared)],
      }),
      null,
      null,
    );
    expect(window.hydratedBytes).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX_BYTES);

    const evicted = evictTranscriptWindowToBudget(
      window,
      TRANSCRIPT_WINDOW_MAX_BYTES,
      null,
      [],
    );
    // Both spans survive - the cold one is not evicted, because doing so
    // frees nothing while the tail still names the record.
    expect(evicted.spans).toHaveLength(2);
    expect(evicted.hydratedBytes).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX_BYTES);
    expect(evicted.evictionTerminal).toBe("alias-group-unbreakable");
  });

  it("evicts an alias closure of two unprotected spans as one unit, and prunes the shared record only once both are gone", () => {
    // Neither cold span has a positive marginal saving alone - each holds
    // ONLY the record they share, so evicting either alone frees nothing
    // (the other still references it). Unlike the previous case, nothing
    // protected sits in their closure, so the pair is evictable as a UNIT -
    // the case `aliasClosure` exists to handle rather than leaving the window
    // permanently over budget.
    const shared = "x".repeat(Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 1.1));
    const sharedMessage = messageWithText(userMessage("m-shared3", 0), shared);
    let window = windowWithSkeleton(20);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [sharedMessage],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 8,
        rowIds: ["row-8", "row-9"],
        messages: [{ ...sharedMessage, messageId: "m-shared3" }],
      }),
      null,
      null,
    );
    // A small protected tail keeps the window's only other span alive so the
    // closure is genuinely the sole eviction candidate.
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 18,
        rowIds: ["row-18", "row-19"],
        messages: [userMessage("row-18", 18)],
      }),
      null,
      null,
    );
    expect(window.spans).toHaveLength(3);
    expect(window.hydratedBytes).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX_BYTES);

    const sharedBytes = recordByteLength(sharedMessage);
    const evicted = evictTranscriptWindowToBudget(
      window,
      TRANSCRIPT_WINDOW_MAX_BYTES,
      null,
      [],
    );
    // Only the protected tail remains.
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([18]);
    // The union saving is exactly the shared record's bytes, charged once -
    // neither span had any exclusive bytes of its own.
    expect(window.hydratedBytes - evicted.hydratedBytes).toBe(sharedBytes);
    // Reference-counted release: with both holders gone, the ledger entry is
    // reclaimed rather than lingering as unreferenced memory.
    expect(evicted.records.messages.has("m-shared3")).toBe(false);
    expect(evicted.evictionTerminal).toBe("none");
  });

  it("charges an evicted span's marginal saving exactly, and re-evaluates it after each drop - never trusting an alias's bytes as savings until it is truly the last holder", () => {
    // Spans A (ordinal 0) and B (ordinal 10) each hold their own exclusive
    // record plus a big record they SHARE; a tiny protected tail (ordinal 18)
    // anchors the window. A's marginal saving alone is only its exclusive
    // record plus its own context - the shared record is not freed by
    // dropping A while B still names it. Sized so that saving alone is NOT
    // enough to reach budget: a correct pass must re-derive B's saving AFTER
    // A is gone (when the shared record becomes B's alone to free) and drop
    // B too. A pass that credited A with the shared record's bytes up front
    // would believe the budget was already met and stop after A, leaving the
    // window well over the budget it was asked to reach - the exact failure
    // mode `messageRefs` is maintained incrementally to prevent.
    const sharedText = "s".repeat(4 * 1024 * 1024);
    const exclusiveTextA = "a".repeat(5000);
    const exclusiveTextB = "b".repeat(5000);
    let window = windowWithSkeleton(20);
    window = applyRangeResponse(
      window,
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [
            messageWithText(userMessage("m-excl4a", 0), exclusiveTextA),
            messageWithText(userMessage("m-shared4", 0), sharedText),
          ],
        }),
        rowContext: { "row-0": { legacyRowAnchorAt: 4321 } },
      },
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10", "row-11"],
        messages: [
          messageWithText(userMessage("m-excl4b", 10), exclusiveTextB),
          { ...messageWithText(userMessage("m-shared4", 10), sharedText) },
        ],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 18,
        rowIds: ["row-18", "row-19"],
        messages: [userMessage("row-18", 18)],
      }),
      null,
      null,
    );
    expect(window.spans.map((span) => span.fromOrdinal)).toEqual([0, 10, 18]);

    const spanA = window.spans.find((span) => span.fromOrdinal === 0);
    const spanB = window.spans.find((span) => span.fromOrdinal === 10);
    const tailSpan = window.spans.find((span) => span.fromOrdinal === 18);
    expect(spanA).toBeDefined();
    expect(spanB).toBeDefined();
    expect(tailSpan).toBeDefined();
    const exclusiveA = window.records.messages.get("m-excl4a")?.record;
    const exclusiveB = window.records.messages.get("m-excl4b")?.record;
    const shared = window.records.messages.get("m-shared4")?.record;
    expect(exclusiveA).toBeDefined();
    expect(exclusiveB).toBeDefined();
    expect(shared).toBeDefined();
    const expectedDrop =
      (exclusiveA !== undefined ? recordByteLength(exclusiveA) : 0) +
      (exclusiveB !== undefined ? recordByteLength(exclusiveB) : 0) +
      (shared !== undefined ? recordByteLength(shared) : 0) +
      (spanA !== undefined ? spanA.contextBytes : 0);

    // The budget only the protected tail's own charge can satisfy: reaching
    // it requires BOTH A and B to go, since A's marginal saving alone (its
    // exclusive record plus its context) is nowhere near the ~4 MiB the
    // shared record contributes.
    const budget =
      tailSpan !== undefined ? spanChargeBytes(window, tailSpan) : 0;
    const evicted = evictTranscriptWindowToBudget(window, budget, null, []);

    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([18]);
    expect(window.hydratedBytes - evicted.hydratedBytes).toBe(expectedDrop);
    expect(evicted.evictionTerminal).toBe("none");
    // Both exclusive records and the shared one are gone - the reference-
    // counted release once the last holder drops.
    expect(evicted.records.messages.has("m-excl4a")).toBe(false);
    expect(evicted.records.messages.has("m-excl4b")).toBe(false);
    expect(evicted.records.messages.has("m-shared4")).toBe(false);
  });

  it("charges a record shared across three carries once at a rebase, and once more across the fresh/stale boundary after one carry is re-served", () => {
    // All three ranges below name the SAME extra message id ("m-shared5"), so
    // a rebase demotes all three spans to stale in ONE `boundedStaleSpans`
    // pass whose per-record dedupe (`chargedIds`) starts from nothing - the
    // three-way sharing is entirely this pass's problem. Sized so the three
    // fit together only if the shared record is billed ONCE: correctly
    // deduped they total comfortably under budget, but charging the shared
    // record again for each candidate that still names it pushes the total
    // well over - which a chargedIds bug that skipped the membership check
    // would do, and it would surface as the coldest carry silently failing to
    // be admitted rather than as a thrown error.
    const sharedText = "s".repeat(
      Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.34),
    );
    const exclusiveText1 = "e".repeat(
      Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.3),
    );
    const exclusiveText2 = "f".repeat(
      Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.3),
    );
    let window = windowWithSkeleton(20);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [
          userMessage("row-0", 0),
          messageWithText(userMessage("m-shared5", 0), sharedText),
        ],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10"],
        messages: [
          messageWithText(userMessage("row-10", 10), exclusiveText1),
          messageWithText(userMessage("m-shared5", 10), sharedText),
        ],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 15,
        rowIds: ["row-15"],
        messages: [
          messageWithText(userMessage("row-15", 15), exclusiveText2),
          messageWithText(userMessage("m-shared5", 15), sharedText),
        ],
      }),
      null,
      null,
    );
    expect(window.spans).toHaveLength(3);

    const rebased = applyWindowedSnapshot(
      window,
      {
        epoch: 2,
        rowCount: 20,
        indexRevision: null,
        tail: { fromOrdinal: 20, messages: [], events: [] },
      },
      null,
      null,
    );
    // All three carried: correctly deduped, SHARED + EXCLUSIVE_1 +
    // EXCLUSIVE_2 fits; a triple charge of SHARED would not.
    expect(rebased.staleSpans.map((span) => span.fromOrdinal)).toEqual([
      0, 10, 15,
    ]);

    // Re-serve the shared-only row fresh under the new epoch. Its span now
    // draws "m-shared5" from the FRESH tier; the other two carries still name
    // it too, so keeping BOTH is the cross-tier half of the identical dedupe
    // - seeded this time from the fresh tier's own references rather than
    // from nothing.
    const reserved = applyRangeResponse(
      rebased,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [
          userMessage("row-0", 0),
          messageWithText(userMessage("m-shared5", 0), sharedText),
        ],
      }),
      null,
      null,
    );
    expect(reserved.staleSpans.map((span) => span.fromOrdinal)).toEqual([
      10, 15,
    ]);
  });

  it("keeps two spans apart when the tail's row grew past the merge cap while streaming, and merges them when it did not", () => {
    // The merge ceiling must read the record's TRUE current size, not the
    // ledger's settled `bytes` figure - `streamWindowMessage` leaves that
    // figure stale BY DESIGN (see `unsettledByteMessageIds`), so a ceiling
    // that trusted it would let the tail absorb a neighbour into one span far
    // past `SPAN_MERGE_MAX_BYTES`, exactly the unbounded-tail hazard the cap
    // exists to prevent.
    const grow = (message: Message): Message =>
      messageWithText(
        message,
        "g".repeat(Math.ceil(SPAN_MERGE_MAX_BYTES * 1.5)),
      );
    const seedTail = (): TranscriptWindow =>
      applyRangeResponse(
        windowWithSkeleton(30),
        rangeResponse({
          epoch: 1,
          fromOrdinal: 28,
          rowIds: ["row-28", "row-29"],
          messages: [userMessage("m-tail6", 28)],
        }),
        null,
        null,
      );
    const withAdjacent = (window: TranscriptWindow): TranscriptWindow =>
      applyRangeResponse(
        window,
        rangeResponse({
          epoch: 1,
          fromOrdinal: 26,
          rowIds: ["row-26", "row-27"],
          messages: [userMessage("m-adjacent6", 26)],
        }),
        null,
        null,
      );

    // Control: nothing grew, so the settled figure is the true one and the
    // adjacent response merges as usual.
    const merged = withAdjacent(seedTail());
    expect(merged.spans).toHaveLength(1);

    // The tail's row streams far past the cap with its charge DEFERRED.
    const grown = streamWindowMessage(seedTail(), "m-tail6", grow, null).window;
    const stayedApart = withAdjacent(grown);
    expect(stayedApart.spans).toHaveLength(2);
  });

  it("keeps a shared record charged only while a span still references it, and prunes it once the last one is evicted", () => {
    // Two cold spans (ordinals 0 and 8) hold their own exclusive record plus
    // one they share; a small protected tail (ordinal 18) keeps the window
    // itself alive across two separate squeezes. The first squeeze can only
    // afford to drop the coldest (ordinal 0) - the shared record must survive
    // that, because ordinal 8's span still draws it and still has to render.
    // Only the second squeeze, which drops the last holder, may reclaim it.
    const sharedText = "s".repeat(50_000);
    let window = windowWithSkeleton(20);
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0", "row-1"],
        messages: [
          messageWithText(userMessage("row-0", 0), "own-c".repeat(2000)),
          messageWithText(userMessage("m-s7", 0), sharedText),
        ],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 8,
        rowIds: ["row-8", "row-9"],
        messages: [
          messageWithText(userMessage("row-8", 8), "own-d".repeat(2000)),
          { ...messageWithText(userMessage("m-s7", 8), sharedText) },
        ],
      }),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 18,
        rowIds: ["row-18", "row-19"],
        messages: [userMessage("row-18", 18)],
      }),
      null,
      null,
    );
    expect(window.spans.map((span) => span.fromOrdinal)).toEqual([0, 8, 18]);

    const afterFirstSqueeze = evictTranscriptWindowToBudget(
      window,
      window.hydratedBytes - 1,
      null,
      [],
    );
    expect(afterFirstSqueeze.spans.map((span) => span.fromOrdinal)).toEqual([
      8, 18,
    ]);
    // The shared record survives - span D still draws it, and it still
    // renders D's row from the surviving ledger entry.
    expect(afterFirstSqueeze.records.messages.has("m-s7")).toBe(true);
    const survivingD = afterFirstSqueeze.spans.find(
      (span) => span.fromOrdinal === 8,
    );
    expect(survivingD).toBeDefined();
    expect(
      survivingD !== undefined
        ? spanMessages(afterFirstSqueeze, survivingD).map(
            (message) => message.messageId,
          )
        : [],
    ).toContain("m-s7");
    expect(
      hydratedRecords(afterFirstSqueeze).messages.map(
        (message) => message.messageId,
      ),
    ).toContain("m-s7");

    // Second squeeze: now span D is the only unprotected, cold span, and
    // dropping it is the last reference to "m-s7".
    const afterSecondSqueeze = evictTranscriptWindowToBudget(
      afterFirstSqueeze,
      afterFirstSqueeze.hydratedBytes - 1,
      null,
      [],
    );
    expect(afterSecondSqueeze.spans.map((span) => span.fromOrdinal)).toEqual([
      18,
    ]);
    expect(afterSecondSqueeze.records.messages.has("m-s7")).toBe(false);
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
        null,
        null,
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
    expect(
      tailSpan !== undefined ? spanChargeBytes(window, tailSpan) : undefined,
    ).toBeLessThanOrEqual(SPAN_MERGE_MAX_BYTES);
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
      null,
      null,
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
      null,
      null,
    );
    const window = appendLiveRecords(seeded, {
      messages: [userMessage("m-live", 9)],
      events: [],
    });

    const hydrated = updateWindowMessage(
      window,
      "m-0",
      (message) => ({
        ...message,
        timestamp: 111,
      }),
      null,
    );
    expect(hydrated.held).toBe(true);
    expect(
      spanMessages(hydrated.window, hydrated.window.spans[0])[0].timestamp,
    ).toBe(111);

    const live = updateWindowMessage(
      hydrated.window,
      "m-live",
      (message) => ({
        ...message,
        timestamp: 222,
      }),
      null,
    );
    expect(live.held).toBe(true);
    expect(live.window.liveMessages[0].timestamp).toBe(222);

    // Outside the window entirely. `held: false` is not an error - it is the
    // case the caller answers by dropping the change and letting hydration
    // serve the host's own version.
    const absent = updateWindowMessage(
      live.window,
      "m-nowhere",
      (message) => ({
        ...message,
        timestamp: 333,
      }),
      null,
    );
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
      null,
      null,
    );
    // The from-scratch recompute this pins the incremental `hydratedBytes`
    // delta against: every record referenced by a FRESH span, deduped, plus
    // each fresh span's structural bytes (0 in this fixture - no
    // `rowContext`) - i.e. `freshTierBytes` reimplemented from the public
    // ledger shape rather than imported, since that helper is not exported.
    const freshBytesFromLedger = (window: TranscriptWindow): number => {
      const messageIds = new Set<string>();
      const eventIds = new Set<string>();
      for (const span of window.spans) {
        for (const id of span.messageIds) messageIds.add(id);
        for (const id of span.eventIds) eventIds.add(id);
      }
      let bytes = 0;
      for (const id of messageIds) {
        bytes += window.records.messages.get(id)?.bytes ?? 0;
      }
      for (const id of eventIds) {
        bytes += window.records.events.get(id)?.bytes ?? 0;
      }
      for (const span of window.spans) bytes += span.contextBytes;
      return bytes;
    };

    const seededBytes = seeded.records.messages.get("m-0")?.bytes;

    const grown = updateWindowMessage(
      seeded,
      "m-0",
      (message) => messageWithText(message, "a much longer body ".repeat(40)),
      null,
    );
    expect(grown.held).toBe(true);
    const grownEntry = grown.window.records.messages.get("m-0");
    expect(grownEntry?.bytes).toBe(
      grownEntry !== undefined
        ? recordByteLength(grownEntry.record)
        : undefined,
    );
    // And it moved: an incremental charge that silently did nothing would also
    // satisfy an equality written against a record that never changed.
    expect(grownEntry?.bytes).toBeGreaterThan(seededBytes ?? -1);
    expect(grown.window.hydratedBytes).toBe(freshBytesFromLedger(grown.window));

    const shrunk = updateWindowMessage(
      grown.window,
      "m-0",
      (message) => messageWithText(message, "x"),
      null,
    );
    const shrunkEntry = shrunk.window.records.messages.get("m-0");
    expect(shrunkEntry?.bytes).toBe(
      shrunkEntry !== undefined
        ? recordByteLength(shrunkEntry.record)
        : undefined,
    );
    expect(shrunkEntry?.bytes).toBeLessThan(grownEntry?.bytes ?? Infinity);
    expect(shrunk.window.hydratedBytes).toBe(
      freshBytesFromLedger(shrunk.window),
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
      null,
      null,
    );
    return applyRangeResponse(
      window,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 29,
        rowIds: ["row-29"],
        messages: [userMessage("live", 29)],
      }),
      null,
      null,
    );
  }

  it("leaves the figure alone while streaming, and names the row it owes", () => {
    const seeded = windowWithColdAndTail();
    const streamed = streamWindowMessage(
      seeded,
      "live",
      (message) => messageWithText(message, "streamed body ".repeat(200)),
      null,
    );

    expect(streamed.held).toBe(true);
    // The row grew; the figure deliberately did not move.
    expect(streamed.window.hydratedBytes).toBe(seeded.hydratedBytes);
    expect(streamed.window.unsettledByteMessageIds).toEqual(["live"]);
  });

  it("settles to the same number an exact charge would have reached", () => {
    const seeded = windowWithColdAndTail();
    const text = "streamed body ".repeat(200);
    const deferred = streamWindowMessage(
      seeded,
      "live",
      (message) => messageWithText(message, text),
      null,
    );
    const exact = updateWindowMessage(
      seeded,
      "live",
      (message) => messageWithText(message, text),
      null,
    );

    const settled = settleWindowBytes(deferred.window);
    expect(settled.hydratedBytes).toBe(exact.window.hydratedBytes);
    expect(settled.unsettledByteMessageIds).toEqual([]);
  });

  it("does not name the same row twice across a turn's worth of deltas", () => {
    let window = windowWithColdAndTail();
    for (let index = 0; index < 50; index += 1) {
      window = streamWindowMessage(
        window,
        "live",
        (message) => messageWithText(message, `body ${index}`),
        null,
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
    const streamed = streamWindowMessage(
      seeded,
      "live",
      (message) => messageWithText(message, "streamed body ".repeat(200)),
      null,
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
    const streamed = streamWindowMessage(
      seeded,
      "live",
      (message) => messageWithText(message, "a bit more"),
      null,
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

  it("re-bounds the stale tier when a streamed copy grows it past the shared budget", () => {
    // The stale tier is bounded where it is BUILT, and that holds only while
    // its spans keep their size. They do not: a rebase can leave the ACTIVE
    // turn's row held only by a stale copy, and every delta grows that copy.
    // `evictTranscriptWindowToBudget` judges `hydratedBytes`, which is the
    // FRESH tier, so without a bound at settlement the carry stays over budget
    // for the rest of the turn.
    const bulk = "x".repeat(Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.55));
    // The streaming row is seated FIRST, so the idle row is the warmer of the
    // two by seat order. Only the rewrite makes the streaming span the warmest
    // - and it has to, because warmth is the one thing that speaks for a stale
    // span when the budget squeezes.
    const withStream = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10"],
        messages: [userMessage("m-stream", 10)],
      }),
      null,
      null,
    );
    const seeded = applyRangeResponse(
      withStream,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [messageWithText(userMessage("m-idle", 0), bulk)],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      seeded,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: {
          fromOrdinal: 29,
          messages: [userMessage("m-29", 29)],
          events: [],
        },
      },
      null,
      null,
    );
    // Both carried: each fits the budget on its own, and together they still
    // do until the streamed row grows.
    expect(rebased.staleSpans.map((span) => span.fromOrdinal)).toEqual([0, 10]);

    const streamed = streamWindowMessage(
      rebased,
      "m-stream",
      (message) => messageWithText(message, bulk),
      null,
    );
    // Deferred by construction, so the figure is not yet true and the bound
    // deliberately has nothing to act on.
    expect(streamed.window.staleSpans).toHaveLength(2);

    const settled = settleWindowBytes(streamed.window);

    // Settling is where the figure becomes true, so it is the first moment the
    // shared budget can be judged - and the streamed copy is what survives it.
    expect(settled.staleSpans.map((span) => span.fromOrdinal)).toEqual([10]);
    expect(
      hydratedRecords(settled).messages.map((message) => message.messageId),
    ).toEqual(["m-stream", "m-29"]);
  });

  it("carries live events across a void", () => {
    // `provisionalLiveEventsForSnapshot` already states the rule for this
    // question: an INVALIDATING transition retains what the client holds live.
    // A void sets `invalidated` itself, so it is the most invalidating
    // transition there is - and it was the one path answering differently, so
    // a setup card, forked-chat link or stopped-turn row that had arrived live
    // and owned no ordinal yet was discarded and stayed gone until the
    // replacement index named it.
    const seeded = appendLiveRecords(windowWithSkeleton(10), {
      messages: [],
      events: [event("evt-live", 5)],
    });
    expect(seeded.liveEvents).toHaveLength(1);

    const voided = applyIndexChange(seeded, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 10,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    expect(voided.invalidated).toBe(true);
    expect(voided.liveEvents.map((entry) => entry.eventId)).toEqual([
      "evt-live",
    ]);
  });

  it("drops live events when the void's authority says no rows remain", () => {
    // The other half, and the reason this is gated rather than unconditional:
    // a zero-row authority says those rows no longer exist, so retaining what
    // would render them publishes deleted history.
    const seeded = appendLiveRecords(windowWithSkeleton(10), {
      messages: [],
      events: [event("evt-live", 5)],
    });

    const voided = applyIndexChange(seeded, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 0,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });

    expect(voided.liveEvents).toEqual([]);
  });

  it("keeps the warmest carry when the fresh tier alone is over budget", () => {
    // The fresh tier sits over budget between a seat and the eviction that
    // answers it - and STAYS over for as long as protected spans alone exceed
    // the limit, since eviction is deliberately soft against those. A hard
    // headroom test fails for every candidate in that state, so the entire
    // carry is discarded to make room for fresh spans that are themselves
    // about to be evicted. What goes first is what warmth ranks highest,
    // which is arranged to be the span being read or streamed - so the rows
    // on screen are the ones that flash back to placeholders.
    const bulk = "x".repeat(Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.6));
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10"],
        messages: [userMessage("m-carry", 10)],
      }),
      null,
      null,
    );
    const rebased = applySkeletonChunk(
      applyWindowedSnapshot(
        seeded,
        {
          epoch: 2,
          rowCount: 30,
          indexRevision: null,
          tail: {
            fromOrdinal: 29,
            messages: [userMessage("m-29", 29)],
            events: [],
          },
        },
        null,
        null,
      ),
      {
        epoch: 2,
        fromOrdinal: 0,
        entries: skeletonEntries(0, 30),
        isFinal: true,
      },
    );
    expect(rebased.staleSpans.map((span) => span.fromOrdinal)).toEqual([10]);

    // Two large off-screen ranges land before eviction runs. Neither covers
    // row 10, so the carry is still the only copy of that row.
    const overBudget = [0, 20].reduce(
      (window, fromOrdinal) =>
        applyRangeResponse(
          window,
          rangeResponse({
            epoch: 2,
            fromOrdinal,
            rowIds: [`row-${fromOrdinal}`],
            messages: [
              messageWithText(
                userMessage(`m-${fromOrdinal}`, fromOrdinal),
                bulk,
              ),
            ],
          }),
          null,
          null,
        ),
      rebased,
    );
    expect(overBudget.hydratedBytes).toBeGreaterThan(
      TRANSCRIPT_WINDOW_MAX_BYTES,
    );

    expect(overBudget.staleSpans.map((span) => span.fromOrdinal)).toEqual([10]);
    expect(
      hydratedRecords(overBudget).messages.map((message) => message.messageId),
    ).toContain("m-carry");
  });

  it("carries a deferred figure's debt across a rebase, unsettled", () => {
    // `unsettledByteMessageIds` records what still owes a measurement. A
    // "settle-before-carry" pass USED to run here - the windows a carry feeds
    // are rebuilt from `emptyTranscriptWindow()`, so the marker itself could
    // not survive the transition, and settling eagerly was the only way the
    // carried figure stayed correct. Class E retired that pass:
    // `retainLedgerForSpans` now carries the ledger entry AND the
    // `unsettledByteMessageIds` marker through a rebase exactly as it does
    // through a void (see `voidedTranscriptWindow`), so the debt survives
    // instead of being paid at the boundary. The carried figure is still
    // correct either way - `spanChargeBytes` re-measures an unsettled record
    // live - so this pins that the debt rides along, not that it disappears.
    const bulk = "x".repeat(Math.ceil(TRANSCRIPT_WINDOW_MAX_BYTES * 0.6));
    const seeded = applyRangeResponse(
      windowWithSkeleton(30),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 10,
        rowIds: ["row-10"],
        messages: [userMessage("m-stream", 10)],
      }),
      null,
      null,
    );
    const streamed = streamWindowMessage(
      seeded,
      "m-stream",
      (message) => messageWithText(message, bulk),
      null,
    );
    expect(streamed.window.unsettledByteMessageIds).toEqual(["m-stream"]);

    // The figure this span WOULD have carried had it been settled in place.
    // Pinned as an equality against that, not as "larger than before": the
    // understated value is also larger than zero.
    const settledWindow = settleWindowBytes(streamed.window);
    const settledInPlace = settledWindow.spans.find(
      (span) => span.fromOrdinal === 10,
    );
    const settledInPlaceBytes =
      settledInPlace !== undefined
        ? spanChargeBytes(settledWindow, settledInPlace)
        : undefined;
    const rebased = applyWindowedSnapshot(
      streamed.window,
      {
        epoch: 2,
        rowCount: 30,
        indexRevision: null,
        tail: {
          fromOrdinal: 29,
          messages: [userMessage("m-29", 29)],
          events: [],
        },
      },
      null,
      null,
    );

    expect(rebased.unsettledByteMessageIds).toEqual(["m-stream"]);
    const rebasedStale = rebased.staleSpans.find(
      (span) => span.fromOrdinal === 10,
    );
    expect(
      rebasedStale !== undefined
        ? spanChargeBytes(rebased, rebasedStale)
        : undefined,
    ).toBe(settledInPlaceBytes);
  });

  it("re-measures a stale copy a remap rewrote", () => {
    // `boundedStaleSpans` trusts `span.bytes`, so a remap that rewrites the
    // stale records and leaves the figure behind puts the carry's share of the
    // shared budget out by whatever the rewrite changed. Pinned as an equality
    // against the same growth applied BEFORE the demotion, where the seat
    // measured it: "bigger than before" would pass on any charge at all.
    const grow = (message: Message): Message =>
      message.messageId === "m-0"
        ? messageWithText(message, "grown body ".repeat(400))
        : message;
    const seeded = applyRangeResponse(
      windowWithSkeleton(10),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-0"],
        messages: [userMessage("m-0", 0)],
      }),
      null,
      null,
    );
    const rebase = (window: TranscriptWindow): TranscriptWindow =>
      applyWindowedSnapshot(
        window,
        {
          epoch: 2,
          rowCount: 10,
          indexRevision: null,
          tail: {
            fromOrdinal: 9,
            messages: [userMessage("m-9", 9)],
            events: [],
          },
        },
        null,
        null,
      );

    const grownWhileFresh = rebase(mapWindowMessages(seeded, grow, null));
    const grownWhileStale = mapWindowMessages(rebase(seeded), grow, null);
    const rebasedSeeded = rebase(seeded);

    expect(
      spanChargeBytes(grownWhileStale, grownWhileStale.staleSpans[0]),
    ).toBe(spanChargeBytes(grownWhileFresh, grownWhileFresh.staleSpans[0]));
    expect(
      spanChargeBytes(grownWhileStale, grownWhileStale.staleSpans[0]),
    ).toBeGreaterThan(
      spanChargeBytes(rebasedSeeded, rebasedSeeded.staleSpans[0]),
    );
  });
});

describe("holdsEveryRecordFrom", () => {
  /**
   * 30 rows: a cold span at the top (0-4) and a live tail (25-29), with a
   * 20-row hole between them. The shape a reader who scrolled back to the
   * start of a long chat is actually in.
   */
  function splitWindow(): TranscriptWindow {
    const seeded = applyWindowedSnapshot(
      windowWithSkeleton(30),
      {
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
      },
      null,
      null,
    );
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
      null,
      null,
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
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: {
          fromOrdinal: 0,
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
        },
      },
      null,
      null,
    );
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
    const stale = applyRangeResponse(
      windowWithSkeleton(10),
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [
            messageWithText(userMessage("row-0", 1), "stale"),
            userMessage("row-1", 2),
          ],
        }),
      },
      null,
      null,
    );
    // A later response under the same epoch, overlapping ordinal 0 with an
    // updated body - the shape a reconnect's authoritative tail produces.
    const merged = applyRangeResponse(
      stale,
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [
            messageWithText(userMessage("row-0", 1), "fresh"),
            userMessage("row-1", 2),
          ],
        }),
      },
      null,
      null,
    );
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: {
          fromOrdinal: 2,
          messages: [messageWithText(userMessage("row-2", 3), "half-written")],
          events: [],
        },
      },
      null,
      null,
    );
    expect(seeded.spans).toHaveLength(1);
    // Same epoch, and the last row has since grown past the inline budget - so
    // the host legitimately ships an EMPTY tail. Keeping the old span would
    // leave `isTailHydrated` true and nothing would ever fetch the real body.
    const reconnected = applyWindowedSnapshot(
      seeded,
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(hydratedRecords(rebased).messages.map((m) => m.messageId)).toEqual([
      transientId,
    ]);

    const voided = applyIndexChange(rebased, {
      activeTurnId: null,
      epoch: 1,
      rowCount: 1,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(hydratedRecords(voided).messages.map((m) => m.messageId)).toEqual([
      transientId,
    ]);

    const resnapshot = applyWindowedSnapshot(
      voided,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );
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
      null,
      null,
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

    const gapped = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: 3,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );

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

    const gapped = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: 3,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(gapped.invalidated).toBe(true);
    expect(gapped.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-user-gap",
    ]);

    const replacement = applyWindowedSnapshot(
      gapped,
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

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
    const replacement = applyWindowedSnapshot(
      invalidated,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const replacement = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
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
      activeTurnId: null,
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

    const empty = applyWindowedSnapshot(
      live,
      {
        epoch: 0,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );

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

    const empty = applyWindowedSnapshot(
      live,
      {
        epoch: 0,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(empty.liveMessages.map((message) => message.messageId)).toEqual([
      "accepted-after-empty",
    ]);
  });

  it("keeps an accepted user that overtakes a rebasing snapshot", () => {
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage("accepted-after-rebase-snapshot", 2)],
      events: [],
    });

    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

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

    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

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
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

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
    const rebuilding = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(rebuilding.snapshotProvisionalEventIds).toContain(setup.eventId);
    const rebuilt = applySkeletonChunk(rebuilding, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
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
      null,
      null,
    );
    const completion = event("completion-live", 2);
    const live = appendLiveRecords(seeded, {
      messages: [],
      events: [completion],
    });

    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 2,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(rebased.snapshotProvisionalEventIds).toContain(completion.eventId);
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [skeletonEntry(assistantRowId("turn-1"), 0)],
      isFinal: true,
    });
    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 2,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
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
      null,
      null,
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
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 2,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(rebased.snapshotProvisionalEventIds).toContain(failed.eventId);
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [skeletonEntry(assistantRowId(turnId), 0)],
      isFinal: true,
    });
    expect(rebuilt.skeletonComplete).toBe(true);

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 2,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("setup-card:chat-1:9:2", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

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

    const snapshot = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const rebuilding = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 0,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const rebuilding = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 0,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
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
      null,
      null,
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

    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );

    const streamed = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [],
      isFinal: true,
    });
    expect(streamed.liveMessages).toHaveLength(2);
    const confirmed = applyWindowedSnapshot(
      streamed,
      {
        epoch: 1,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(confirmed.liveMessages).toEqual([]);
    expect(hydratedRecords(confirmed).messages).toEqual([]);
  });

  it("retires a provisional user after a completed nonempty rebuild omits it", () => {
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage("accepted-before-rebuild", 1)],
      events: [],
    });
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(confirmed.liveMessages).toEqual([]);
  });

  it("keeps provisional provenance through an intermediate snapshot", () => {
    const messageId = "accepted-before-intermediate";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage(messageId, 1)],
      events: [],
    });
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    const intermediate = applyWindowedSnapshot(
      rebased,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(intermediate.snapshotProvisionalMessageIds).toContain(messageId);
    const rebuilt = applySkeletonChunk(intermediate, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(confirmed.liveMessages).toEqual([]);
  });

  it("prunes provisional ids after their live records are span-superseded", () => {
    const messageId = "accepted-before-span-supersession";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage(messageId, 1)],
      events: [],
    });
    const rebuilding = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(rebuilding.snapshotProvisionalMessageIds).toContain(messageId);
    const superseded = applyRangeResponse(
      rebuilding,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [messageId],
        messages: [userMessage(messageId, 1)],
      }),
      null,
      null,
    );
    expect(superseded.liveMessages).toEqual([]);

    const intermediate = applyWindowedSnapshot(
      superseded,
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const rebuilding = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(rebuilding.snapshotProvisionalMessageIds).toContain(messageId);
    const rebuilt = applySkeletonChunk(rebuilding, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry("replacement-user", 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(confirmed.liveMessages).toEqual([]);
  });

  it("retains a provisional user named by the completed rebuild", () => {
    const messageId = "accepted-in-rebuild";
    const live = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage(messageId, 1)],
      events: [],
    });
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );
    const rebuilt = applySkeletonChunk(rebased, {
      epoch: 1,
      fromOrdinal: 0,
      entries: [skeletonEntry(messageId, 0)],
      isFinal: true,
    });

    const confirmed = applyWindowedSnapshot(
      rebuilt,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(confirmed.liveMessages.map((message) => message.messageId)).toEqual([
      messageId,
    ]);
  });

  it("keeps a frozen assistant across an ambiguous same-epoch empty rebuild", () => {
    const turnId = "turn-restart-deleted";
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 0,
          rowCount: 1,
          indexRevision: null,
          tail: { fromOrdinal: 1, messages: [], events: [] },
        },
        null,
        null,
      ),
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

    const rebuilt = applyWindowedSnapshot(
      live,
      {
        epoch: 0,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(rebuilt.skeleton).toEqual([]);
    expect(rebuilt.liveMessages.map((message) => message.messageId)).toEqual([
      transientLiveAssistantMessageId(turnId),
    ]);
  });

  it("truncates a same-epoch rebuild without retiring its ambiguous stand-in", () => {
    const turnId = "turn-restart-shortened";
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 2,
          indexRevision: null,
          tail: { fromOrdinal: 2, messages: [], events: [] },
        },
        null,
        null,
      ),
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
    const rebuilding = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

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

    const shrunk = applyWindowedSnapshot(
      held,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: 2,
        tail: { fromOrdinal: 1, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(shrunk.skeleton).toHaveLength(1);
    expect(shrunk.skeletonStreamCoveredThrough).toBe(1);
  });

  it("does not retire a completion stand-in because an older span has the turn", () => {
    const turnId = "turn-stale-span";
    const seeded = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 2,
          indexRevision: null,
          tail: { fromOrdinal: 2, messages: [], events: [] },
        },
        null,
        null,
      ),
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
      null,
      null,
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
      null,
      null,
    );

    expect(
      unrelatedServe.liveMessages.map((message) => message.messageId),
    ).toEqual([transientId]);
  });

  it("does not retire a completion stand-in when only a steer row is served", () => {
    const turnId = "turn-steer-only";
    const steerRowId = queueSteerRowId("queue-1");
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 2,
          indexRevision: null,
          tail: { fromOrdinal: 2, messages: [], events: [] },
        },
        null,
        null,
      ),
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
    );

    expect(partial.liveMessages.map((message) => message.messageId)).toEqual([
      transientId,
    ]);
    expect(partial.spans.map((span) => span.rowIds)).toEqual([
      ["user-before"],
      ["user-after"],
    ]);
    expect(partial.spans.map((span) => span.messageIds)).toEqual([
      ["user-before"],
      ["user-after"],
    ]);
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
      null,
      null,
    );
    const live = appendLiveRecords(oldTail, {
      messages: [assistantMessage(transientId, turnId, 2)],
      events: [],
    });

    const snapshot = applyWindowedSnapshot(
      live,
      {
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
      },
      null,
      null,
    );

    expect(snapshot.spans.map((span) => span.rowIds)).toEqual([
      ["user-before"],
      ["user-after"],
    ]);
    expect(snapshot.spans.map((span) => span.messageIds)).toEqual([
      ["user-before"],
      ["user-after"],
    ]);
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
      null,
      null,
    );

    expect(partial.spans.map((held) => held.rowIds)).toEqual([[setupRowId]]);
    expect(partial.spans[0].eventIds).toEqual([setup.eventId]);
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
      null,
      null,
    );

    expect(partial.spans.map((span) => span.eventIds)).toEqual([
      ["setup-first"],
      ["setup-second"],
    ]);
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
      null,
      null,
    );

    expect(partial.spans.map((span) => span.rowIds)).toEqual([
      ["setup-card:chat-1:2:200"],
    ]);
    expect(partial.spans[0].eventIds).toEqual(["setup-second"]);
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
    const partial = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
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
      },
      null,
      null,
    );

    expect(partial.spans.map((span) => span.rowIds)).toEqual([
      ["setup-card:chat-1:2:200"],
    ]);
    expect(partial.spans[0].eventIds).toEqual(["setup-second"]);
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
    );

    expect(partial.unavailableRowIds).toEqual(["row-0"]);
    expect(
      planTranscriptHydration(partial, { fromOrdinal: 0, toOrdinal: 1 }, []),
    ).toBeNull();

    const updated = applyIndexChange(partial, {
      activeTurnId: null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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
      null,
      null,
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

    const hydrated = applyRangeResponse(live, legacyResponse, null, null);

    expect(hydrated.liveMessages).toEqual([]);
  });

  it("does not retire a stand-in from legacy positional tail identities", () => {
    const turnId = "turn-legacy-tail";
    const transientId = transientLiveAssistantMessageId(turnId);
    const indexed = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 1,
          indexRevision: null,
          tail: { fromOrdinal: 1, messages: [], events: [] },
        },
        null,
        null,
      ),
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

    const replacement = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: {
          fromOrdinal: 0,
          messages: [assistantMessage("shared-steer-record", turnId, 1)],
          events: [],
        },
      },
      null,
      null,
    );

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
    const replacement = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: {
          fromOrdinal: 0,
          messages: [assistantMessage("assistant-durable", turnId, 2)],
          events: [],
        },
      },
      null,
      null,
    );
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
    const rebased = applyWindowedSnapshot(
      live,
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
      },
      null,
      null,
    );
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
    const seeded = applyRangeResponse(
      windowWithSkeleton(3),
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 0,
          rowIds: ["row-0"],
          messages: [userMessage("row-0", 1)],
        }),
      },
      null,
      null,
    );
    expect(seeded.spans).toHaveLength(1);
    const rebroadcast = applyWindowedSnapshot(
      seeded,
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: { fromOrdinal: 3, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(rebroadcast.spans).toHaveLength(1);
  });

  it("fills the inline tail's empty ids from the skeleton that names them", () => {
    // The snapshot precedes the skeleton, so the tail is always seated with no
    // ids to carry. Until the chunk backfills them the row merge cannot match
    // these ordinals to their models at all.
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: {
          fromOrdinal: 2,
          messages: [userMessage("row-2", 3)],
          events: [],
        },
      },
      null,
      null,
    );
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 1,
        indexRevision: 0,
        tail: {
          fromOrdinal: 0,
          messages: [userMessage("row-0", 1)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(seeded.spans[0].rowIds).toEqual([""]);

    const described = applyIndexChange(seeded, {
      activeTurnId: null,
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
    const seeded = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 3,
        indexRevision: null,
        tail: {
          fromOrdinal: 2,
          messages: [userMessage("row-2", 3)],
          events: [],
        },
      },
      null,
      null,
    );
    const contradicted = applyRangeResponse(
      seeded,
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 2,
          rowIds: ["someone-else"],
          messages: [userMessage("someone-else", 3)],
        }),
      },
      null,
      null,
    );
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
    return applyRangeResponse(
      window,
      rangeResponse({ epoch: 1, ...input }),
      null,
      null,
    );
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

  it("drops every COPY of a rewritten row's records, not only its own span - kept stale for display", () => {
    // The reader is parked on an EARLIER slice of one turn while a later slice
    // is rewritten. Geometry alone leaves this span holding a stale copy of the
    // very record that changed - and once the containing span goes it is the
    // ONLY copy, rendered under rows the planner sees as covered. So the
    // invalidation follows the records rather than the ordinal.
    const later = splitTurn(windowWithSkeleton(10), "earlier-first");
    expect(later.spans).toHaveLength(2);
    const rewritten = applyIndexChange(later, {
      activeTurnId: null,
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
    // Both dropped spans are kept as STALE, display-only copies - a rewrite's
    // brief stale body beats a placeholder flash while the refetch is in
    // flight (see `TranscriptWindow.staleSpans`), so the shared record still
    // renders from one of them.
    expect(rewritten.staleSpans).toHaveLength(2);
    expect(hydratedRecords(rewritten).messages).toHaveLength(1);
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
      activeTurnId: null,
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
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 10,
          indexRevision: null,
          tail: { fromOrdinal: 10, messages: [], events: [] },
        },
        null,
        null,
      ),
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
      activeTurnId: null,
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
      activeTurnId: null,
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
      activeTurnId: null,
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
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
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
      },
      null,
      null,
    );
    expect(window.spans[0]?.rowIds).toEqual(["row-3", "row-4"]);
    expect(hydratedRecords(window).rowContext).toEqual({
      "row-3": { legacyRowAnchorAt: 1234 },
    });
  });

  it("falls back to the positional read when the tail names no rows", () => {
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 5,
        indexRevision: null,
        tail: {
          fromOrdinal: 3,
          messages: [userMessage("row-3", 3), userMessage("row-4", 4)],
          events: [],
        },
      },
      null,
      null,
    );
    // Unverified ids: the snapshot precedes the skeleton, so there is nothing
    // to fill them from yet.
    expect(window.spans[0]?.rowIds).toEqual(["", ""]);
    expect(hydratedRecords(window).rowContext).toEqual({});
  });

  it("treats a tail that named NO rows as no tail to seat", () => {
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 5,
        indexRevision: null,
        tail: {
          fromOrdinal: 3,
          rowIds: [],
          messages: [userMessage("row-3", 3)],
          events: [],
        },
      },
      null,
      null,
    );
    expect(window.spans).toHaveLength(0);
  });
});

describe("what a span charges the byte budget", () => {
  const CONTEXT = {
    "row-0": { legacyRowAnchorAt: 1234 },
    "row-1": { legacyRowAnchorAt: 5678 },
  };

  function hydrated(rowContext: ChatRangeResponse["rowContext"]) {
    return applyRangeResponse(
      windowWithSkeleton(10),
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
        }),
        rowContext,
      },
      null,
      null,
    );
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
      streamWindowMessage(hydrated(CONTEXT), "m-0", grow, null).window,
    );
    const bare = settleWindowBytes(
      streamWindowMessage(hydrated({}), "m-0", grow, null).window,
    );

    expect(withContext.spans[0].contextBytes).toBeGreaterThan(0);
    expect(withContext.hydratedBytes - bare.hydratedBytes).toBe(
      withContext.spans[0].contextBytes,
    );
  });

  it("keeps the context charge when records are remapped", () => {
    const rewrite = (message: Message): Message =>
      messageWithText(message, "a rewritten body");
    const withContext = mapWindowMessages(hydrated(CONTEXT), rewrite, null);
    const bare = mapWindowMessages(hydrated({}), rewrite, null);

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
    const reserved = applyRangeResponse(
      first,
      {
        ...rangeResponse({
          epoch: 1,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
        }),
        rowContext: CONTEXT,
      },
      null,
      null,
    );

    expect(reserved.spans).toHaveLength(1);
    expect(reserved.spans[0].contextBytes).toBe(first.spans[0].contextBytes);
    // And the merged span's own charge still INCLUDES that context. Re-serving
    // the identical rows must leave the figure exactly where it was: lower
    // means the merge dropped the context, higher means it billed it twice.
    expect(spanChargeBytes(reserved, reserved.spans[0])).toBe(
      spanChargeBytes(first, first.spans[0]),
    );
    expect(spanChargeBytes(reserved, reserved.spans[0])).toBeGreaterThan(
      reserved.spans[0].contextBytes,
    );
  });

  it("charges the context that rides the snapshot tail", () => {
    const bare = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: {
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
        },
      },
      null,
      null,
    );
    const withContext = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
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
      },
      null,
      null,
    );

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
