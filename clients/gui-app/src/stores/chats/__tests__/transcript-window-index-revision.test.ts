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
 * `indexRevision` gap detection.
 *
 * `TranscriptWindow.indexRevision` is the one signal that an `updated`-only
 * index delta was lost without the stream dying (see that field's doc). A
 * same-epoch `windowedSnapshot` whose `indexRevision` ran AHEAD of the held
 * one is proof of exactly that loss, and `applyWindowedSnapshot` reacts by
 * declaring the window invalid so a resnapshot repairs it.
 *
 * `indexRevision: null` is a different thing entirely - the host saying it
 * holds no index for this subscriber and a full skeleton is on its way
 * (bootstrap or post-resnapshot rebuild). Treating that as a gap would
 * invalidate the window the incoming chunks are about to fill and re-request
 * another resnapshot for it, which is a loop. These tests pin the `null`
 * suppression AND prove a steady-state frame - which always carries a real
 * number - can never reach that suppressing branch: every numeric relation
 * between the incoming and held revision is covered on its own.
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
 * A 10-row window at epoch 4, complete skeleton, one hydrated span, stamped
 * at the given `indexRevision`.
 *
 * No wire frame carries an arbitrary `indexRevision` on its own - it only
 * ever advances by one via `applyIndexChange` - so stamping it directly is
 * what lets a fixture start at a chosen revision without replaying the whole
 * delta sequence that would normally produce it.
 */
function windowAtRevision(revision: number): TranscriptWindow {
  const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
    epoch: 4,
    rowCount: 10,
    indexRevision: null,
    tail: { fromOrdinal: 10, messages: [], events: [] },
  });
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
  );
  // `indexRevisionRebuilding: false` because this models a client that has
  // ALREADY reached `revision` - which only happens by applying frames, and
  // every applied frame spends the rebuild boundary. Leaving it armed would
  // model a client permanently exempt from the direction rules these suites
  // exist to pin, so every steady-state case below would pass vacuously.
  return {
    ...hydrated,
    indexRevision: revision,
    indexRevisionRebuilding: false,
  };
}

