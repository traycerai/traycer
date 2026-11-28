import { describe, expect, it, vi } from "vitest";

import {
  ACCUMULATED_CHANGE_CHUNK_MAX_BYTES,
  INDEX_CHANGE_MAX_BYTES,
  SKELETON_CHUNK_MAX_BYTES,
  WINDOWED_SNAPSHOT_MAX_BYTES,
  WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES,
  chunkByEncodedBytes,
  chunkRowSkeleton,
  indexChangeFits,
  windowedSnapshotEncodedBytes,
  windowedSnapshotFitsFrame,
  type ChatAccumulatedFileChangeSummary,
  type ChatIndexChange,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  RecordFingerprintMemo,
  recordByteLength,
} from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  openChatEventSchema,
  openMessageSchema,
  type OpenChatEvent,
  type OpenMessage,
} from "@traycer/protocol/persistence/epic/open-harness-records";
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
        windowedSnapshotEncodedBytes(
          { accumulatedFileChangeCount: 5_000, rowCount: 40_000, tail: {} },
          null,
        ),
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
        windowedSnapshotEncodedBytes(
          { somethingAddedLater: "x".repeat(WINDOWED_SNAPSHOT_MAX_BYTES) },
          null,
        ),
        WINDOWED_SNAPSHOT_MAX_BYTES,
      ),
    ).toBe(false);
  });

  it("clamps a caller asking for more than the frame budget", () => {
    expect(
      windowedSnapshotFitsFrame(
        windowedSnapshotEncodedBytes(
          { padding: "x".repeat(WINDOWED_SNAPSHOT_MAX_BYTES) },
          null,
        ),
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
      windowedSnapshotFitsFrame(
        windowedSnapshotEncodedBytes(insideTheReserve, null),
        WINDOWED_SNAPSHOT_MAX_BYTES,
      ),
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
    expect(
      windowedSnapshotFitsFrame(
        windowedSnapshotEncodedBytes(clear, null),
        WINDOWED_SNAPSHOT_MAX_BYTES,
      ),
    ).toBe(true);
  });
});

/**
 * `windowedSnapshotEncodedBytes` with `tailRecords` replaces a whole-snapshot
 * stringify with one over the snapshot minus its records, plus each record's
 * memoised size. These pin that the substitution is EXACT - the ceiling it
 * feeds is a hard one - and that it really does not encode a record again.
 */
