import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES,
  TRANSCRIPT_RANGE_MAX_BYTES,
  buildTranscriptRecordLookup,
  sliceTranscriptRange,
  type TranscriptRangeSlice,
} from "@traycer/protocol/persistence/chat-transcript/read-range";

/**
 * `sliceTranscriptRange` is the read behind `loadRange`. These pin its boundary
 * behaviour - clamping, the deliberately-unclamped inverted span, the byte
 * budget's always-serve-one rule - plus the property that only exists because
 * rows are not records: several rows can share one record set, and the budget
 * must charge for it once.
 */

function makeUserMessage(fields: {
  messageId: string;
  timestamp: number;
  text?: string;
}): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: {
      kind: "user",
      content: { type: "text", text: fields.text ?? fields.messageId },
    },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  });
}

function makeEvent(fields: { eventId: string; timestamp: number }): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: "chat.forked",
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
  });
}

function userRow(message: Message): TranscriptRowDescriptor {
  return {
    rowId: message.messageId,
    createdAt: message.timestamp,
    source: { kind: "user", messageId: message.messageId },
  };
}

function forkRow(event: ChatEvent): TranscriptRowDescriptor {
  return {
    rowId: `forked-chat-link:${event.eventId}`,
    createdAt: event.timestamp,
    source: { kind: "forked-chat-link", eventId: event.eventId },
  };
}

/** Two slices of one turn - the many-rows-one-record-set shape. */
function sliceRows(
  turnKey: string,
  messageIds: readonly string[],
  createdAt: number,
): readonly TranscriptRowDescriptor[] {
  return [0, 1].map((chunkIndex) => ({
    rowId: `assistant:${turnKey}:part:${chunkIndex}`,
    createdAt,
    source: {
      kind: "assistant-slice" as const,
      turnKey,
      messageIds,
      blockIds: [],
      chunkIndex,
      split: true,
      synthesizedBoundary: false,
    },
  }));
}

function slice(
  rows: readonly TranscriptRowDescriptor[],
  messages: readonly Message[],
  events: readonly ChatEvent[],
  request: { fromOrdinal: number; toOrdinal: number; maxBytes: number },
): TranscriptRangeSlice {
  return sliceTranscriptRange(
    rows,
    buildTranscriptRecordLookup(messages, events),
    request,
  );
}

/**
 * What a row costs the budget: its records, its row id as a JSON array
 * element, and one separator byte each. Spelled out here rather than imported
 * so the tests state the accounting instead of restating the implementation -
 * if the two ever disagree, that is the bug.
 */
function rowCost(rowId: string, records: readonly Message[]): number {
  const idBytes = Buffer.byteLength(JSON.stringify(rowId), "utf8") + 1;
  return records.reduce(
    (total, record) => total + recordByteLength(record) + 1,
    idBytes,
  );
}

/** A budget that fits exactly these rows and nothing more. */
function budgetFor(
  rows: ReadonlyArray<{ rowId: string; records: readonly Message[] }>,
): number {
  return rows.reduce(
    (total, row) => total + rowCost(row.rowId, row.records),
    TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES,
  );
}

const M0 = makeUserMessage({ messageId: "m-0", timestamp: 10 });
const M1 = makeUserMessage({ messageId: "m-1", timestamp: 20 });
const M2 = makeUserMessage({ messageId: "m-2", timestamp: 30 });
const THREE = [M0, M1, M2];
const THREE_ROWS = THREE.map(userRow);

