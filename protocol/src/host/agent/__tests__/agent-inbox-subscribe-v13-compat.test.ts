import { describe, expect, it } from "vitest";
import {
  agentInboxSubscribeServerFrameSchemaV12,
  agentInboxSubscribeServerFrameSchemaV13,
} from "@traycer/protocol/host/agent/inbox";

const AGENT_STOP_NOTICE = {
  kind: "notice" as const,
  hasBinaryPayload: false as const,
  notice: {
    kind: "inactivity" as const,
    senderAgentId: "sender-agent",
    responseId: "response-1",
    receiverAgentId: "stopped-agent",
    receiverTitle: "Stopped agent",
    receiverHarnessId: "codex",
    epicId: "epic-1",
    reason: "receiver-cancelled" as const,
    detail: null,
    droppedReceivers: [
      { receiverAgentId: "stopped-agent", responseId: "response-1" },
    ],
    noticedAt: 1_000,
    stopInitiator: {
      type: "agent" as const,
      agentId: "review-agent",
      agentTitle: "Review",
    },
  },
};

describe("agent.inbox.subscribe v1.3 compatibility", () => {
  it("preserves structured stop-initiator provenance for current clients", () => {
    const parsed = agentInboxSubscribeServerFrameSchemaV13.parse(
      AGENT_STOP_NOTICE,
    );

    expect(parsed).toMatchObject({
      notice: {
        stopInitiator: {
          type: "agent",
          agentId: "review-agent",
          agentTitle: "Review",
        },
      },
    });
  });

  it("keeps the released v1.2 notice tree frozen", () => {
    const parsed = agentInboxSubscribeServerFrameSchemaV12.parse(
      AGENT_STOP_NOTICE,
    );

    if (parsed.kind !== "notice") {
      throw new Error("Expected a notice frame.");
    }
    expect(parsed.notice).not.toHaveProperty("stopInitiator");
  });
});
