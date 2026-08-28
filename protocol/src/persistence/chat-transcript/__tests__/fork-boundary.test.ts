import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  assistantTurnKey,
  latestForkableAssistantMessageId,
} from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import {
  projectTranscriptRows,
  type TranscriptRowDescriptor,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  assistantMessageSchema,
  userMessageSchema,
  type AssistantMessage,
  type Message,
  type UserMessage,
} from "@traycer/protocol/persistence/epic/messages";

/**
 * `latestForkableAssistantMessageId` is the shared derivation the renderer's
 * own scan must agree with (see the module doc on `fork-boundary.ts`); the
 * equivalence side of that lives in gui-app. These tests pin the derivation
 * itself: the backward scan over PROJECTED ROWS, the active-turn skip, the
 * walk-order id inside a multi-record turn, the legacy no-turnId grouping, the
 * steer-only skip / stopped-override pair, and - the reason this function reads
 * rows at all - the two ways a checkpoint restore drives projection order and
 * display order apart.
 */

const AGENT_SENDER = {
  type: "agent" as const,
  harnessId: "claude",
  agentId: "agent-1",
  displayName: "Claude",
};

const USER_SENDER = { type: "user" as const, userId: "user-1" };

const NO_EVENTS: readonly ChatEvent[] = [];

/*
 * These build FULL blocks rather than relying on the schema's defaults to fill
 * the gaps. The fixtures are typed `ContentBlock` - the schema's OUTPUT type -
 * so every field a parsed block carries has to be here. That is not pedantry:
 * the first version of these helpers was typed `ReturnType<typeof textBlock>`,
 * which infers the shape from whatever the literal happens to contain, so an
 * incomplete fixture type-checked against itself and asserted nothing about
 * agreeing with a real block. Naming the concrete type is what surfaced it.
 */
function textBlock(blockId: string, timestamp: number): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "text" as const,
    text: "hi",
    providerNotice: null,
  };
}

function steerBlock(blockId: string, timestamp: number): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "steer" as const,
    queueItemId: `q-${blockId}`,
    messageId: `m-${blockId}`,
    content: { type: "doc" },
    mode: "safe_point" as const,
    sender: null,
  };
}

function assistantMessage(input: {
  messageId: string;
  timestamp: number;
  startedAt: number | null;
  turnId: string | null;
  blocks: ReadonlyArray<ContentBlock>;
}): AssistantMessage {
  return assistantMessageSchema.parse({
    role: "assistant",
    messageId: input.messageId,
    sender: AGENT_SENDER,
    blocks: input.blocks,
    startedAt: input.startedAt,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
  });
}

function userMessage(input: {
  messageId: string;
  timestamp: number;
}): UserMessage {
  return userMessageSchema.parse({
    role: "user",
    messageId: input.messageId,
    sender: USER_SENDER,
    message: { kind: "user", content: { type: "doc" } },
    timestamp: input.timestamp,
    sessionAnchor: null,
  });
}

function turnStoppedEvent(input: {
  eventId: string;
  turnId: string;
  timestamp: number;
}): ChatEvent {
  return chatEventSchema.parse({
    eventId: input.eventId,
    type: "turn.stopped",
    timestamp: input.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: input.turnId,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
  });
}

/**
 * The projection the host feeds this derivation, built the same way
 * `chat-transcript-view.ts` builds it.
 *
 * Going through `projectTranscriptRows` rather than hand-writing descriptors is
 * the point of these tests: the ordering and the walk-order `messageIds` are
 * the projection's, so a change there that moves the fork boundary fails here.
 */
function rowsFor(
  messages: readonly Message[],
  events: readonly ChatEvent[],
  activeTurnId: string | null,
): readonly TranscriptRowDescriptor[] {
  return projectTranscriptRows({
    messages,
    events,
    activeTurnId,
    chatId: "chat-1",
  });
}

describe("assistantTurnKey", () => {
  it("uses turnId when present", () => {
    const message = assistantMessage({
      messageId: "m-1",
      timestamp: 1,
      startedAt: 1,
      turnId: "turn-1",
      blocks: [textBlock("b-1", 1)],
    });

    expect(assistantTurnKey(message)).toBe("turn-1");
  });

  it("falls back to ts:<timestamp> for legacy turnId: null records", () => {
    const message = assistantMessage({
      messageId: "m-1",
      timestamp: 42,
      startedAt: null,
      turnId: null,
      blocks: [textBlock("b-1", 42)],
    });

    expect(assistantTurnKey(message)).toBe("ts:42");
  });
});

