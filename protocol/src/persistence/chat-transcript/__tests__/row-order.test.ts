import { describe, expect, it } from "vitest";
import type {
  ChatEvent,
  ChatEventType,
} from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";
import {
  buildCanonicalTranscriptRows,
  compareCanonicalRowOrder,
  eventMaterializesTranscriptRow,
  sortIntoCanonicalRowOrder,
  type CanonicalRowOrderKey,
} from "@traycer/protocol/persistence/chat-transcript/row-order";

/**
 * `row-order.ts` is the one definition the host (numbering rows) and the
 * renderer (drawing them) both trust. If it drifts, bodies render under the
 * wrong rows - see the module doc. These tests pin the properties that
 * matter, not the code shape.
 */

function makeChatEvent(fields: {
  eventId: string;
  type: ChatEventType;
  timestamp: number;
  message: string | null;
  metadata: Record<string, unknown> | null;
}): ChatEvent {
  return {
    eventId: fields.eventId,
    type: fields.type,
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: fields.message,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: fields.metadata,
  };
}

function makeUserMessage(fields: {
  messageId: string;
  timestamp: number;
}): Message {
  return {
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: {} },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  };
}

describe("compareCanonicalRowOrder", () => {
  it("sorts ascending by createdAt", () => {
    const rows: CanonicalRowOrderKey[] = [
      { createdAt: 30 },
      { createdAt: 10 },
      { createdAt: 20 },
    ];

    const sorted = [...rows].sort(compareCanonicalRowOrder);

    expect(sorted.map((row) => row.createdAt)).toEqual([10, 20, 30]);
  });

  it("keeps input order for ties, even when a plausible id tiebreak would reverse it", () => {
    // Every row shares createdAt=5. Ids are chosen so that sorting by id
    // ascending would produce the REVERSE of input order - if someone
    // "improves" the comparator with an id tiebreak, this assertion flips.
    const rows: Array<CanonicalRowOrderKey & { readonly id: string }> = [
      { id: "c", createdAt: 5 },
      { id: "b", createdAt: 5 },
      { id: "a", createdAt: 5 },
    ];

    const sorted = [...rows].sort(compareCanonicalRowOrder);

    expect(sorted.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });
});

describe("sortIntoCanonicalRowOrder", () => {
  it("does not mutate its input array", () => {
    const rows: ReadonlyArray<{ readonly id: string; readonly createdAt: number }> =
      [
        { id: "b", createdAt: 2 },
        { id: "a", createdAt: 1 },
      ];
    const original = [...rows];

    const sorted = sortIntoCanonicalRowOrder(rows, (row) => ({
      createdAt: row.createdAt,
    }));

    expect(rows).toEqual(original);
    expect(sorted.map((row) => row.id)).toEqual(["a", "b"]);
    expect(sorted).not.toBe(rows);
  });
});

describe("eventMaterializesTranscriptRow", () => {
  it("returns true for chat.forked with both sourceChatId and sourceHostId", () => {
    const event = makeChatEvent({
      eventId: "e-1",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "chat-1", sourceHostId: "host-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns false for chat.forked with metadata: null", () => {
    const event = makeChatEvent({
      eventId: "e-2",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: null,
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked missing sourceHostId", () => {
    const event = makeChatEvent({
      eventId: "e-3",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "chat-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked missing sourceChatId", () => {
    const event = makeChatEvent({
      eventId: "e-4",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceHostId: "host-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked with a non-string sourceChatId", () => {
    const event = makeChatEvent({
      eventId: "e-5",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: 42, sourceHostId: "host-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked with a non-string sourceHostId", () => {
    const event = makeChatEvent({
      eventId: "e-6",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "chat-1", sourceHostId: 42 },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns true for send.failed with a message and metadata.notificationAnchor === true", () => {
    const event = makeChatEvent({
      eventId: "e-7",
      type: "send.failed",
      timestamp: 1,
      message: "delivery failed",
      metadata: { notificationAnchor: true },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns false for send.failed with a message but no notificationAnchor", () => {
    const event = makeChatEvent({
      eventId: "e-8",
      type: "send.failed",
      timestamp: 1,
      message: "delivery failed",
      metadata: null,
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for send.failed with notificationAnchor: true but message: null", () => {
    const event = makeChatEvent({
      eventId: "e-9",
      type: "send.failed",
      timestamp: 1,
      message: null,
      metadata: { notificationAnchor: true },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for an unrelated event type", () => {
    const event = makeChatEvent({
      eventId: "e-10",
      type: "turn.started",
      timestamp: 1,
      message: "some message",
      metadata: { notificationAnchor: true, sourceChatId: "x", sourceHostId: "y" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });
});

describe("buildCanonicalTranscriptRows", () => {
  it("interleaves messages and row-materializing events into one ordinal space, dropping non-materializing events without consuming an ordinal", () => {
    const first = makeUserMessage({ messageId: "m-1", timestamp: 1 });
    // A droppable event sits BETWEEN the two messages in time. If the
    // function mistakenly reserved it an ordinal, the second message would
    // land at ordinal 2 instead of 1 - the exact off-by-one this function
    // exists to prevent.
    const droppable = makeChatEvent({
      eventId: "e-drop",
      type: "turn.started",
      timestamp: 2,
      message: null,
      metadata: null,
    });
    const second = makeUserMessage({ messageId: "m-2", timestamp: 3 });

    const rows = buildCanonicalTranscriptRows([first, second], [droppable]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: "message", message: first });
    expect(rows[1]).toEqual({ kind: "message", message: second });
  });

  it("gives a row-materializing event its own ordinal, ordered by timestamp among messages", () => {
    const before = makeUserMessage({ messageId: "m-before", timestamp: 1 });
    const forked = makeChatEvent({
      eventId: "e-forked",
      type: "chat.forked",
      timestamp: 2,
      message: null,
      metadata: { sourceChatId: "chat-1", sourceHostId: "host-1" },
    });
    const after = makeUserMessage({ messageId: "m-after", timestamp: 3 });

    const rows = buildCanonicalTranscriptRows([before, after], [forked]);

    expect(rows).toEqual([
      { kind: "message", message: before },
      { kind: "event", event: forked },
      { kind: "message", message: after },
    ]);
  });
});
