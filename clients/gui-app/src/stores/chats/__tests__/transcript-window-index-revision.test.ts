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
    message: { kind: "user", content: CONTENT },
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
  return { ...hydrated, indexRevision: revision };
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

  it("LESS than the held revision (a straggler serialized before an applied delta) is accepted without invalidating", () => {
    const window = windowAtRevision(5);
    const heldSpanCount = window.spans.length;
    expect(heldSpanCount).toBeGreaterThan(0);

    const result = applyWindowedSnapshot(window, {
      epoch: 4,
      rowCount: 10,
      indexRevision: 3,
      tail: { fromOrdinal: 10, messages: [], events: [] },
    });

    expect(result.invalidated).toBe(false);
    expect(result.spans.length).toBe(heldSpanCount);
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
