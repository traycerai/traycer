import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/senders";
import {
  buildRowSkeleton,
  type TranscriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  ROW_SKELETON_PREVIEW_MAX_CHARS,
  rowSkeletonEntrySchema,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

/**
 * `buildRowSkeleton` projects persisted messages/events to one skeleton entry
 * per transcript row. These tests pin the properties the module doc calls
 * out: human-vs-A2A preview rules, usage presence, omitted-not-undefined
 * optional keys, preview collapsing/capping, and ordinal-skipping for
 * non-materializing events.
 */

const previewText: TranscriptPreviewProjection = (content: JsonContent) =>
  content.text ?? "";

function humanUserMessage(fields: {
  messageId: string;
  timestamp: number;
  text: string;
}): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: { type: "text", text: fields.text } },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  });
}

function a2aUserMessage(fields: {
  messageId: string;
  timestamp: number;
}): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Bot",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    message: {
      kind: "agent",
      content: { type: "text", text: "hi" },
      fromAgentId: "agent-1",
      senderTitle: null,
      senderHarnessId: null,
      reply: { expectsReply: false },
    },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  });
}

function assistantMessage(fields: {
  messageId: string;
  timestamp: number;
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId: fields.messageId,
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
        blockId: `b-${fields.messageId}`,
        status: "completed",
        timestamp: fields.timestamp,
        type: "text",
        text: fields.text,
        providerNotice: null,
      },
    ],
    startedAt: null,
    timestamp: fields.timestamp,
    turnId: null,
    usage: fields.usage === null ? null : tokenUsageSchema.parse(fields.usage),
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });
}

/** An assistant turn whose only block STEERS - one steer row, no slices. */
function steeredTurn(fields: {
  messageId: string;
  timestamp: number;
  steeredMessageId: string;
  sender: UserMessageSender | null;
}): Message {
  const base = assistantMessage({
    messageId: fields.messageId,
    timestamp: fields.timestamp,
    text: "unused",
    usage: null,
  });
  return messageSchema.parse({
    ...base,
    turnId: `t-${fields.messageId}`,
    blocks: [
      {
        blockId: `b-${fields.messageId}`,
        status: "completed",
        timestamp: fields.timestamp,
        type: "steer",
        queueItemId: `q-${fields.messageId}`,
        messageId: fields.steeredMessageId,
        content: { type: "doc" },
        mode: "safe_point",
        sender: fields.sender,
      },
    ],
  });
}

function forkedChatEvent(fields: {
  eventId: string;
  timestamp: number;
}): ChatEvent {
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
    metadata: { sourceChatId: "chat-src", sourceHostId: "host-src" },
  });
}

