import { describe, expect, it } from "vitest";

import {
  ACCUMULATED_CHANGE_CHUNK_MAX_BYTES,
  INDEX_CHANGE_MAX_BYTES,
  SKELETON_CHUNK_MAX_BYTES,
  WINDOWED_SNAPSHOT_MAX_BYTES,
  WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES,
  chunkByEncodedBytes,
  chunkRowSkeleton,
  indexChangeFits,
  windowedSnapshotFitsFrame,
  type ChatAccumulatedFileChangeSummary,
  type ChatIndexChange,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

/**
 * These guard the half of the 1 MiB frame invariant that was assertion-only.
 *
 * `range` responses and the snapshot's tail are budgeted by `read-range.ts`.
 * The skeleton chunks and the index delta were left to their producers, which
 * is exactly the shape `maxBytes` had before it became a real frame ceiling -
 * an invariant every doc comment states and no code enforces.
 *
 * So the assertions below measure the ENCODED frame rather than counting
 * entries. A guard that counts entries passes on a skeleton of 20k tiny rows
 * and says nothing about one carrying full-length previews.
 */

function entry(rowId: string, preview: string): RowSkeletonEntry {
  // A realistic fixed-width digest: this suite measures ENCODED bytes, so an
  // entry missing a field every real entry carries would understate the budget
  // it is asserting.
  return {
    rowId,
    createdAt: 1_000,
    role: "user",
    byteLength: 42,
    bodyDigest: "1z141z30000000",
    preview,
  };
}

/** What the chunk's `entries` array actually costs on the wire. */
function encodedEntriesBytes(entries: readonly RowSkeletonEntry[]): number {
  return utf8ByteLength(JSON.stringify(entries));
}

describe("chunkRowSkeleton keeps every chunk under the frame budget", () => {
  it("splits a skeleton whose encoded size exceeds one chunk", () => {
    // 200-char previews are the realistic worst case: the schema caps preview
    // at 201, so this is close to the largest entry a producer can emit.
    const entries = Array.from({ length: 4_000 }, (unused, index) =>
      entry(`row-${index}`, "x".repeat(200)),
    );

    const chunks = chunkRowSkeleton(entries, SKELETON_CHUNK_MAX_BYTES);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(encodedEntriesBytes(chunk.entries)).toBeLessThanOrEqual(
        SKELETON_CHUNK_MAX_BYTES,
      );
    }
  });

  it("covers every entry exactly once, in order, with contiguous ordinals", () => {
    const entries = Array.from({ length: 4_000 }, (unused, index) =>
      entry(`row-${index}`, "x".repeat(200)),
    );

    const chunks = chunkRowSkeleton(entries, SKELETON_CHUNK_MAX_BYTES);

    let expectedOrdinal = 0;
    const seen: RowSkeletonEntry[] = [];
    for (const chunk of chunks) {
      expect(chunk.fromOrdinal).toBe(expectedOrdinal);
      expectedOrdinal += chunk.entries.length;
      seen.push(...chunk.entries);
    }
    expect(seen).toEqual(entries);
    expect(expectedOrdinal).toBe(entries.length);
  });

  it("marks exactly the last chunk final", () => {
    const entries = Array.from({ length: 4_000 }, (unused, index) =>
      entry(`row-${index}`, "x".repeat(200)),
    );

    const finals = chunkRowSkeleton(entries, SKELETON_CHUNK_MAX_BYTES).map(
      (chunk) => chunk.isFinal,
    );

    expect(finals.at(-1)).toBe(true);
    expect(finals.slice(0, -1).every((isFinal) => isFinal === false)).toBe(
      true,
    );
  });

  it("yields one empty FINAL chunk for an empty skeleton", () => {
    // Not zero chunks: a client that receives nothing cannot tell "this chat
    // has no rows" from "the chunks were lost".
    const chunks = chunkRowSkeleton([], SKELETON_CHUNK_MAX_BYTES);

    expect(chunks).toEqual([{ fromOrdinal: 0, entries: [], isFinal: true }]);
  });

  it("ships an over-budget entry alone rather than dropping it", () => {
    // The opposite call from the snapshot tail's, and deliberately: a tail row
    // the client can refetch is recoverable, a skeleton entry it can never
    // learn about is a hole in navigation.
    const entries = [
      entry("row-0", "a".repeat(200)),
      entry("row-1", "b".repeat(200)),
    ];

    const chunks = chunkRowSkeleton(entries, 8);

    expect(
      chunks.map((chunk) => chunk.entries.map((each) => each.rowId)),
    ).toEqual([["row-0"], ["row-1"]]);
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("clamps a caller asking for more than the frame budget", () => {
    const entries = Array.from({ length: 4_000 }, (unused, index) =>
      entry(`row-${index}`, "x".repeat(200)),
    );

    // A producer passing 64 MiB must not be able to switch the invariant off
    // from outside - the same clamp `sliceTranscriptRange` applies.
    const chunks = chunkRowSkeleton(entries, 64 * 1024 * 1024);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(encodedEntriesBytes(chunk.entries)).toBeLessThanOrEqual(
        SKELETON_CHUNK_MAX_BYTES,
      );
    }
  });
});

describe("indexChangeFits", () => {
  it("accepts a steady-state append", () => {
    const change: ChatIndexChange = {
      type: "appended",
      entries: [entry("row-1", "hello")],
    };

    expect(indexChangeFits([change], INDEX_CHANGE_MAX_BYTES)).toBe(true);
  });

  it("rejects an append too large for one frame", () => {
    const change: ChatIndexChange = {
      type: "appended",
      entries: Array.from({ length: 4_000 }, (unused, index) =>
        entry(`row-${index}`, "x".repeat(200)),
      ),
    };

    expect(indexChangeFits([change], INDEX_CHANGE_MAX_BYTES)).toBe(false);
  });

  it("rejects an updated delta too large for one frame", () => {
    const change: ChatIndexChange = {
      type: "updated",
      entries: Array.from({ length: 4_000 }, (unused, index) => ({
        ordinal: index,
        entry: entry(`row-${index}`, "x".repeat(200)),
      })),
    };

    expect(indexChangeFits([change], INDEX_CHANGE_MAX_BYTES)).toBe(false);
  });

  it("measures the whole frame, not its members one at a time", () => {
    // The reason this takes an array: a turn finishing sends an `appended` and
    // an `updated` in ONE frame, and two deltas that each fit on their own can
    // exceed the threshold together. Measuring per member would pass a frame
    // the relay then reclassifies onto the BULK lane.
    // MEASURED, not guessed. A 200-char-preview entry encodes to roughly 310
    // bytes, so the literal 220 that used to sit here made both assertions hold
    // by luck: the pair landed near 1.41x the budget and one change near 0.70x.
    // Any move in the preview cap, in `bodyDigest`, or in any other entry field
    // shifts that ratio and breaks one direction with nothing to say why.
    const measuredEntryBytes = encodedEntriesBytes([
      entry("row-measure", "x".repeat(200)),
    ]);
    const half = Math.ceil(INDEX_CHANGE_MAX_BYTES / 2 / measuredEntryBytes);
    const appended: ChatIndexChange = {
      type: "appended",
      entries: Array.from({ length: half }, (unused, index) =>
        entry(`row-a-${index}`, "x".repeat(200)),
      ),
    };
    const updated: ChatIndexChange = {
      type: "updated",
      entries: Array.from({ length: half }, (unused, index) => ({
        ordinal: index,
        entry: entry(`row-b-${index}`, "x".repeat(200)),
      })),
    };

    expect(indexChangeFits([appended], INDEX_CHANGE_MAX_BYTES)).toBe(true);
    expect(indexChangeFits([updated], INDEX_CHANGE_MAX_BYTES)).toBe(true);
    expect(indexChangeFits([appended, updated], INDEX_CHANGE_MAX_BYTES)).toBe(
      false,
    );
  });

  it("always accepts reindexed, which is the oversized-delta fallback itself", () => {
    // The producer's answer to a `false` above is to send this instead of
    // splitting the delta, so it must never be the thing that does not fit.
    expect(indexChangeFits([{ type: "reindexed" }], 0)).toBe(true);
  });

  it("still measures an array that merely CONTAINS a reindexed", () => {
    // The exemption above is for the fallback ARRAY, not for the member. An
    // exemption that fired on membership would let an oversized `appended`
    // ride along beside a `reindexed` and skip the ceiling entirely - the
    // measurement waived by the very thing that exists to make waiving
    // unnecessary.
    const oversized: ChatIndexChange = {
      type: "appended",
      entries: Array.from({ length: 4_000 }, (unused, index) =>
        entry(`row-${index}`, "x".repeat(200)),
      ),
    };

    expect(
      indexChangeFits(
        [oversized, { type: "reindexed" }],
        INDEX_CHANGE_MAX_BYTES,
      ),
    ).toBe(false);
  });

  it("clamps a caller asking for more than the frame budget", () => {
    const change: ChatIndexChange = {
      type: "appended",
      entries: Array.from({ length: 4_000 }, (unused, index) =>
        entry(`row-${index}`, "x".repeat(200)),
      ),
    };

    expect(indexChangeFits([change], 64 * 1024 * 1024)).toBe(false);
  });
});

function summary(index: number): ChatAccumulatedFileChangeSummary {
  return {
    // A realistic path: deep, hyphenated, and the kind a refactor touches by
    // the thousand. Short fixture paths are how a size guard passes while
    // saying nothing.
    filePath: `packages/app/src/features/settings/panels/section-${index}/settings-panel-row-${index}.tsx`,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    hasContents: true,
    digest: "d".repeat(64),
    counts: { additions: 120, deletions: 45 },
  };
}

/**
 * The snapshot's own budget — the one that was assertion-only.
 *
 * The tail, the skeleton chunks, the range and the index delta were each
 * budgeted by code while the SNAPSHOT measured nothing, which is the exact
 * shape `maxBytes` had before a review measured 4,378 rows producing a
 * 1,196,401-byte frame.
 */
describe("the bounded snapshot is actually bounded", () => {
  it("a broad-refactor chat's summaries would ALONE blow the frame, which is why they are chunked", () => {
    // The premise of moving them out. If this ever stops being true the
    // chunking is dead weight and someone should find out from a test rather
    // than by reasoning about it.
    const summaries = Array.from({ length: 5_000 }, (unused, index) =>
      summary(index),
    );

    expect(utf8ByteLength(JSON.stringify(summaries))).toBeGreaterThan(
      WINDOWED_SNAPSHOT_MAX_BYTES,
    );
  });

  it("chunks those summaries into frames that each fit", () => {
    const summaries = Array.from({ length: 5_000 }, (unused, index) =>
      summary(index),
    );

    const chunks = chunkByEncodedBytes(
      summaries,
      ACCUMULATED_CHANGE_CHUNK_MAX_BYTES,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8ByteLength(JSON.stringify(chunk.items))).toBeLessThanOrEqual(
        ACCUMULATED_CHANGE_CHUNK_MAX_BYTES,
      );
    }
    // Every summary exactly once, in order — a panel that reverts a subset it
    // presented as the whole set is worse than one that takes another frame.
    expect(chunks.flatMap((chunk) => chunk.items)).toEqual(summaries);
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("accepts a snapshot carrying only state-scaled aux fields", () => {
    expect(
      windowedSnapshotFitsFrame(
        { accumulatedFileChangeCount: 5_000, rowCount: 40_000, tail: {} },
        WINDOWED_SNAPSHOT_MAX_BYTES,
      ),
    ).toBe(true);
  });

  it("rejects a snapshot that would exceed the frame, whatever the field", () => {
    // Not scoped to the summaries: the guard measures the ENCODED object, so a
    // future field that grows without anyone noticing is caught by the same
    // check rather than by a new one nobody remembers to add.
    expect(
      windowedSnapshotFitsFrame(
        { somethingAddedLater: "x".repeat(WINDOWED_SNAPSHOT_MAX_BYTES) },
        WINDOWED_SNAPSHOT_MAX_BYTES,
      ),
    ).toBe(false);
  });

  it("clamps a caller asking for more than the frame budget", () => {
    expect(
      windowedSnapshotFitsFrame(
        { padding: "x".repeat(WINDOWED_SNAPSHOT_MAX_BYTES) },
        64 * 1024 * 1024,
      ),
    ).toBe(false);
  });

  /**
   * The ceiling and the relay's BULK threshold are the same 1 MiB, so a
   * snapshot that measures just under the ceiling encodes - inside the frame's
   * own `kind`/`epicId`/`chatId`, plus `encodeMuxMessageBody`'s five-byte
   * header - to just over the threshold. It is then put on the BULK lane and
   * can reorder against the interactive deltas this bound exists to keep it
   * ordered with: the check passes and the invariant breaks.
   */
  it("reserves the frame envelope, so a just-under snapshot does not just-over the wire", () => {
    // Sized to land in the reserve: over `ceiling - overhead`, under `ceiling`.
    const insideTheReserve = {
      padding: "x".repeat(
        WINDOWED_SNAPSHOT_MAX_BYTES -
          WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES / 2,
      ),
    };
    expect(utf8ByteLength(JSON.stringify(insideTheReserve))).toBeLessThan(
      WINDOWED_SNAPSHOT_MAX_BYTES,
    );
    expect(
      windowedSnapshotFitsFrame(insideTheReserve, WINDOWED_SNAPSHOT_MAX_BYTES),
    ).toBe(false);
  });

  it("still accepts a snapshot with the envelope's room to spare", () => {
    // The other side of the boundary, so the reserve cannot be satisfied by a
    // guard that simply rejects everything near the ceiling.
    const clear = {
      padding: "x".repeat(
        WINDOWED_SNAPSHOT_MAX_BYTES -
          WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES * 2,
      ),
    };
    expect(windowedSnapshotFitsFrame(clear, WINDOWED_SNAPSHOT_MAX_BYTES)).toBe(
      true,
    );
  });
});