describe("sliceTranscriptRange", () => {
  it("returns an empty slice with reachedStart and reachedEnd true for an empty transcript", () => {
    const result = slice([], [], [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: 1000,
    });

    expect(result).toEqual({
      fromOrdinal: 0,
      rowIds: [],
      messages: [],
      events: [],
      reachedStart: true,
      reachedEnd: true,
      truncatedAtOrdinal: undefined,
    });
  });

  it("treats toOrdinal as inclusive - {from:0,to:0} on a 3-row transcript serves exactly 1 row", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0"]);
    expect(result.reachedStart).toBe(true);
    expect(result.reachedEnd).toBe(false);
  });

  it("sets reachedStart and reachedEnd true for a full-span request", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 0,
      toOrdinal: 2,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0", "m-1", "m-2"]);
    expect(result.reachedStart).toBe(true);
    expect(result.reachedEnd).toBe(true);
  });

  it("sets reachedStart and reachedEnd false for a middle span", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 1,
      toOrdinal: 1,
      maxBytes: 100_000,
    });

    expect(result.fromOrdinal).toBe(1);
    expect(result.rowIds).toEqual(["m-1"]);
    expect(result.reachedStart).toBe(false);
    expect(result.reachedEnd).toBe(false);
  });

  it("a span entirely past the end is empty, NOT the last row clamped back", () => {
    // Previously this clamped `fromOrdinal` down and served row 2 while
    // reporting `fromOrdinal: 2` - an unsolicited row under an ordinal the
    // caller never asked for. The doc always said empty; the code did not.
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 10,
      toOrdinal: 20,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.reachedStart).toBe(true);
    expect(result.reachedEnd).toBe(true);
  });

  it("clamps a toOrdinal past the end and sets reachedEnd true", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 1,
      toOrdinal: 99,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-1", "m-2"]);
    expect(result.reachedEnd).toBe(true);
  });

  it("an inverted span yields an empty slice, because toOrdinal is NOT clamped up to fromOrdinal", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 2,
      toOrdinal: 0,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual([]);
    expect(result.fromOrdinal).toBe(2);
    expect(result.reachedEnd).toBe(false);
  });

  it("stops early under the byte budget, naming the first ordinal that did not fit, and clears reachedEnd even when the request named the last row", () => {
    const budget = budgetFor([
      { rowId: "m-0", records: [M0] },
      { rowId: "m-1", records: [M1] },
    ]);

    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 0,
      toOrdinal: 2,
      maxBytes: budget,
    });

    expect(result.rowIds).toEqual(["m-0", "m-1"]);
    expect(result.truncatedAtOrdinal).toBe(2);
    expect(result.reachedEnd).toBe(false);
  });

  it("always serves a single record that alone exceeds maxBytes, over budget, rather than producing a permanent hole", () => {
    const huge = makeUserMessage({
      messageId: "m-huge",
      timestamp: 40,
      text: "x".repeat(5_000),
    });
    const rows = [userRow(huge)];

    const result = slice(rows, [huge], [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: 10,
    });

    expect(result.rowIds).toEqual(["m-huge"]);
    expect(result.messages).toEqual([huge]);
  });

  it("rowIds keep the interleaved row order while messages and events split into their own arrays", () => {
    const event = makeEvent({ eventId: "e-1", timestamp: 15 });
    const rows = [userRow(M0), forkRow(event), userRow(M1)];

    const result = slice(rows, [M0, M1], [event], {
      fromOrdinal: 0,
      toOrdinal: 2,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0", "forked-chat-link:e-1", "m-1"]);
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0", "m-1"]);
    expect(result.events.map((e) => e.eventId)).toEqual(["e-1"]);
  });
});

