import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatRangeResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  applyIndexChange,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  evictTranscriptWindowToBudget,
  planTranscriptHydration,
  selectHydratedRecords,
  transcriptHydrationGaps,
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
    const evicted = evictTranscriptWindowToBudget(window, 1);
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([18]);
  });

  it("reading a span keeps it from being evicted under the reader", () => {
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

    // The reader is looking at the OLDEST-loaded span. Reading it must reorder
    // eviction, or scrolling up evicts exactly what is on screen.
    const read = selectHydratedRecords(window, {
      fromOrdinal: 0,
      toOrdinal: 2,
    });
    expect(read.messages.map((message) => message.messageId)).toEqual(["old"]);

    const evicted = evictTranscriptWindowToBudget(
      read.window,
      read.window.hydratedBytes - 1,
    );
    expect(evicted.spans.map((span) => span.fromOrdinal)).toEqual([0, 28]);
  });
});
