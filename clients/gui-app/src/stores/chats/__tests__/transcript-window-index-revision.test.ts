import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatRangeResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  applyIndexChange,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * `indexRevision` gap detection. `TranscriptWindow.indexRevision` is the one signal that an
 * `updated`-only index delta was lost without the stream dying (see that field's doc).
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
  readonly messages: readonly Message[];
}): ChatRangeResponse {
  return {
    requestId: `req-${input.fromOrdinal}`,
    epoch: input.epoch,
    fromOrdinal: input.fromOrdinal,
    rowIds: [...input.rowIds],
    messages: [...input.messages],
    events: [],
    rowContext: {},
    reachedStart: input.fromOrdinal === 0,
    reachedEnd: false,
  };
}

/**
 * A 10-row window at epoch 4, complete skeleton, one hydrated span, stamped at the given
 * `indexRevision`.
 */
function windowAtRevision(revision: number): TranscriptWindow {
  const seeded = applyWindowedSnapshot(
    emptyTranscriptWindow(),
    {
      epoch: 4,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    },
    null,
    null,
  );
  const skeletoned = applySkeletonChunk(seeded, {
    epoch: 4,
    fromOrdinal: 0,
    entries: skeletonEntries(0, 10),
    isFinal: true,
  });
  const hydrated = applyRangeResponse(
    skeletoned,
    rangeResponse({
      epoch: 4,
      fromOrdinal: 0,
      rowIds: ["row-0"],
      messages: [userMessage("m-0", 0)],
    }),
    null,
    null,
  );
  // `indexRevisionRebuilding: false` because this models a client that has ALREADY reached
  // `revision` - which only happens by applying frames, and every applied frame spends the rebuild
  return {
    ...hydrated,
    indexRevision: revision,
    indexRevisionRebuilding: false,
  };
}

describe("applyWindowedSnapshot: the bootstrap suppression (indexRevision: null)", () => {
  it("does not invalidate, and preserves the held revision rather than clobbering it", () => {
    const window = windowAtRevision(5);

    const result = applyWindowedSnapshot(
      window,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(result.invalidated).toBe(false);
    // The `??
    expect(result.indexRevision).toBe(5);
  });

  /**
   * The other half of the same rule, and the reason retaining is not merely tidy: the host's counter
   * is per-VIEW, not per-subscriber.
   */
  it("accepts the next delta after a rebuild, because the host's counter carried on", () => {
    const rebuilt = applyWindowedSnapshot(
      windowAtRevision(5),
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    const delta = applyIndexChange(rebuilt, {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 6,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0", 0) }],
        },
      ],
    });

    expect(delta.invalidated).toBe(false);
    expect(delta.indexRevision).toBe(6);
  });

  it("detects a dropped chunk of a REPLACEMENT stream that old entries would mask", () => {
    const complete = windowAtRevision(5);
    // Sanity: the fixture really is complete and has no holes, so the masking
    // this test is about is available to happen.
    expect(complete.skeletonComplete).toBe(true);

    const rebuilt = applyWindowedSnapshot(
      complete,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );
    // The claim is dropped at the boundary; the entries are not.
    expect(rebuilt.skeletonComplete).toBe(false);
    expect(rebuilt.skeleton).toHaveLength(10);

    const first = applySkeletonChunk(rebuilt, {
      epoch: 4,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 4),
      isFinal: false,
    });
    // The chunk covering ordinals 4-6 never arrives.
    const final = applySkeletonChunk(first, {
      epoch: 4,
      fromOrdinal: 7,
      entries: skeletonEntries(7, 3),
      isFinal: true,
    });

    // Every ordinal still HAS an entry - 4-6 are the previous stream's - so a
    // hole scan reports a complete skeleton. Only the per-stream prefix knows.
    expect(final.skeleton.filter((entry) => entry !== undefined)).toHaveLength(
      10,
    );
    expect(final.skeletonComplete).toBe(false);
    expect(final.invalidated).toBe(true);
  });

  /**
   * The negative, and the constraint that shaped the fix: `indexRevision: null` also covers the host
   * state in which `reconcileWindowedIndex` returns early and emits NO skeleton at all.
   */
  it("keeps the entries renderable when a rebuild snapshot has no stream behind it", () => {
    const rebuilt = applyWindowedSnapshot(
      windowAtRevision(5),
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(
      rebuilt.skeleton.filter((entry) => entry !== undefined),
    ).toHaveLength(10);
    expect(rebuilt.spans.length).toBeGreaterThan(0);
    // The signal `chunkedDeliveryIncomplete()` reads, so the watchdog fires and
    // the window does not sit incomplete forever.
    expect(rebuilt.skeletonComplete).toBe(false);
  });
});

