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
  appendLiveRecords,
  applyIndexChange,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  evictTranscriptWindowToBudget,
  holdsEveryRecordFrom,
  hydratedRecords,
  planTranscriptHydration,
  settleWindowBytes,
  streamWindowMessage,
  touchTranscriptRange,
  transcriptHydrationGaps,
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
    message: { kind: "user", content: CONTENT },
    timestamp,
    sessionAnchor: null,
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
  readonly messages: readonly Message[];
  readonly events?: readonly ChatEvent[];
}): ChatRangeResponse {
  return {
    requestId: `req-${input.fromOrdinal}`,
    epoch: input.epoch,
    fromOrdinal: input.fromOrdinal,
    rowIds: [...input.rowIds],
    messages: [...input.messages],
    events: [...(input.events ?? [])],
    reachedStart: input.fromOrdinal === 0,
    reachedEnd: false,
  };
}

/** A window with a complete 10-row skeleton at epoch 1 and nothing hydrated. */
function windowWithSkeleton(rowCount: number): TranscriptWindow {
  const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
    epoch: 1,
    rowCount,
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
      changes: [{ type: "appended", entries: skeletonEntries(4, 2) }],
    });
    expect(appended.rowCount).toBe(6);
    expect(appended.skeleton[5]?.rowId).toBe("row-5");
    expect(appended.spans).toHaveLength(1);
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
      changes: [{ type: "reindexed" }],
    });
    expect(reindexed.invalidated).toBe(true);
    expect(reindexed.spans).toEqual([]);
    expect(reindexed.skeleton).toEqual([]);
    expect(reindexed.epoch).toBe(2);
  });

  it("ignores a non-reindexed delta stamped with an epoch it does not hold", () => {
    const window = windowWithSkeleton(4);
    const stale = applyIndexChange(window, {
      epoch: 7,
      rowCount: 99,
      changes: [{ type: "appended", entries: skeletonEntries(4, 1) }],
    });
    expect(stale.rowCount).toBe(4);
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

  it("asks for the tail when the snapshot arrived with rows but no bodies", () => {
    // The obligation the empty-tail case creates. Without it the chat has rows
    // in it and displays as empty, with nothing on screen to suggest a retry.
    const window = applyWindowedSnapshot(emptyTranscriptWindow(), {
      epoch: 1,
      rowCount: 40,
      tail: { fromOrdinal: 40, messages: [], events: [] },
    });
    expect(planTranscriptHydration(window, null)).toEqual({
      fromOrdinal: 20,
      toOrdinal: 40,
    });
  });

  it("moves on to the visible span once the tail is hydrated", () => {
    const window = applyRangeResponse(
      applyWindowedSnapshot(emptyTranscriptWindow(), {
        epoch: 1,
        rowCount: 40,
        tail: { fromOrdinal: 40, messages: [], events: [] },
      }),
      rangeResponse({
        epoch: 1,
        fromOrdinal: 20,
        rowIds: Array.from({ length: 20 }, (_u, i) => `row-${20 + i}`),
        messages: [userMessage("m-20", 20)],
      }),
    );
    expect(planTranscriptHydration(window, null)).toBeNull();
    expect(
      planTranscriptHydration(window, { fromOrdinal: 0, toOrdinal: 10 }),
    ).toEqual({ fromOrdinal: 0, toOrdinal: 10 });
  });

  it("asks for nothing while the index is void - that owes a resnapshot, not a range", () => {
    const window = applyIndexChange(windowWithSkeleton(10), {
      epoch: 2,
      rowCount: 10,
      changes: [{ type: "reindexed" }],
    });
    expect(
      planTranscriptHydration(window, { fromOrdinal: 0, toOrdinal: 5 }),
    ).toBeNull();
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
    const evicted = evictTranscriptWindowToBudget(window, 1, null);
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
    const evicted = evictTranscriptWindowToBudget(window, 1, {
      fromOrdinal: 10,
      toOrdinal: 12,
    });
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([10, 28]);
    // The budget is SOFT against the protected spans: the result stays over
    // budget rather than sacrificing them.
    expect(evicted.hydratedBytes).toBeGreaterThan(1);
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
    expect(streamed.window.unsettledByteRowIds).toEqual(["live"]);
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
    expect(settled.unsettledByteRowIds).toEqual([]);
  });

  it("does not name the same row twice across a turn's worth of deltas", () => {
    let window = windowWithColdAndTail();
    for (let index = 0; index < 50; index += 1) {
      window = streamWindowMessage(window, "live", (message) =>
        messageWithText(message, `body ${index}`),
      ).window;
    }
    expect(window.unsettledByteRowIds).toEqual(["live"]);
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

    const evicted = evictTranscriptWindowToBudget(streamed, budget, null);
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
    );
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([0, 29]);
    // Settled on the way through, so the next read costs nothing.
    expect(evicted.unsettledByteRowIds).toEqual([]);
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
      tail: {
        fromOrdinal: 0,
        messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
        events: [],
      },
    });
    expect(holdsEveryRecordFrom(window, "m-0")).toBe(true);
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
    },
  };
}
