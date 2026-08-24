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
    const budget = recordByteLength(M0) + recordByteLength(M1);

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
    // Exactly enough for the turn's records and not one byte more. If the
    // second slice were charged again, it would not fit and the span would
    // truncate at ordinal 1.
    const budget = recordByteLength(M0) + recordByteLength(M1);

    const result = slice(turnRows, [M0, M1], [], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: budget,
    });

    expect(result.rowIds).toHaveLength(2);
    expect(result.truncatedAtOrdinal).toBeUndefined();
    expect(result.reachedEnd).toBe(true);
  });

  it("serves a row whose record the authority no longer holds, rather than shifting every later ordinal", () => {
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