describe("applyWindowedSnapshot: a steady-state frame always carries a real number", () => {
  // The suppression above fires only on `indexRevision: null`.

  it("GREATER than the held revision sets invalidated and resets the window", () => {
    const window = windowAtRevision(5);
    expect(window.spans.length).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(
      window,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: 6,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(result.invalidated).toBe(true);
    expect(result.indexRevision).toBe(6);
    // Reset, not merely flagged: the stale skeleton and every held body are
    // gone, because nothing in this frame would repair them.
    expect(result.spans).toEqual([]);
    expect(result.skeleton).toEqual([]);
  });

  it("EQUAL to the held revision is accepted without invalidating", () => {
    const window = windowAtRevision(5);
    const heldSpanCount = window.spans.length;
    expect(heldSpanCount).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(
      window,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: 5,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(result.invalidated).toBe(false);
    // The aux-only re-broadcast path, not a reset: the held scrollback
    // survives.
    expect(result.spans.length).toBe(heldSpanCount);
  });

  it("LESS than the held revision, with no rebuild between, is REFUSED whole", () => {
    // A straggler describes an index the host has moved past, so taking any of its transcript half is
    // a rewind: the revision, the `rowCount`, and a tail seated at the newest `servedAt` that would
    const window = windowAtRevision(5);
    const heldSpanCount = window.spans.length;
    expect(heldSpanCount).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(
      window,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: 3,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    // Referential identity: nothing of the transcript half was taken.
    expect(result).toBe(window);
  });

  /**
   * The test above pins that such a snapshot is accepted; it says nothing about what the held
   * REVISION does next, which is the whole question.
   */
  it("REWIND: refusing the straggler is what keeps the next delta applicable", () => {
    const window = windowAtRevision(5);

    const straggler = applyWindowedSnapshot(
      window,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: 3,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(straggler.indexRevision).toBe(5);

    // The host's counter never went back, so its next delta is 6 - the immediate successor of what
    // this client actually holds.
    const next = applyIndexChange(straggler, {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 6,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-rewritten", 0) }],
        },
      ],
    });

    expect(next.invalidated).toBe(false);
    expect(next.indexRevision).toBe(6);
  });

  it("ADOPTION: a host-side counter restart resyncs through the null boundary", () => {
    // The other reading, and why Codex's remedy - "ignore the transcript portion of a lower-revision
    // snapshot" - cannot simply be taken. Driven as the host actually produces it.
    const window = { ...windowAtRevision(5), epoch: 0 };

    const announced = applyWindowedSnapshot(
      window,
      {
        epoch: 0,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );
    // The held revision survives the announcement itself - the restream carries
    // no revision to replace it with.
    expect(announced.indexRevision).toBe(5);

    const restreamed = applySkeletonChunk(announced, {
      epoch: 0,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 10),
      isFinal: true,
    });

    const resynced = applyWindowedSnapshot(
      restreamed,
      {
        epoch: 0,
        rowCount: 10,
        indexRevision: 0,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    // Adopted DOWNWARD, which only the boundary makes legitimate.
    expect(resynced.indexRevision).toBe(0);
    expect(resynced.invalidated).toBe(false);

    const next = applyIndexChange(resynced, {
      activeTurnId: null,
      epoch: 0,
      rowCount: 10,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-rewritten", 0) }],
        },
      ],
    });

    // Applied, not dropped.
    expect(next.invalidated).toBe(false);
    expect(next.indexRevision).toBe(1);
  });

  it("EXPIRY: the boundary exempts exactly ONE frame, then gap detection is live", () => {
    // A suppression with no pinned lifetime is how a one-frame allowance becomes a standing hole. The
    // frame AFTER the rebuild is compared normally, so a genuine loss is still caught.
    const announced = applyWindowedSnapshot(
      windowAtRevision(5),
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );
    const resynced = applyWindowedSnapshot(
      announced,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: 2,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(resynced.indexRevision).toBe(2);

    // Second frame, same rebuild: a revision that ran AHEAD is a lost delta
    // again, not another free adoption.
    const ahead = applyWindowedSnapshot(
      resynced,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: 7,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );
    expect(ahead.invalidated).toBe(true);

    // And a straggler is refused again rather than adopted.
    expect(
      applyWindowedSnapshot(
        resynced,
        {
          epoch: 4,
          rowCount: 10,
          indexRevision: 1,
          tail: { fromOrdinal: 10, messages: [], events: [] },
        },
        null,
        null,
      ),
    ).toBe(resynced);
  });

  it("EPOCH: discards an older-epoch snapshot carrying a concrete revision", () => {
    // A reordered straggler from a coordinate space this client has already left.
    const window = windowAtRevision(5);
    expect(window.spans.length).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(
      window,
      {
        epoch: 3, // below the window's epoch of 4
        rowCount: 2,
        indexRevision: 9,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      },
      null,
      null,
    );

    // Referential identity: nothing of the older space was taken.
    expect(result).toBe(window);
  });

  it("EPOCH: ACCEPTS an older-epoch snapshot announcing a rebuild", () => {
    // The other direction, and the reason the guard is not a bare epoch comparison.
    const window = windowAtRevision(5);

    const result = applyWindowedSnapshot(
      window,
      {
        epoch: 0,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(result).not.toBe(window);
    expect(result.epoch).toBe(0);
    // Rebased, so the held coordinate space is replaced rather than merged.
    expect(result.spans).toEqual([]);
  });

  it("RE-ARMS at a void, so the resnapshot that follows can resync downward", () => {
    const voided = applyIndexChange(windowAtRevision(5), {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 9, // non-consecutive: a loss, so the coordinate voids
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-rewritten", 0) }],
        },
      ],
    });
    expect(voided.invalidated).toBe(true);

    const resynced = applyWindowedSnapshot(
      voided,
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: 0,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    expect(resynced.indexRevision).toBe(0);
  });

  it("EXPIRY: a delta spends the boundary too, so the next one is compared", () => {
    // The delta path reaches the boundary whenever a delta arrives before the
    // next aux snapshot does, which is ordinary.
    const announced = applyWindowedSnapshot(
      windowAtRevision(5),
      {
        epoch: 4,
        rowCount: 10,
        indexRevision: null,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      },
      null,
      null,
    );

    const adopted = applyIndexChange(announced, {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-rewritten", 0) }],
        },
      ],
    });
    expect(adopted.indexRevision).toBe(1);
    expect(adopted.invalidated).toBe(false);

    // Spent. A non-consecutive revision is a loss again.
    const skipped = applyIndexChange(adopted, {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 5,
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-again", 0) }],
        },
      ],
    });
    expect(skipped.invalidated).toBe(true);
  });
});