describe("applyWindowedSnapshot: the bootstrap suppression (indexRevision: null)", () => {
  it("does not invalidate, and preserves the held revision rather than clobbering it", () => {
    const window = windowAtRevision(5);

    const result = applyWindowedSnapshot(window, {
      epoch: 4,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    expect(result.invalidated).toBe(false);
    // The `?? window.indexRevision` branch: a restreaming snapshot names no
    // revision, so the client's place in the delta sequence must survive it -
    // overwriting it with 0 here would be indistinguishable from a real gap.
    expect(result.indexRevision).toBe(5);
  });

  /**
   * The other half of the same rule, and the reason retaining is not merely
   * tidy: the host's counter is per-VIEW, not per-subscriber.
   * `TranscriptViewCache` holds one per chat session and restarts it only on an
   * epoch change, so the FIRST delta after a rebuild carries the sequence
   * forward from where it was - `6` here, not `1`.
   *
   * Reset the client to 0 at the rebuild boundary and that delta reads as a gap
   * (`6 !== 0 + 1`), which voids the coordinate and asks for a resnapshot,
   * which answers `null` again, which resets again. This asserts the delta
   * lands instead, so the loop cannot be reintroduced by a change that only
   * looks symmetric.
   */
  it("accepts the next delta after a rebuild, because the host's counter carried on", () => {
    const rebuilt = applyWindowedSnapshot(windowAtRevision(5), {
      epoch: 4,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    const delta = applyIndexChange(rebuilt, {
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

  /**
   * A rebuild re-streams the whole skeleton INTO the array the previous stream
   * left, so a dropped chunk of the replacement lands on ordinals that are
   * already occupied: the array has no holes and `coversEveryOrdinal` vouches
   * for entries this stream never sent. The client then declares the delivery
   * complete while holding the previous stream's metadata - and the missing
   * chunk is exactly the one carrying whatever changed while it was away.
   *
   * Completeness therefore has to be answered per STREAM, which is what
   * `skeletonStreamCoveredThrough` is for.
   */
  it("detects a dropped chunk of a REPLACEMENT stream that old entries would mask", () => {
    const complete = windowAtRevision(5);
    // Sanity: the fixture really is complete and has no holes, so the masking
    // this test is about is available to happen.
    expect(complete.skeletonComplete).toBe(true);

    const rebuilt = applyWindowedSnapshot(complete, {
      epoch: 4,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });
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
   * The negative, and the constraint that shaped the fix: `indexRevision: null`
   * also covers the host state in which `reconcileWindowedIndex` returns early
   * and emits NO skeleton at all. Clearing the entries there would blank the
   * transcript to detect a chunk that was never going to arrive.
   *
   * So the entries stay renderable and only the completeness claim drops -
   * which is also what arms the recovery, since `chunkedDeliveryIncomplete()`
   * reads exactly this boolean and the stream-completion watchdog reads that.
   */
  it("keeps the entries renderable when a rebuild snapshot has no stream behind it", () => {
    const rebuilt = applyWindowedSnapshot(windowAtRevision(5), {
      epoch: 4,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

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
  // The suppression above fires only on `indexRevision: null`. A live frame
  // never carries that - it always names a concrete revision - so every
  // relation that number can have to the held one is covered here, to pin
  // that the `null` branch is reachable only from an actual bootstrap.

  it("GREATER than the held revision sets invalidated and resets the window", () => {
    const window = windowAtRevision(5);
    expect(window.spans.length).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(window, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 6,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

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

    const result = applyWindowedSnapshot(window, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 5,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    expect(result.invalidated).toBe(false);
    // The aux-only re-broadcast path, not a reset: the held scrollback
    // survives.
    expect(result.spans.length).toBe(heldSpanCount);
  });

  it("LESS than the held revision, with no rebuild between, is REFUSED whole", () => {
    // This assertion used to read "accepted without invalidating", and it was
    // silent on the held revision - which is the only part that matters. A
    // straggler describes an index the host has moved past, so taking any of
    // its transcript half is a rewind: the revision, the `rowCount`, and a tail
    // seated at the newest `servedAt` that would outrank the copy held here.
    const window = windowAtRevision(5);
    const heldSpanCount = window.spans.length;
    expect(heldSpanCount).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(window, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 3,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    // Referential identity: nothing of the transcript half was taken. The
    // snapshot's AUXILIARY half is applied by the caller regardless, because
    // those fields are last-write-wins and self-correct on the next broadcast.
    expect(result).toBe(window);
  });

  /**
   * ## The two readings of a LOWER non-null revision, driven rather than argued
   *
   * The test above pins that such a snapshot is accepted; it says nothing about
   * what the held REVISION does next, which is the whole question. Both
   * readings below are reachable, and they want opposite behaviour - so they
   * are driven together, and whichever way the rule lands the repo enforces the
   * disagreement rather than a comment claiming one of them cannot happen.
   */
  it("REWIND: refusing the straggler is what keeps the next delta applicable", () => {
    const window = windowAtRevision(5);

    const straggler = applyWindowedSnapshot(window, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 3,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });
    expect(straggler.indexRevision).toBe(5);

    // The host's counter never went back, so its next delta is 6 - the
    // immediate successor of what this client actually holds. Against a window
    // rewound to 3 it would not have been, and a VALID index would have been
    // declared lost.
    const next = applyIndexChange(straggler, {
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
    // The other reading, and why Codex's remedy - "ignore the transcript
    // portion of a lower-revision snapshot" - cannot simply be taken.
    //
    // Driven as the host actually produces it. A restart meets a FRESH
    // subscriber, whose index state is not `held`, so the snapshot is stamped
    // `null` and the whole skeleton is restreamed BEFORE any concrete revision
    // arrives (`chat-session-manager.ts:34710-34717`). The epoch does not move:
    // a fresh `TranscriptViewCache` starts at 0 and a chat that never reindexed
    // is already there, so the client keeps its window and the host's revision
    // is genuinely below the one held.
    const window = { ...windowAtRevision(5), epoch: 0 };

    const announced = applyWindowedSnapshot(window, {
      epoch: 0,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });
    // The held revision survives the announcement itself - the restream carries
    // no revision to replace it with.
    expect(announced.indexRevision).toBe(5);

    const restreamed = applySkeletonChunk(announced, {
      epoch: 0,
      fromOrdinal: 0,
      entries: skeletonEntries(0, 10),
      isFinal: true,
    });

    const resynced = applyWindowedSnapshot(restreamed, {
      epoch: 0,
      rowCount: 10,
      indexRevision: 0,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    // Adopted DOWNWARD, which only the boundary makes legitimate.
    expect(resynced.indexRevision).toBe(0);
    expect(resynced.invalidated).toBe(false);

    const next = applyIndexChange(resynced, {
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

    // Applied, not dropped. Had the window kept 5, `applyIndexChange`'s
    // `indexRevision <= window.indexRevision` guard would have discarded this
    // delta - and every delta until the host climbed past 5.
    expect(next.invalidated).toBe(false);
    expect(next.indexRevision).toBe(1);
  });

  it("EXPIRY: the boundary exempts exactly ONE frame, then gap detection is live", () => {
    // A suppression with no pinned lifetime is how a one-frame allowance
    // becomes a standing hole. The frame AFTER the rebuild is compared
    // normally, so a genuine loss is still caught.
    const announced = applyWindowedSnapshot(windowAtRevision(5), {
      epoch: 4,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });
    const resynced = applyWindowedSnapshot(announced, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 2,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });
    expect(resynced.indexRevision).toBe(2);

    // Second frame, same rebuild: a revision that ran AHEAD is a lost delta
    // again, not another free adoption.
    const ahead = applyWindowedSnapshot(resynced, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 7,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });
    expect(ahead.invalidated).toBe(true);

    // And a straggler is refused again rather than adopted.
    expect(
      applyWindowedSnapshot(resynced, {
        epoch: 4,
        rowCount: 10,
        indexRevision: 1,
        tail: { fromOrdinal: 10, messages: [], events: [] },
      }),
    ).toBe(resynced);
  });

  it("EPOCH: discards an older-epoch snapshot carrying a concrete revision", () => {
    // A reordered straggler from a coordinate space this client has already
    // left. Treated as a rebase it replaces the skeleton, the spans and the
    // epoch with obsolete ordinals, and on an idle chat nothing repairs that.
    const window = windowAtRevision(5);
    expect(window.spans.length).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(window, {
      epoch: 3, // below the window's epoch of 4
      rowCount: 2,
      indexRevision: 9,
      tail: { fromOrdinal: 2, messages: [], events: [] },
    });

    // Referential identity: nothing of the older space was taken.
    expect(result).toBe(window);
  });

  it("EPOCH: ACCEPTS an older-epoch snapshot announcing a rebuild", () => {
    // The other direction, and the reason the guard is not a bare epoch
    // comparison. A fresh `TranscriptViewCache` restarts `epoch` AND
    // `indexRevision` together, so a host restart hands a client sitting at
    // epoch 4 a snapshot at epoch 0 - and a fresh cache means a fresh
    // subscriber, so that frame necessarily carries `indexRevision: null`
    // (`chat-session-manager.ts:34710-34717`). Discarding it would strand this
    // client on a dead epoch for the life of the connection.
    const window = windowAtRevision(5);

    const result = applyWindowedSnapshot(window, {
      epoch: 0,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
    });

    expect(result).not.toBe(window);
    expect(result.epoch).toBe(0);
    // Rebased, so the held coordinate space is replaced rather than merged.
    expect(result.spans).toEqual([]);
  });

  it("RE-ARMS at a void, so the resnapshot that follows can resync downward", () => {
    // Checked rather than assumed: a void takes its shape from
    // `emptyTranscriptWindow()`, which is armed - so the client comes out of an
    // H-path invalidation with no counter it trusts, exactly as it comes out of
    // construction. Were it to come out DISARMED, a void followed by a
    // restarted host would leave the resnapshot's lower revision refused, which
    // is the failure this whole flag exists to prevent, reached by the one path
    // that looks like it has already been handled.
    const voided = applyIndexChange(windowAtRevision(5), {
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

    const resynced = applyWindowedSnapshot(voided, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 0,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    expect(resynced.indexRevision).toBe(0);
  });

  it("EXPIRY: a delta spends the boundary too, so the next one is compared", () => {
    // The delta path reaches the boundary whenever a delta arrives before the
    // next aux snapshot does, which is ordinary.
    const announced = applyWindowedSnapshot(windowAtRevision(5), {
      epoch: 4,
      rowCount: 10,
      indexRevision: null,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    const adopted = applyIndexChange(announced, {
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
   * The two no-ops above both carry `updated`-only changes, so `rowCount` never
   * moves and the append-count consistency check passes trivially on its way to
   * the revision guard. A duplicate carrying `appended` entries does not: this
   * client already applied them, so its `rowCount` ALREADY includes them and
   * the frame's own count matches it exactly - which reads to a count check as
   * "rows appeared that this frame does not account for", the signature of a
   * LOST frame.
   *
   * So the guards have to run in the order their questions nest. "Is this frame
   * news at all" is answerable from the revision alone and settles the frame;
   * "are these changes internally consistent with the count" is only meaningful
   * about a frame that IS news. Asking the second one first turns the most
   * harmless thing a stream can do - deliver something twice - into a blanked
   * transcript and a full refetch.
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

  /**
   * The other half, so the reordering above cannot be mistaken for "the count
   * check is gone". A frame that IS the immediate successor still has its
   * appended entries reconciled against `rowCount`, and a mismatch there is
   * still the lost-frame signal it always was.
   */
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
