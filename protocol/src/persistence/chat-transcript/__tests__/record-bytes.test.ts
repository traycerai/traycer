import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";

/**
 * These pin `recordByteLength`, which is the only thing this module adds: the counting itself is `utils/text/utf8`'s `utf8ByteLength`, shared with the A2A size gate.
 * So a lone surrogate costs SIX bytes through this path, not the three its UTF-8 replacement character would cost - the counter never sees a raw one from here.
 */

function makeEvent(message: string): ChatEvent {
  return chatEventSchema.parse({
    eventId: "e-1",
    type: "turn.started",
    timestamp: 1,
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

function byteDelta(char: string): number {
  const base = recordByteLength(makeEvent(""));
  const withChar = recordByteLength(makeEvent(char));
  return withChar - base;
}

describe("recordByteLength", () => {
  it("counts an ASCII character as 1 byte", () => {
    const delta = byteDelta("a");

    expect(delta).toBe(1);
    expect(delta).toBe(Buffer.byteLength("a", "utf8"));
  });

  it("counts a 2-byte character (é) correctly", () => {
    const delta = byteDelta("é");

    expect(delta).toBe(2);
    expect(delta).toBe(Buffer.byteLength("é", "utf8"));
  });

  it("counts a 3-byte character (中) correctly", () => {
    const delta = byteDelta("中");

    expect(delta).toBe(3);
    expect(delta).toBe(Buffer.byteLength("中", "utf8"));
  });

  it("counts a 4-byte surrogate pair (😀) as one code point, not two 3-byte surrogates", () => {
    const delta = byteDelta("😀");

    expect(delta).toBe(4);
    expect(delta).toBe(Buffer.byteLength("😀", "utf8"));
  });

  it("a lone surrogate is escaped by JSON.stringify to a 6-byte ASCII sequence before reaching the counter", () => {
    const delta = byteDelta("\uD800");

    expect(delta).toBe(6);
  });
});
