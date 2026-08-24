import { describe, expect, it } from "vitest";
import { chatEventSchema, type ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import { messageSchema, type Message } from "@traycer/protocol/persistence/epic/messages";
import type { CanonicalTranscriptRow } from "@traycer/protocol/persistence/chat-transcript/row-order";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import { sliceTranscriptRange } from "@traycer/protocol/persistence/chat-transcript/read-range";

/**
 * `sliceTranscriptRange` is the read behind `loadRange`. These tests pin its
 * boundary behaviour - clamping, the deliberately-unclamped inverted span,
 * and the byte budget's always-serve-one rule - per the module doc.
 */

function makeUserMessage(fields: { messageId: string; timestamp: number }): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: { type: "text", text: fields.messageId } },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  });
}

function makeEvent(fields: { eventId: string; timestamp: number }): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: "turn.started",
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

function messageRow(message: Message): CanonicalTranscriptRow {
  return { kind: "message", message };
}

function eventRow(event: ChatEvent): CanonicalTranscriptRow {
  return { kind: "event", event };
}

describe("sliceTranscriptRange", () => {
  it("returns an empty slice with reachedStart and reachedEnd true for an empty transcript", () => {
    const result = sliceTranscriptRange([], { fromOrdinal: 0, toOrdinal: 0, maxBytes: 1000 });

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
    const rows = [
      messageRow(makeUserMessage({ messageId: "m-0", timestamp: 1 })),
      messageRow(makeUserMessage({ messageId: "m-1", timestamp: 2 })),
      messageRow(makeUserMessage({ messageId: "m-2", timestamp: 3 })),
    ];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 0, toOrdinal: 0, maxBytes: 1_000_000 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe("m-0");
    expect(result.rowIds).toEqual([{ kind: "message", id: "m-0" }]);
  });

  it("sets reachedStart and reachedEnd true for a full-span request", () => {
    const rows = [
      messageRow(makeUserMessage({ messageId: "m-0", timestamp: 1 })),
      messageRow(makeUserMessage({ messageId: "m-1", timestamp: 2 })),
      messageRow(makeUserMessage({ messageId: "m-2", timestamp: 3 })),
    ];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 0, toOrdinal: 2, maxBytes: 1_000_000 });

    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0", "m-1", "m-2"]);
    expect(result.reachedStart).toBe(true);
    expect(result.reachedEnd).toBe(true);
  });

  it("sets reachedStart and reachedEnd false for a middle span", () => {
    const rows = [
      messageRow(makeUserMessage({ messageId: "m-0", timestamp: 1 })),
      messageRow(makeUserMessage({ messageId: "m-1", timestamp: 2 })),
      messageRow(makeUserMessage({ messageId: "m-2", timestamp: 3 })),
    ];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 1, toOrdinal: 1, maxBytes: 1_000_000 });

    expect(result.messages.map((m) => m.messageId)).toEqual(["m-1"]);
    expect(result.reachedStart).toBe(false);
    expect(result.reachedEnd).toBe(false);
  });

  it("clamps a fromOrdinal past the end to the last row, and reports the clamped value", () => {
    const rows = [
      messageRow(makeUserMessage({ messageId: "m-0", timestamp: 1 })),
      messageRow(makeUserMessage({ messageId: "m-1", timestamp: 2 })),
      messageRow(makeUserMessage({ messageId: "m-2", timestamp: 3 })),
    ];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 10, toOrdinal: 10, maxBytes: 1_000_000 });

    expect(result.fromOrdinal).toBe(2);
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-2"]);
    expect(result.reachedEnd).toBe(true);
  });

  it("clamps a toOrdinal past the end and sets reachedEnd true", () => {
    const rows = [
      messageRow(makeUserMessage({ messageId: "m-0", timestamp: 1 })),
      messageRow(makeUserMessage({ messageId: "m-1", timestamp: 2 })),
      messageRow(makeUserMessage({ messageId: "m-2", timestamp: 3 })),
    ];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 1, toOrdinal: 999, maxBytes: 1_000_000 });

    expect(result.messages.map((m) => m.messageId)).toEqual(["m-1", "m-2"]);
    expect(result.reachedEnd).toBe(true);
  });

  it("an inverted span (toOrdinal < fromOrdinal) yields an empty slice with reachedEnd false, because toOrdinal is NOT clamped up to fromOrdinal", () => {
    const rows = [
      messageRow(makeUserMessage({ messageId: "m-0", timestamp: 1 })),
      messageRow(makeUserMessage({ messageId: "m-1", timestamp: 2 })),
      messageRow(makeUserMessage({ messageId: "m-2", timestamp: 3 })),
    ];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 2, toOrdinal: 0, maxBytes: 1_000_000 });

    expect(result.fromOrdinal).toBe(2);
    expect(result.messages).toEqual([]);
    expect(result.rowIds).toEqual([]);
    expect(result.reachedEnd).toBe(false);
  });

  it("stops early under the byte budget, naming the first ordinal that did not fit, and clears reachedEnd even when the request named the last row", () => {
    const m0 = makeUserMessage({ messageId: "m-0", timestamp: 1 });
    const m1 = makeUserMessage({ messageId: "m-1", timestamp: 2 });
    const m2 = makeUserMessage({ messageId: "m-2", timestamp: 3 });
    const rows = [messageRow(m0), messageRow(m1), messageRow(m2)];
    const maxBytes = recordByteLength(m0) + recordByteLength(m1);

    const result = sliceTranscriptRange(rows, { fromOrdinal: 0, toOrdinal: 2, maxBytes });

    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0", "m-1"]);
    expect(result.truncatedAtOrdinal).toBe(2);
    expect(result.reachedEnd).toBe(false);
  });

  it("always serves a single record that alone exceeds maxBytes, over budget, rather than producing a permanent hole", () => {
    const m0 = makeUserMessage({ messageId: "m-0", timestamp: 1 });
    const m1 = makeUserMessage({ messageId: "m-1", timestamp: 2 });
    const rows = [messageRow(m0), messageRow(m1)];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 0, toOrdinal: 1, maxBytes: 1 });

    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0"]);
    expect(result.truncatedAtOrdinal).toBe(1);
    expect(result.reachedEnd).toBe(false);
  });

  it("rowIds carry served order and kind, and messages/events split into their own arrays while rowIds keeps the interleaved order", () => {
    const m0 = makeUserMessage({ messageId: "m-0", timestamp: 1 });
    const e1 = makeEvent({ eventId: "e-1", timestamp: 2 });
    const m1 = makeUserMessage({ messageId: "m-1", timestamp: 3 });
    const rows = [messageRow(m0), eventRow(e1), messageRow(m1)];

    const result = sliceTranscriptRange(rows, { fromOrdinal: 0, toOrdinal: 2, maxBytes: 1_000_000 });

    expect(result.rowIds).toEqual([
      { kind: "message", id: "m-0" },
      { kind: "event", id: "e-1" },
      { kind: "message", id: "m-1" },
    ]);
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0", "m-1"]);
    expect(result.events.map((e) => e.eventId)).toEqual(["e-1"]);
  });
});