describe("windowedSnapshotEncodedBytes with the tail's record sizes", () => {
  function userMessage(messageId: string, text: string): OpenMessage {
    return openMessageSchema.parse({
      role: "user",
      messageId,
      sender: { type: "user", userId: "u-1" },
      message: { kind: "user", content: { type: "text", text } },
      timestamp: 1_000,
      sessionAnchor: null,
    });
  }

  function assistantMessage(messageId: string, text: string): OpenMessage {
    return openMessageSchema.parse({
      role: "assistant",
      messageId,
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "agent-1",
        displayName: null,
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          blockId: `b-${messageId}`,
          status: "completed",
          timestamp: 1_001,
          type: "text",
          text,
          providerNotice: null,
        },
      ],
      startedAt: null,
      timestamp: 1_001,
      turnId: null,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      imageResolutions: [],
    });
  }

  function chatEvent(eventId: string, message: string): OpenChatEvent {
    return openChatEventSchema.parse({
      eventId,
      type: "turn.started",
      timestamp: 1_002,
      clientActionId: null,
      actor: null,
      message,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    });
  }

  interface Records {
    readonly messages: OpenMessage[];
    readonly events: OpenChatEvent[];
  }

  /** `count` messages (alternating roles) and `count` events carrying `text`. */
  function recordsCarrying(text: string, count: number): Records {
    return {
      messages: Array.from({ length: count }, (unused, index) =>
        index % 2 === 0
          ? userMessage(`m-${index}`, `${text} ${index}`)
          : assistantMessage(`m-${index}`, `${text} ${index}`),
      ),
      events: Array.from({ length: count }, (unused, index) =>
        chatEvent(`e-${index}`, `${text} ${index}`),
      ),
    };
  }

  /** The snapshot, with the tail's arrays being the very arrays in `records`. */
  function snapshotOf(records: Records, padding: string) {
    return {
      rowCount: 40_000,
      accumulatedFileChangeCount: 5_000,
      padding,
      tail: {
        epoch: 3,
        fromOrdinal: 10,
        messages: records.messages,
        events: records.events,
        hasMore: true,
      },
      queue: [{ text: "é中😀" }],
    };
  }

  const TEXTS = [
    ["ASCII", "plain ascii text"],
    ["multi-byte", "caf\u00e9 \u4e2d\u6587 \u00e9\u00e9"],
    ["astral", "\u{1F600} \u{1F680} done \u{1F600}"],
    [
      "escape-heavy",
      'she said "hi" \\ C:\\dir\\file\nline\ttab \u0001\u001f end \uD800',
    ],
  ] as const;

  const SHAPES = [
    ["empty arrays", 0],
    ["one record per array", 1],
    ["many records per array", 40],
  ] as const;

  describe.each(TEXTS)("%s text", (unusedName, text) => {
    describe.each(SHAPES)("%s", (unusedShape, count) => {
      it("matches the bytes of the whole snapshot with recordByteLength", () => {
        const records = recordsCarrying(text, count);
        const snapshot = snapshotOf(records, "pad");

        expect(
          windowedSnapshotEncodedBytes(snapshot, {
            messages: records.messages,
            events: records.events,
            recordBytes: recordByteLength,
          }),
        ).toBe(utf8ByteLength(JSON.stringify(snapshot)));
      });

      it("matches the bytes of the whole snapshot with a fingerprint memo", () => {
        const records = recordsCarrying(text, count);
        const snapshot = snapshotOf(records, "pad");
        const memo = new RecordFingerprintMemo();

        expect(
          windowedSnapshotEncodedBytes(snapshot, {
            messages: records.messages,
            events: records.events,
            recordBytes: (record) => memo.lookup(record).byteLength,
          }),
        ).toBe(utf8ByteLength(JSON.stringify(snapshot)));
      });
    });
  });

  it("matches the whole snapshot when only one of the two arrays is empty", () => {
    const full = recordsCarrying("only messages \u00e9", 5);
    const messagesOnly = { messages: full.messages, events: [] };
    const eventsOnly = { messages: [], events: full.events };

    for (const records of [messagesOnly, eventsOnly]) {
      const snapshot = snapshotOf(records, "pad");
      expect(
        windowedSnapshotEncodedBytes(snapshot, {
          ...records,
          recordBytes: recordByteLength,
        }),
      ).toBe(utf8ByteLength(JSON.stringify(snapshot)));
    }
  });

  describe("at the edge of the frame bound", () => {
    const LIMIT = WINDOWED_SNAPSHOT_MAX_BYTES;

    /**
     * A snapshot whose exact encoded size plus the frame overhead is
     * `target`. Its padding is ASCII, so each character is one byte.
     */
    function snapshotWithOverheadTotalling(records: Records, target: number) {
      const baseline = utf8ByteLength(JSON.stringify(snapshotOf(records, "")));
      const snapshot = snapshotOf(
        records,
        "x".repeat(target - WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES - baseline),
      );
      expect(
        utf8ByteLength(JSON.stringify(snapshot)) +
          WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES,
      ).toBe(target);
      return snapshot;
    }

    it.each([
      ["one byte under the limit fits", LIMIT - 1, true],
      ["exactly at the limit does not fit", LIMIT, false],
    ])(
      "%s, by the record sizes and by the whole measure alike",
      (unused, target, fits) => {
        const records = recordsCarrying(
          'multi-byte \u00e9\u4e2d\u{1F600} "q"\n',
          300,
        );
        const snapshot = snapshotWithOverheadTotalling(records, target);
        const memo = new RecordFingerprintMemo();

        const byRecords = windowedSnapshotEncodedBytes(snapshot, {
          messages: records.messages,
          events: records.events,
          recordBytes: (record) => memo.lookup(record).byteLength,
        });
        const whole = windowedSnapshotEncodedBytes(snapshot, null);

        expect(byRecords).toBe(whole);
        expect(windowedSnapshotFitsFrame(byRecords, LIMIT)).toBe(fits);
        expect(windowedSnapshotFitsFrame(whole, LIMIT)).toBe(fits);
      },
    );
  });

  it("measures whole, exactly, when the named arrays are copies of the snapshot's own", () => {
    const records = recordsCarrying('copy \u00e9 \u{1F600} "', 6);
    const copiedMessages = { ...snapshotOf(records, "pad") };
    copiedMessages.tail = {
      ...copiedMessages.tail,
      messages: [...records.messages],
    };
    const copiedEvents = { ...snapshotOf(records, "pad") };
    copiedEvents.tail = { ...copiedEvents.tail, events: [...records.events] };

    for (const snapshot of [copiedMessages, copiedEvents]) {
      const recordBytes = vi.fn(recordByteLength);

      expect(
        windowedSnapshotEncodedBytes(snapshot, {
          messages: records.messages,
          events: records.events,
          recordBytes,
        }),
      ).toBe(utf8ByteLength(JSON.stringify(snapshot)));
      expect(recordBytes).not.toHaveBeenCalled();
    }
  });

  it("stringifies once, and never a record or a snapshot still carrying its tail", () => {
    const records = recordsCarrying('stringify \u00e9 \u{1F600} "q"', 20);
    const snapshot = snapshotOf(records, "pad");
    const memo = new RecordFingerprintMemo();
    // Warmed before the spy: a memo miss encodes the record, which is the
    // producer's one encoding and not this function's.
    for (const record of [...records.messages, ...records.events]) {
      memo.lookup(record);
    }
    const stringify = vi.spyOn(JSON, "stringify");
    let measured: number;
    let stringified: unknown[];
    try {
      measured = windowedSnapshotEncodedBytes(snapshot, {
        messages: records.messages,
        events: records.events,
        recordBytes: (record) => memo.lookup(record).byteLength,
      });
      stringified = stringify.mock.calls.map((call) => call[0]);
    } finally {
      stringify.mockRestore();
    }

    expect(stringified).toHaveLength(1);
    const argument: unknown = stringified[0];
    expect(argument).not.toBe(snapshot);
    expect(records.messages).not.toContain(argument);
    expect(records.events).not.toContain(argument);
    expect(argument).toMatchObject({ tail: { messages: [], events: [] } });
    expect(measured).toBe(utf8ByteLength(JSON.stringify(snapshot)));
  });
});