describe("applyIndexChange: revision continuity on the append/delta path", () => {
  it("is a no-op when indexRevision is not greater than what is held", () => {
    const window = windowAtRevision(5);

    const result = applyIndexChange(window, {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 5, // equal to the held revision: a duplicate, not a gap
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-rewritten", 0) }],
        },
      ],
    });

    // Literally the same object: the function returns early before touching
    // the skeleton or dropping any span for the "update".
    expect(result).toBe(window);
  });

  it("is also a no-op for a revision strictly less than what is held", () => {
    const window = windowAtRevision(5);

    const result = applyIndexChange(window, {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 3, // a straggler behind the held revision
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-rewritten", 0) }],
        },
      ],
    });

    expect(result).toBe(window);
  });

  /**
   * The two no-ops above both carry `updated`-only changes, so `rowCount` never moves and the
   * append-count consistency check passes trivially on its way to the revision guard.
   */
  const appendedFrame = (
    indexRevision: number,
    rowCount: number,
    fromOrdinal: number,
    count: number,
  ): Parameters<typeof applyIndexChange>[1] => ({
    epoch: 4,
    rowCount,
    indexRevision,
    changes: [
      { type: "appended", entries: skeletonEntries(fromOrdinal, count) },
    ],
    activeTurnId: null,
  });

  it.each([
    ["an immediate re-delivery of the frame just applied", 0],
    ["a straggler that arrives after a NEWER append landed", 1],
  ])("is a no-op for %s", (_label, newerFrames) => {
    const applied = applyIndexChange(
      windowAtRevision(5),
      appendedFrame(6, 12, 10, 2),
    );
    expect(applied.invalidated).toBe(false);
    expect(applied.rowCount).toBe(12);

    let held = applied;
    for (let index = 0; index < newerFrames; index += 1) {
      held = applyIndexChange(
        held,
        appendedFrame(7 + index, 13 + index, 12 + index, 1),
      );
      expect(held.invalidated).toBe(false);
    }

    // The same frame again. Referential identity, as for the `updated`
    // duplicates above: it is dropped whole rather than read for a count.
    expect(applyIndexChange(held, appendedFrame(6, 12, 10, 2))).toBe(held);
  });

  /** The other half, so the reordering above cannot be mistaken for "the count check is gone". */
  it("still voids when a SUCCESSOR frame's rowCount outruns its appended rows", () => {
    const window = windowAtRevision(5);
    expect(window.spans.length).toBeGreaterThan(0);

    // Revision 6 is the immediate successor, so the revision guards pass; the
    // count does not - `rowCount` grew by three and only one entry arrived.
    const result = applyIndexChange(window, appendedFrame(6, 13, 10, 1));

    expect(result.invalidated).toBe(true);
    expect(result.spans).toEqual([]);
    expect(result.skeleton).toEqual([]);
  });

  it("treats a non-consecutive revision as a loss and voids the coordinate", () => {
    const window = windowAtRevision(5);
    expect(window.spans.length).toBeGreaterThan(0);

    const result = applyIndexChange(window, {
      activeTurnId: null,
      epoch: 4,
      rowCount: 10,
      indexRevision: 7, // skips 6: the immediate successor never reached this client
      changes: [
        {
          type: "updated",
          entries: [{ ordinal: 0, entry: skeletonEntry("row-0-rewritten", 0) }],
        },
      ],
    });

    expect(result.invalidated).toBe(true);
    expect(result.indexRevision).toBe(7);
    expect(result.spans).toEqual([]);
    expect(result.skeleton).toEqual([]);
  });
});
