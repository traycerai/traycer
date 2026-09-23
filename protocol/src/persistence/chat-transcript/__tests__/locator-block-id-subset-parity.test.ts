import { describe, expect, it } from "vitest";
import { transcriptLocatorBlockId } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";

/**
 * `transcriptLocatorBlockId` is exported for a reader that holds only the
 * messages that CAN match. Handed exactly the carrying subset, in transcript
 * order, it must answer as over the whole transcript.
 */

function assistant(
  messageId: string,
  timestamp: number,
  blocks: ReadonlyArray<Record<string, unknown>>,
): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: null,
    timestamp,
    turnId: `turn-${messageId}`,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });
}

function user(messageId: string, timestamp: number): Message {
  return messageSchema.parse({
    role: "user",
    messageId,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: { type: "text", text: "hi" } },
    timestamp,
    sessionAnchor: null,
  });
}

function send(fields: {
  blockId: string;
  receiver: string;
  text: string;
  startedAt: number | null;
  timestamp: number;
  receiptMessageId: string | null;
}): Record<string, unknown> {
  return {
    type: "tool_call",
    blockId: fields.blockId,
    status: "completed",
    timestamp: fields.timestamp,
    startedAt: fields.startedAt,
    toolName: "SendMessage",
    error: null,
    agentMessageSend: {
      receiverAgentId: fields.receiver,
      message: fields.text,
      responseId: null,
      expectReply: false,
    },
    agentMessageReceipt:
      fields.receiptMessageId === null
        ? null
        : {
            receiverAgentId: fields.receiver,
            messageId: fields.receiptMessageId,
          },
  };
}

function plan(blockId: string, approvalId: string | null): Record<string, unknown> {
  return {
    type: "plan",
    blockId,
    status: "completed",
    timestamp: 5,
    planStatus: "awaiting_approval",
    planId: `plan-${blockId}`,
    harnessId: "claude",
    source: { harnessId: "claude", kind: "provider-plan" },
    approvalId,
  };
}

function plainTool(blockId: string): Record<string, unknown> {
  return {
    type: "tool_call",
    blockId,
    status: "completed",
    timestamp: 5,
    toolName: "Read",
    error: null,
  };
}

const messages: readonly Message[] = [
  user("u1", 1),
  assistant("m1", 10, [
    plainTool("plain-1"),
    send({
      blockId: "send-a",
      receiver: "agent-r",
      text: "ping",
      startedAt: 100,
      timestamp: 100,
      receiptMessageId: "rcpt-1",
    }),
    plan("plan-x", "appr-1"),
  ]),
  assistant("m2", 20, [
    // Same receiver/text, equidistant from a target at 110 as send-a (100).
    send({
      blockId: "send-tie",
      receiver: "agent-r",
      text: "ping",
      startedAt: 120,
      timestamp: 120,
      receiptMessageId: null,
    }),
    // Different receiver: never a candidate.
    send({
      blockId: "send-other-receiver",
      receiver: "agent-z",
      text: "ping",
      startedAt: 110,
      timestamp: 110,
      receiptMessageId: "rcpt-2",
    }),
    plan("plan-noappr", null),
  ]),
  user("u2", 30),
  assistant("m3", 40, [
    // No startedAt: falls back to the block timestamp.
    send({
      blockId: "send-fallback",
      receiver: "agent-r",
      text: "ping",
      startedAt: null,
      timestamp: 300,
      receiptMessageId: "rcpt-1",
    }),
    plan("plan-y", "appr-1"),
    plan("plan-z", "appr-2"),
  ]),
];

function carriesSend(message: Message, receiverAgentId: string): boolean {
  if (message.role !== "assistant") return false;
  return message.blocks.some(
    (block) =>
      block.type === "tool_call" &&
      block.agentMessageSend?.receiverAgentId === receiverAgentId,
  );
}

function carriesReceipt(message: Message, receiptId: string): boolean {
  if (message.role !== "assistant") return false;
  return message.blocks.some(
    (block) =>
      block.type === "tool_call" &&
      block.agentMessageReceipt?.messageId === receiptId,
  );
}

