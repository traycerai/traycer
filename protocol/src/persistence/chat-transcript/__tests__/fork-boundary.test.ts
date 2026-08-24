import { describe, expect, it } from "vitest";
import {
  assistantTurnKey,
  latestForkableAssistantMessageId,
} from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
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
 * itself: the backward scan, the active-turn skip, the multi-record
 * last-write-wins id, the legacy no-turnId grouping, and the steer-only
 * skip/stopped-override pair.
 */

const AGENT_SENDER = {
  type: "agent" as const,
  harnessId: "claude",
  agentId: "agent-1",
  displayName: "Claude",
};

const USER_SENDER = { type: "user" as const, userId: "user-1" };

function textBlock(blockId: string, timestamp: number) {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "text" as const,
    text: "hi",
  };
}

function steerBlock(blockId: string, timestamp: number) {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "steer" as const,
    queueItemId: `q-${blockId}`,
    messageId: `m-${blockId}`,
    content: { type: "doc" },
  };
}

function assistantMessage(input: {
  messageId: string;
  timestamp: number;
  turnId: string | null;
  blocks: ReadonlyArray<
    ReturnType<typeof textBlock> | ReturnType<typeof steerBlock>
  >;
}): AssistantMessage {
  return assistantMessageSchema.parse({
    role: "assistant",
    messageId: input.messageId,
    sender: AGENT_SENDER,
    blocks: input.blocks,
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

describe("assistantTurnKey", () => {
  it("uses turnId when present", () => {
    const message = assistantMessage({
      messageId: "m-1",
      timestamp: 1,
      turnId: "turn-1",
      blocks: [textBlock("b-1", 1)],
    });

    expect(assistantTurnKey(message)).toBe("turn-1");
  });

  it("falls back to ts:<timestamp> for legacy turnId: null records", () => {
    const message = assistantMessage({
      messageId: "m-1",
      timestamp: 42,
      turnId: null,
      blocks: [textBlock("b-1", 42)],
    });

    expect(assistantTurnKey(message)).toBe("ts:42");
  });
});

describe("latestForkableAssistantMessageId", () => {
  it("returns null for an empty transcript", () => {
    const messages: readonly Message[] = [];

    expect(latestForkableAssistantMessageId(messages, null, new Set())).toBe(
      null,
    );
  });

  it("returns null when the transcript has only user messages", () => {
    const messages: readonly Message[] = [
      userMessage({ messageId: "u-1", timestamp: 1 }),
      userMessage({ messageId: "u-2", timestamp: 2 }),
    ];

    expect(latestForkableAssistantMessageId(messages, null, new Set())).toBe(
      null,
    );
  });

  it("returns the completed turn's messageId for one completed assistant turn", () => {
    const messages: readonly Message[] = [
      userMessage({ messageId: "u-1", timestamp: 1 }),
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 2)],
      }),
    ];

    expect(latestForkableAssistantMessageId(messages, null, new Set())).toBe(
      "a-1",
    );
  });

  it("skips the active turn when it is the last assistant turn, returning the one before it", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-2",
        timestamp: 2,
        turnId: "turn-2",
        blocks: [textBlock("b-2", 2)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(messages, "turn-2", new Set()),
    ).toBe("a-1");
  });

  it("returns null when every assistant turn is the active turn", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(messages, "turn-1", new Set()),
    ).toBe(null);
  });

  it("returns the LAST record's messageId for a multi-record turn (last write wins)", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1-first",
        timestamp: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-1-second",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [textBlock("b-2", 2)],
      }),
    ];

    expect(latestForkableAssistantMessageId(messages, null, new Set())).toBe(
      "a-1-second",
    );
  });

  it("keys legacy turnId: null records individually by timestamp", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-legacy-1",
        timestamp: 10,
        turnId: null,
        blocks: [textBlock("b-1", 10)],
      }),
      assistantMessage({
        messageId: "a-legacy-2",
        timestamp: 20,
        turnId: null,
        blocks: [textBlock("b-2", 20)],
      }),
    ];

    expect(latestForkableAssistantMessageId(messages, null, new Set())).toBe(
      "a-legacy-2",
    );
  });

  it("skips a turn whose blocks are ALL steer, falling back to the turn before it", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-2",
        timestamp: 2,
        turnId: "turn-2",
        blocks: [steerBlock("b-2", 2)],
      }),
    ];

    expect(latestForkableAssistantMessageId(messages, null, new Set())).toBe(
      "a-1",
    );
  });

  it("treats a stopped steer-only turn as a boundary", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        turnId: "turn-1",
        blocks: [textBlock("b-1", 1)],
      }),
      assistantMessage({
        messageId: "a-2",
        timestamp: 2,
        turnId: "turn-2",
        blocks: [steerBlock("b-2", 2)],
      }),
    ];

    expect(
      latestForkableAssistantMessageId(
        messages,
        null,
        new Set(["turn-2"]),
      ),
    ).toBe("a-2");
  });

  it("treats a turn with zero blocks as a boundary", () => {
    const messages: readonly Message[] = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 1,
        turnId: "turn-1",
        blocks: [],
      }),
    ];

    expect(latestForkableAssistantMessageId(messages, null, new Set())).toBe(
      "a-1",
    );
  });
});
