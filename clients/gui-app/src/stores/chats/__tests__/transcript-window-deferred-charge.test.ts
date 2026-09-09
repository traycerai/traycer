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
  updateWindowMessage,
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
      window = streamWindowMessage(
        window,
        "live",
        (message) => messageWithText(message, `chunk ${index} `.repeat(80)),
        null,
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

/**
 * The live term of `hydratedBytes` is maintained at exactly one site
 * (`rewriteWindowMessage`) rather than derived, so it is the one place the
 * merged definition can silently go stale. Upstream's incremental adjustment
 * covers only records the LEDGER holds; these pin the half that covers the
 * live-only ones.
 */
describe("the live term of hydratedBytes", () => {
  it("MOVES when a `now` charge rewrites a LIVE-only record", () => {
    const original = userMessage("live", 1);
    const window = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [original],
      events: [] as ChatEvent[],
    });
    const before = window.hydratedBytes;
    const grown = messageWithText(original, "x".repeat(4096));

    // A live-only record has no ledger entry, so it skips the fresh-term
    // adjustment entirely. Without the live-term delta this figure would go on
    // describing the pre-rewrite body - the case `updateWindowMessage`'s own
    // contract ("live or hydrated") reaches on an image resolving.
    const next = updateWindowMessage(window, "live", () => grown, null).window;

    expect(next.hydratedBytes).toBe(
      before + recordByteLength(grown) - recordByteLength(original),
    );
    expect(next.hydratedBytes).toBeGreaterThan(before);
  });

  it("is UNMOVED by a `deferred` charge, per the eviction gate's own premise", () => {
    const window = appendLiveRecords(emptyTranscriptWindow(), {
      messages: [userMessage("live", 1)],
      events: [] as ChatEvent[],
    });
    const before = window.hydratedBytes;

    const next = streamWindowMessage(
      window,
      "live",
      (message) => messageWithText(message, "x".repeat(4096)),
      null,
    ).window;

    // `evictWindowAfterInPlaceGrowth` is gated on this figure alone and is
    // affordable only because a streaming row cannot move it. Charging the
    // live term here would put `settleWindowBytes` back on the per-token path.
    expect(next.hydratedBytes).toBe(before);
  });
});
