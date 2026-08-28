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

/**
 * # The row's projection CONTEXT is part of its invalidation fingerprint
 *
 * `transcriptRowContextSchema`'s values are derived from WHOLE history: a
 * setup card's window is open until a `worktree.missing` closes it, and that
 * boundary event arrives arbitrarily later than the card's own records. The
 * card's records do not move, so every other skeleton field is byte-identical -
 * and the context rides the RANGE, not the skeleton, so there is no entry field
 * of its own to differ either.
 *
 * Absent this the host's comparison reports "unchanged", no `updated` is
 * emitted, and the client renders a historical setup card as the live one for
 * the rest of the connection.
 */
describe("row context in the body fingerprint", () => {
  function setupEvent(fields: {
    eventId: string;
    type: ChatEvent["type"];
    timestamp: number;
  }): ChatEvent {
    return chatEventSchema.parse({
      eventId: fields.eventId,
      type: fields.type,
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
      metadata: { workspacePath: "/repo" },
    });
  }

  const running = setupEvent({
    eventId: "e-running",
    type: "setup.running",
    timestamp: 1,
  });
  const succeeded = setupEvent({
    eventId: "e-succeeded",
    type: "setup.succeeded",
    timestamp: 2,
  });
  // The boundary. Not a setup event, forms no card of its own, and belongs to
  // no card's record set - so it changes the FIRST card's context and nothing
  // else about it.
  const missing = setupEvent({
    eventId: "e-missing",
    type: "worktree.missing",
    timestamp: 3,
  });

  function cardEntryFor(events: ReadonlyArray<ChatEvent>) {
    const entries = buildRowSkeleton(
      {
        messages: [],
        events: [...events],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );
    const card = entries.find((entry) => entry.role === "system");
    expect(card).toBeDefined();
    return card!;
  }

  it("moves the digest when a later event closes an earlier row's window", () => {
    const open = cardEntryFor([running, succeeded]);
    const closed = cardEntryFor([running, succeeded, missing]);

    // Sanity: the fixture really did flip only the context. Without this the
    // assertion below could pass on a fixture that changed the records too.
    expect(open.rowId).toBe(closed.rowId);
    expect(open.createdAt).toBe(closed.createdAt);
    expect(open.role).toBe(closed.role);
    expect(open.byteLength).toBe(closed.byteLength);
    expect(open.preview).toBe(closed.preview);
    expect(open.sentByAgent).toBe(closed.sentByAgent);

    expect(open.bodyDigest).not.toBe(closed.bodyDigest);
  });

  it("leaves the digest alone when the context did not move", () => {
    // The other half: the fingerprint must not report a change for a rebuild
    // that landed on the same answer, or every rebuild would evict every row.
    expect(cardEntryFor([running, succeeded]).bodyDigest).toBe(
      cardEntryFor([running, succeeded]).bodyDigest,
    );
  });
});

/**
 * # An assistant slice's DECORATING events are part of its fingerprint too
 *
 * The finding this closes named two things, and the projection context above is
 * only the first. A range serves a turn's decorating events with every slice of
 * it (`rowRecordIds`), and the renderer folds them into the elapsed counter and
 * the restore affordance - so a `checkpoint.captured` landing on a turn whose
 * rows are already hydrated changes what those rows render while `blockIds`,
 * and therefore every field of the entry, stays identical.
 *
 * The failure is the quietest kind: the row is there, and merely poorer than it
 * was - a restore dialog with no restore point.
 */
describe("decorating events in the body fingerprint", () => {
  const assistant = assistantMessage({
    messageId: "m-assistant",
    timestamp: 10,
    text: "reply",
    usage: null,
  });
  const turnId = "t-1";

  function turnEvent(fields: {
    eventId: string;
    type: ChatEvent["type"];
    timestamp: number;
  }): ChatEvent {
    return chatEventSchema.parse({
      eventId: fields.eventId,
      type: fields.type,
      timestamp: fields.timestamp,
      clientActionId: null,
      actor: null,
      message: null,
      turnId,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    });
  }

  /** The assistant record, re-parsed onto the turn the events decorate. */
  const turnAssistant = messageSchema.parse({ ...assistant, turnId });
  const started = turnEvent({
    eventId: "e-started",
    type: "turn.started",
    timestamp: 9,
  });
  const captured = turnEvent({
    eventId: "e-checkpoint",
    type: "checkpoint.captured",
    timestamp: 11,
  });

  function sliceEntryFor(events: ReadonlyArray<ChatEvent>) {
    const entries = buildRowSkeleton(
      {
        messages: [turnAssistant],
        events: [...events],
        activeTurnId: null,
        chatId: "chat-1",
      },
      previewText,
    );
    const slice = entries.find((entry) => entry.role === "assistant");
    expect(slice).toBeDefined();
    return slice!;
  }

  it("moves the digest when a checkpoint decorates an already-projected turn", () => {
    const before = sliceEntryFor([started]);
    const after = sliceEntryFor([started, captured]);

    // Sanity: the row itself did not move - only what decorates it.
    expect(before.rowId).toBe(after.rowId);
    expect(before.createdAt).toBe(after.createdAt);
    expect(before.byteLength).toBe(after.byteLength);

    expect(before.bodyDigest).not.toBe(after.bodyDigest);
  });

  it("leaves byteLength alone, because the turn's records are shared", () => {
    // Charged per ROW: billing every slice of a steered turn for the whole
    // turn's decorating events would over-estimate its height several times
    // over. The digest has no such additivity to protect - it only has to move.
    expect(sliceEntryFor([started, captured]).byteLength).toBe(
      sliceEntryFor([started]).byteLength,
    );
  });
});
