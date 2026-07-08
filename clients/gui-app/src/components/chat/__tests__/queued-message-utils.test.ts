import { describe, expect, it } from "vitest";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { queueItemCanPauseFromQueueHeader } from "@/components/chat/queued-message-utils";

const TEST_SETTINGS = {
  harnessId: "codex" as const,
  model: "gpt-5-codex",
  permissionMode: "supervised" as const,
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic" as const,
};

const USER_SENDER = { type: "user" as const, userId: "owner-1" };
const AGENT_SENDER = {
  type: "agent" as const,
  harnessId: "claude" as const,
  agentId: "agent-1",
  displayName: null,
  reply: { expectsReply: false as const },
};

describe("queueItemCanPauseFromQueueHeader", () => {
  it("rejects received agent queued items", () => {
    const item = queuedItem({
      sender: AGENT_SENDER,
      status: "pending",
      steerRequest: null,
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(false);
  });

  it("rejects already paused human queued items", () => {
    const item = queuedItem({
      sender: USER_SENDER,
      status: "paused",
      steerRequest: null,
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(false);
  });

  it("rejects human queued items already steering into a turn", () => {
    const item = queuedItem({
      sender: USER_SENDER,
      status: "steering",
      steerRequest: safePointSteerRequest(),
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(false);
  });

  it("rejects human queued items already injected into a turn", () => {
    const item = queuedItem({
      sender: USER_SENDER,
      status: "injected",
      steerRequest: null,
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(false);
  });

  it("rejects steer-requested human queued items with missing steer mode", () => {
    const item = queuedItem({
      sender: USER_SENDER,
      status: "steer_requested",
      steerRequest: null,
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(false);
  });

  it("rejects interrupt-restart steer requests", () => {
    const item = queuedItem({
      sender: USER_SENDER,
      status: "steer_requested",
      steerRequest: {
        mode: "interrupt_restart",
        targetTurnId: "turn-1",
        requestedAt: 1,
      },
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(false);
  });

  it("allows recoverable safe-point steer requests", () => {
    const item = queuedItem({
      sender: USER_SENDER,
      status: "steer_requested",
      steerRequest: safePointSteerRequest(),
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(true);
  });

  it("allows fallback human queued items", () => {
    const item = queuedItem({
      sender: USER_SENDER,
      status: "fallback",
      steerRequest: null,
    });

    expect(queueItemCanPauseFromQueueHeader(item)).toBe(true);
  });
});

function queuedItem(input: {
  readonly sender: ChatQueuedItem["sender"];
  readonly status: ChatQueuedItem["status"];
  readonly steerRequest: ChatQueuedItem["steerRequest"];
}): ChatQueuedItem {
  return {
    queueItemId: "queue-1",
    messageId: "message-1",
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "queued prompt" }],
          },
        ],
      },
    },
    sender: input.sender,
    settings: TEST_SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn",
    status: input.status,
    targetTurnId: null,
    steerRequest: input.steerRequest,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function safePointSteerRequest(): NonNullable<ChatQueuedItem["steerRequest"]> {
  return {
    mode: "safe_point",
    targetTurnId: "turn-1",
    requestedAt: 1,
  };
}
