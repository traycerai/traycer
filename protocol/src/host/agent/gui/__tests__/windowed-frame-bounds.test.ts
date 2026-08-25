import { describe, expect, it } from "vitest";

import {
  INDEX_CHANGE_MAX_BYTES,
  SKELETON_CHUNK_MAX_BYTES,
  chunkRowSkeleton,
  indexChangeFits,
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
  return { rowId, createdAt: 1_000, role: "user", byteLength: 42, preview };
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
    expect(finals.slice(0, -1).every((isFinal) => isFinal === false)).toBe(true);
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

    expect(chunks.map((chunk) => chunk.entries.map((each) => each.rowId))).toEqual(
      [["row-0"], ["row-1"]],
    );
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
    const half = Math.ceil(INDEX_CHANGE_MAX_BYTES / 2 / 220);
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