function carriesApproval(message: Message, approvalId: string): boolean {
  if (message.role !== "assistant") return false;
  return message.blocks.some(
    (block) => block.type === "plan" && block.approvalId === approvalId,
  );
}

describe("transcriptLocatorBlockId: carrying-subset parity", () => {
  it("sent-message over the receiver-carrying subset equals the whole, including a time tie", () => {
    const targets = [
      { timestamp: 110, expected: "send-a" },
      { timestamp: 100, expected: "send-a" },
      { timestamp: 118, expected: "send-tie" },
      { timestamp: 500, expected: "send-fallback" },
      { timestamp: 0, expected: "send-a" },
    ];
    const subset = messages.filter((m) => carriesSend(m, "agent-r"));
    expect(subset.length).toBeLessThan(messages.length);
    for (const { timestamp, expected } of targets) {
      const locator = {
        kind: "sent-message" as const,
        receiverAgentId: "agent-r",
        messageText: "ping",
        timestamp,
      };
      const whole = transcriptLocatorBlockId(messages, locator);
      expect(whole).toBe(expected);
      expect(transcriptLocatorBlockId(subset, locator)).toBe(whole);
    }
  });

  it("a genuine time tie goes to the first candidate on both inputs", () => {
    // Target 110: send-a (100) and send-tie (120) are both 10 away.
    const locator = {
      kind: "sent-message" as const,
      receiverAgentId: "agent-r",
      messageText: "ping",
      timestamp: 110,
    };
    const subset = messages.filter((m) => carriesSend(m, "agent-r"));
    expect(transcriptLocatorBlockId(messages, locator)).toBe("send-a");
    expect(transcriptLocatorBlockId(subset, locator)).toBe("send-a");
  });

  it("sent-message with no matching receiver answers null on both inputs", () => {
    const locator = {
      kind: "sent-message" as const,
      receiverAgentId: "nobody",
      messageText: "ping",
      timestamp: 1,
    };
    expect(transcriptLocatorBlockId(messages, locator)).toBeNull();
    expect(
      transcriptLocatorBlockId(
        messages.filter((m) => carriesSend(m, "nobody")),
        locator,
      ),
    ).toBeNull();
  });

  it("receipt over the receipt-carrying subset equals the whole (first writer wins on a duplicate)", () => {
    for (const receiptId of ["rcpt-1", "rcpt-2", "rcpt-missing"]) {
      const locator = { kind: "receipt" as const, messageId: receiptId };
      const subset = messages.filter((m) => carriesReceipt(m, receiptId));
      const whole = transcriptLocatorBlockId(messages, locator);
      expect(transcriptLocatorBlockId(subset, locator)).toBe(whole);
    }
    expect(
      transcriptLocatorBlockId(messages, { kind: "receipt", messageId: "rcpt-1" }),
    ).toBe("send-a");
    expect(
      transcriptLocatorBlockId(messages, {
        kind: "receipt",
        messageId: "rcpt-missing",
      }),
    ).toBeNull();
  });

  it("approval over the approval-carrying subset equals the whole (first plan wins)", () => {
    for (const approvalId of ["appr-1", "appr-2", "appr-missing"]) {
      const locator = { kind: "approval" as const, approvalId };
      const subset = messages.filter((m) => carriesApproval(m, approvalId));
      const whole = transcriptLocatorBlockId(messages, locator);
      expect(transcriptLocatorBlockId(subset, locator)).toBe(whole);
    }
    expect(
      transcriptLocatorBlockId(messages, { kind: "approval", approvalId: "appr-1" }),
    ).toBe("plan-x");
    expect(
      transcriptLocatorBlockId(messages, { kind: "approval", approvalId: "appr-2" }),
    ).toBe("plan-z");
  });

  it("a block locator names itself regardless of the messages", () => {
    expect(
      transcriptLocatorBlockId([], { kind: "block", blockId: "b-1" }),
    ).toBe("b-1");
  });
});
