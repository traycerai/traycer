/**
 * HIGH-1: the deferred streaming path must not stringify the live set
 * per delta. `recordByteLength` is uncached `JSON.stringify`; a spy on
 * it is the pin that the previous chargedWindowBytes-on-deferred path
 * would fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  appendLiveRecords,
  emptyTranscriptWindow,
  settleWindowBytes,
  streamWindowMessage,
} from "@/stores/chats/transcript-window";

vi.mock(
  "@traycer/protocol/persistence/chat-transcript/record-bytes",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer/protocol/persistence/chat-transcript/record-bytes")
      >();
    const original = actual.recordByteLength;
    return {
      ...actual,
      recordByteLength: vi.fn((record: Parameters<typeof original>[0]) =>
        original(record),
      ),
    };
  },
);

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

function messageWithText(message: Message, text: string): Message {
  if (message.role !== "user") return message;
  return {
    ...message,
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [],
    },
  };
}

describe("deferred streaming charge", () => {
  beforeEach(() => {
    vi.mocked(recordByteLength).mockClear();
  });

  it("does not serialize the live row across N deferred deltas, then serializes at settle", () => {
    let window = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage("live", 1)],
      events: [] as ChatEvent[],
    });
    vi.mocked(recordByteLength).mockClear();

    const deltaCount = 20;
    for (let index = 0; index < deltaCount; index += 1) {
      window = streamWindowMessage(window, "live", (message) =>
        messageWithText(message, `chunk ${index} `.repeat(80)),
      ).window;
    }

    expect(vi.mocked(recordByteLength)).toHaveBeenCalledTimes(0);
    expect(window.unsettledByteMessageIds).toEqual(["live"]);

    const settled = settleWindowBytes(window);
    expect(vi.mocked(recordByteLength)).toHaveBeenCalledTimes(
      settled.liveMessages.length + settled.liveEvents.length,
    );
    expect(settled.unsettledByteMessageIds).toEqual([]);
    expect(settled.hydratedBytes).toBeGreaterThan(window.hydratedBytes);
  });
});