describe("shared record sets", () => {
  it("sends a turn's records ONCE for all of its slices", () => {
    const turnRows = sliceRows("t-1", ["m-0", "m-1"], 10);

    const result = slice(turnRows, [M0, M1], [], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual([
      "assistant:t-1:part:0",
      "assistant:t-1:part:1",
    ]);
    // Two rows, one record set. Sending it per-slice would multiply the largest
    // bodies in a transcript by the number of steers in them.
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0", "m-1"]);
  });

  it("charges the budget once for a shared record set, so a second slice is free", () => {
    const turnRows = sliceRows("t-1", ["m-0", "m-1"], 10);
    // Exactly enough for the turn's records once, plus BOTH row ids. If the
    // second slice were charged for the records again it would not fit, and
    // the span would truncate at ordinal 1.
    const budget = budgetFor([
      { rowId: "assistant:t-1:part:0", records: [M0, M1] },
      { rowId: "assistant:t-1:part:1", records: [] },
    ]);

    const result = slice(turnRows, [M0, M1], [], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: budget,
    });

    expect(result.rowIds).toHaveLength(2);
    expect(result.truncatedAtOrdinal).toBeUndefined();
    expect(result.reachedEnd).toBe(true);
  });

  it("keeps a row whose record the authority no longer holds, rather than shifting every later ordinal", () => {
    const rows = [userRow(M0), userRow(M1)];

    // `m-1` is named by a row but missing from the lookup - a branch edit that
    // raced the read. The row keeps its ordinal and arrives body-less.
    const result = slice(rows, [M0], [], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0", "m-1"]);
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0"]);
  });
});

describe("the frame ceiling", () => {
  /**
   * Encodes the slice exactly as `chatRangeResponseSchema` puts it on the wire,
   * so the assertion measures the FRAME rather than the records inside it.
   * `requestId` is at its schema maximum, which is the worst case the host has
   * to survive because the client picks it.
   */
  function encodedFrameBytes(result: TranscriptRangeSlice): number {
    return Buffer.byteLength(
      JSON.stringify({
        requestId: "r".repeat(128),
        epoch: 4_294_967_295,
        fromOrdinal: result.fromOrdinal,
        rowIds: result.rowIds,
        messages: result.messages,
        events: result.events,
        reachedStart: result.reachedStart,
        reachedEnd: result.reachedEnd,
        ...(result.truncatedAtOrdinal === undefined
          ? {}
          : { truncatedAtOrdinal: result.truncatedAtOrdinal }),
      }),
      "utf8",
    );
  }

  /**
   * The review's measured shape: 4,378 records averaging ~273 encoded bytes,
   * which came to a 1,196,401-byte frame under the old accounting. The padding
   * is what makes each record that size - an unpadded fixture is small enough
   * that 4,378 of them fit inside 1 MiB, and the test would then pass without
   * ever exercising the ceiling.
   */
  function manySmallRows(count: number): {
    readonly rows: readonly TranscriptRowDescriptor[];
    readonly messages: readonly Message[];
  } {
    const messages = Array.from({ length: count }, (_unused, index) =>
      makeUserMessage({
        messageId: `m-${index}`,
        timestamp: index,
        text: `row ${index} ${"x".repeat(140)}`,
      }),
    );
    return { rows: messages.map(userRow), messages };
  }

  it("keeps the ENCODED frame under the relay threshold for thousands of small rows", () => {
    // The cold review's exact measurement: 4,378 small records under a 1 MiB
    // budget produced a 1,196,401-byte frame - 148 KB past the threshold, with
    // no oversized record anywhere in it - because the budget counted only
    // `JSON.stringify(record)` and ignored the row ids, the separators and the
    // envelope. This is the assertion that was missing.
    const { rows, messages } = manySmallRows(4_378);

    const result = slice(rows, messages, [], {
      fromOrdinal: 0,
      toOrdinal: rows.length - 1,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });

    expect(encodedFrameBytes(result)).toBeLessThanOrEqual(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
    // Truncation is the mechanism: it must have stopped early rather than
    // served everything and happened to fit.
    expect(result.truncatedAtOrdinal).toBeDefined();
    expect(result.rowIds.length).toBeLessThan(rows.length);
  });

  it("clamps a client budget larger than the invariant instead of trusting it", () => {
    const { rows, messages } = manySmallRows(4_378);

    const result = slice(rows, messages, [], {
      fromOrdinal: 0,
      toOrdinal: rows.length - 1,
      // A client asking for 64 MiB is not a reason to emit a 64 MiB frame.
      maxBytes: 64 * 1024 * 1024,
    });

    expect(encodedFrameBytes(result)).toBeLessThanOrEqual(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
  });

  it("charges the row id, so ids alone cannot push the frame over", () => {
    // Same records, ids two orders of magnitude longer. If row ids were free
    // the two slices would serve the same number of rows and the second frame
    // would be far larger.
    const { messages } = manySmallRows(4_378);
    const shortIdRows = messages.map(userRow);
    const longIdRows: TranscriptRowDescriptor[] = messages.map((message) => ({
      rowId: `${message.messageId}:${"x".repeat(200)}`,
      createdAt: message.timestamp,
      source: { kind: "user", messageId: message.messageId },
    }));

    const request = {
      fromOrdinal: 0,
      toOrdinal: messages.length - 1,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    };
    const short = slice(shortIdRows, messages, [], request);
    const long = slice(longIdRows, messages, [], request);

    expect(long.rowIds.length).toBeLessThan(short.rowIds.length);
    expect(encodedFrameBytes(long)).toBeLessThanOrEqual(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
  });

  it("still serves one oversized row over budget - a permanent hole is worse than a late frame", () => {
    const huge = makeUserMessage({
      messageId: "m-huge",
      timestamp: 1,
      text: "x".repeat(2 * 1024 * 1024),
    });

    const result = slice([userRow(huge)], [huge], [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });

    expect(result.rowIds).toEqual(["m-huge"]);
    expect(encodedFrameBytes(result)).toBeGreaterThan(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
  });
});