function nonMaterializingEvent(fields: {
  eventId: string;
  timestamp: number;
}): ChatEvent {
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

describe("buildRowSkeleton", () => {
  it("produces one entry per row in canonical order, interleaving messages with row-materializing events and dropping non-materializing ones", () => {
    const human = humanUserMessage({
      messageId: "m-human",
      timestamp: 1,
      text: "hi",
    });
    const a2a = a2aUserMessage({ messageId: "m-a2a", timestamp: 2 });
    const dropped = nonMaterializingEvent({ eventId: "e-drop", timestamp: 3 });
    const assistantWithUsage = assistantMessage({
      messageId: "m-assistant",
      timestamp: 4,
      text: "reply",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    const forked = forkedChatEvent({ eventId: "e-forked", timestamp: 5 });
    const assistantNoUsage = assistantMessage({
      messageId: "m-assistant-2",
      timestamp: 6,
      text: "reply2",
      usage: null,
    });

    const entries = buildRowSkeleton(
      {
        messages: [human, a2a, assistantWithUsage, assistantNoUsage],
        events: [dropped, forked],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    expect(entries).toHaveLength(5);
    // Two rules are visible in this order, and the second one surprised the
    // author of this test:
    //
    // 1. Assistant rows are keyed by TURN, not by record. These fixtures carry
    //    `turnId: null`, so the key falls back to `ts:<timestamp>`.
    // 2. Both assistant fixtures also carry `startedAt: null`, so each turn
    //    anchors at the LAST USER TIMESTAMP (2) rather than at its own
    //    timestamp - the legacy fallback. Both turns therefore tie at 2 and
    //    sort ahead of the fork link at 5, even though one of them has
    //    `timestamp: 6`. Ordering assistant rows by the record timestamp would
    //    put the fork link between them; that is precisely the sort-key defect
    //    this projection exists to fix, so the "natural-looking" order here
    //    would be the wrong one.
    expect(entries.map((e) => e.rowId)).toEqual([
      "m-human",
      "m-a2a",
      "assistant:ts:4",
      "assistant:ts:6",
      "forked-chat-link:e-forked",
    ]);
    expect(entries[4]?.role).toBe("system");
  });

  it("gives a human user row a preview and no sentByAgent", () => {
    const human = humanUserMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "hello world",
    });

    const [entry] = buildRowSkeleton(
      {
        messages: [human],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    if (entry === undefined) throw new Error("expected an entry");
    expect(entry.preview).toBe("hello world");
    expect("sentByAgent" in entry).toBe(false);
  });

  it("gives an A2A user row sentByAgent: true and no preview", () => {
    const a2a = a2aUserMessage({ messageId: "m-1", timestamp: 1 });

    const [entry] = buildRowSkeleton(
      {
        messages: [a2a],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    if (entry === undefined) throw new Error("expected an entry");
    expect(entry.sentByAgent).toBe(true);
    expect("preview" in entry).toBe(false);
  });

  it("gives an assistant row usage when the record has one", () => {
    const assistant = assistantMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "reply",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });

    const [entry] = buildRowSkeleton(
      {
        messages: [assistant],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    if (entry === undefined) throw new Error("expected an entry");
    expect(entry.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
  });

  it("omits usage from an assistant row whose record has none", () => {
    const assistant = assistantMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "reply",
      usage: null,
    });

    const [entry] = buildRowSkeleton(
      {
        messages: [assistant],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    if (entry === undefined) throw new Error("expected an entry");
    expect("usage" in entry).toBe(false);
  });

  it("collapses whitespace runs in the preview without a leading space for leading whitespace", () => {
    const human = humanUserMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "  hello   world  ",
    });

    const [entry] = buildRowSkeleton(
      {
        messages: [human],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    if (entry === undefined) throw new Error("expected an entry");
    expect(entry.preview).toBe("hello world");
  });

  it("omits preview entirely for an all-whitespace human message, rather than an empty string", () => {
    const human = humanUserMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "   ",
    });

    const [entry] = buildRowSkeleton(
      {
        messages: [human],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    if (entry === undefined) throw new Error("expected an entry");
    expect("preview" in entry).toBe(false);
  });

  it("caps the preview at ROW_SKELETON_PREVIEW_MAX_CHARS", () => {
    const human = humanUserMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "x".repeat(250),
    });

    const [entry] = buildRowSkeleton(
      {
        messages: [human],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    if (entry === undefined) throw new Error("expected an entry");
    expect(entry.preview).toHaveLength(ROW_SKELETON_PREVIEW_MAX_CHARS);
    expect(entry.preview).toBe("x".repeat(ROW_SKELETON_PREVIEW_MAX_CHARS));
  });

  it("gives every entry a positive byteLength that grows with record size", () => {
    const small = assistantMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "hi",
      usage: null,
    });
    const large = assistantMessage({
      messageId: "m-2",
      timestamp: 2,
      text: "x".repeat(5000),
      usage: null,
    });

    const [smallEntry, largeEntry] = buildRowSkeleton(
      {
        messages: [small, large],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    expect(smallEntry?.byteLength).toBeGreaterThan(0);
    expect(largeEntry?.byteLength).toBeGreaterThan(0);
    expect(largeEntry?.byteLength ?? 0).toBeGreaterThan(
      smallEntry?.byteLength ?? 0,
    );
  });

  it("charges a steer row for the steer block AND the steered record", () => {
    // `rowRecordIds` serves both for this row - the block carries the badge,
    // mode and sender, the record carries the message - so a hint that named
    // only one of them under-reports the row. The list turns that hint into a
    // placeholder height, and an under-reported row reserves too little space,
    // which is a visible jump when the body lands.
    const steered = humanUserMessage({
      messageId: "m-steer",
      timestamp: 5,
      text: "x".repeat(4000),
    });
    const turn = steeredTurn({
      messageId: "m-turn",
      timestamp: 10,
      steeredMessageId: "m-steer",
      sender: null,
    });
    const orphaned = steeredTurn({
      messageId: "m-turn-2",
      timestamp: 20,
      // No such record: the row is the steer block alone.
      steeredMessageId: "m-gone",
      sender: null,
    });

    const withRecord = buildRowSkeleton(
      {
        messages: [steered, turn],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );
    const blockOnly = buildRowSkeleton(
      {
        messages: [orphaned],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    const steerRow = withRecord.find((entry) => entry.rowId === "m-steer");
    const orphanRow = blockOnly.find((entry) =>
      entry.rowId.startsWith("steer:"),
    );
    expect(steerRow).toBeDefined();
    expect(orphanRow?.byteLength ?? 0).toBeGreaterThan(0);
    // Against the RECORD, not against the block-only row: "bigger than a small
    // row" is true of `recordByteLength(message)` alone, so it would pass with
    // the block silently dropped. Strictly greater than the record is what
    // only the sum satisfies.
    expect(steerRow?.byteLength ?? 0).toBeGreaterThan(
      recordByteLength(steered),
    );
  });

  it("produces entries that all parse against rowSkeletonEntrySchema", () => {
    const human = humanUserMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "hi",
    });
    const a2a = a2aUserMessage({ messageId: "m-2", timestamp: 2 });
    const assistant = assistantMessage({
      messageId: "m-3",
      timestamp: 3,
      text: "reply",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const forked = forkedChatEvent({ eventId: "e-1", timestamp: 4 });

    const entries = buildRowSkeleton(
      {
        messages: [human, a2a, assistant],
        events: [forked],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    for (const entry of entries) {
      expect(() => rowSkeletonEntrySchema.parse(entry)).not.toThrow();
    }
  });

  it("an event that materializes no row occupies no ordinal", () => {
    const before = humanUserMessage({
      messageId: "m-before",
      timestamp: 1,
      text: "before",
    });
    const dropped = nonMaterializingEvent({ eventId: "e-drop", timestamp: 2 });
    const after = humanUserMessage({
      messageId: "m-after",
      timestamp: 3,
      text: "after",
    });

    const entries = buildRowSkeleton(
      {
        messages: [before, after],
        events: [dropped],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.rowId)).toEqual(["m-before", "m-after"]);
  });
  /**
   * An orphaned steer's provenance lives on the BLOCK, because the record a
   * checkpoint removed is where every other row reads it from. Getting this
   * wrong is not a cosmetic mislabel: the minimap lists human turns, so an A2A
   * steer shows up there as an "Untitled message" and then re-classifies and
   * vanishes the moment the row hydrates - the list changing under the reader
   * for a row they never touched.
   */
  it("classifies an ORPHANED steer from its block's sender", () => {
    const agentOrphan = steeredTurn({
      messageId: "m-a2a",
      timestamp: 10,
      steeredMessageId: "m-gone",
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "agent-7",
        displayName: "Bot",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
    });
    const humanOrphan = steeredTurn({
      messageId: "m-human",
      timestamp: 20,
      steeredMessageId: "m-also-gone",
      sender: { type: "user", userId: "owner-1" },
    });
    const legacyOrphan = steeredTurn({
      messageId: "m-legacy",
      timestamp: 30,
      // Persisted before the block carried a sender at all. The renderer reads
      // that as a "you" row, so the skeleton must agree rather than guess.
      steeredMessageId: "m-long-gone",
      sender: null,
    });

    const entries = buildRowSkeleton(
      {
        messages: [agentOrphan, humanOrphan, legacyOrphan],
        events: [],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );

    const steerRows = entries.filter((entry) =>
      entry.rowId.startsWith("steer:"),
    );
    expect(steerRows).toHaveLength(3);
    expect(steerRows.map((entry) => entry.sentByAgent ?? false)).toEqual([
      true,
      false,
      false,
    ]);
  });
});