describe("latestForkableAssistantMessageId", () => {
  it("returns null for an empty transcript", () => {
    expect(
      latestForkableAssistantMessageId(rowsFor([], NO_EVENTS, null), null),
    ).toBe(null);
  });

  it("returns null when the transcript has only user messages", () => {
    const messages: readonly Message[] = [
      userMessage({ messageId: "u-1", timestamp: 1 }),
      userMessage({ messageId: "u-2", timestamp: 2 }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe(null);
  });

  it("returns the completed turn's messageId for one completed assistant turn", () => {
    const messages: readonly Message[] = [
      userMessage({ messageId: "u-1", timestamp: 1 }),
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        startedAt: 2,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 2)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe("a-1");
  });

  it("skips the active turn when it is the last assistant turn, returning the one before it", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        startedAt: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-2",
        timestamp: 2,
        startedAt: 2,
        turnId: "turn-2",
        blocks: [textBlock("b-2", 2)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, "turn-2"),
        "turn-2",
      ),
    ).toBe("a-1");
  });

  it("returns null when every assistant turn is the active turn", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        startedAt: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, "turn-1"),
        "turn-1",
      ),
    ).toBe(null);
  });

  it("returns the LAST record's messageId for a multi-record turn (walk order wins)", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1-first",
        timestamp: 1,
        startedAt: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-1-second",
        timestamp: 2,
        startedAt: 2,
        turnId: "turn-1",
        blocks: [textBlock("b-2", 2)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe("a-1-second");
  });

  it("keys legacy turnId: null records individually by timestamp", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-legacy-1",
        timestamp: 10,
        startedAt: null,
        turnId: null,
        blocks: [textBlock("b-1", 10)],
      }),
      assistantMessage({
        messageId: "a-legacy-2",
        timestamp: 20,
        startedAt: null,
        turnId: null,
        blocks: [textBlock("b-2", 20)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe("a-legacy-2");
  });

  it("skips a turn whose blocks are ALL steer, falling back to the turn before it", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        startedAt: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-2",
        timestamp: 2,
        startedAt: 2,
        turnId: "turn-2",
        blocks: [steerBlock("b-2", 2)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe("a-1");
  });

  it("treats a stopped steer-only turn as a boundary, via its synthesized trailing row", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        startedAt: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-2",
        timestamp: 2,
        startedAt: 2,
        turnId: "turn-2",
        blocks: [steerBlock("b-2", 2)],
      }),
    ];
    const events: readonly ChatEvent[] = [
      turnStoppedEvent({ eventId: "e-1", turnId: "turn-2", timestamp: 3 }),
    ];

    expect(
      latestForkableAssistantMessageId(rowsFor(messages, events, null), null),
    ).toBe("a-2");
  });

  it("treats a turn with zero blocks as a boundary", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        startedAt: 1,
        turnId: "turn-1",
        blocks: [],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe("a-1");
  });

  /*
   * The two shapes the pre-rows derivation could not get right at once. Both
   * model a checkpoint restore: `upsertEntry` appends a re-added record at the
   * array TAIL while its timestamp - and so its display position - stays
   * historical.
   */

  it("does not let an older turn's re-appended record steal the boundary", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1000,
        startedAt: 1000,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1000)],
      }),
      assistantMessage({
        messageId: "a-2",
        timestamp: 2000,
        startedAt: 2000,
        turnId: "turn-2",
        blocks: [textBlock("b-2", 2000)],
      }),
      // Restored: belongs to the OLDER turn, sits at the projection tail.
      assistantMessage({
        messageId: "a-1-restored",
        timestamp: 1100,
        startedAt: 1100,
        turnId: "turn-1",
        blocks: [textBlock("b-3", 1100)],
      }),
    ];

    // Display order still ends on turn-2, so turn-2 is the boundary. Scanning
    // the RECORDS backwards would answer `a-1-restored`.
    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe("a-2");
  });

  it("takes a restored turn's id in walk order, not in timestamp order", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1-late",
        timestamp: 2000,
        startedAt: 2000,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 2000)],
      }),
      // Restored sibling of the SAME turn, re-added after it.
      assistantMessage({
        messageId: "a-1-early",
        timestamp: 1000,
        startedAt: 1000,
        turnId: "turn-1",
        blocks: [textBlock("b-2", 1000)],
      }),
    ];

    // The renderer's accumulator keeps the last record it WALKED, so the
    // boundary is `a-1-early`. Sorting the records by timestamp first would
    // answer `a-1-late`.
    expect(
      latestForkableAssistantMessageId(
        rowsFor(messages, NO_EVENTS, null),
        null,
      ),
    ).toBe("a-1-early");
  });
});
