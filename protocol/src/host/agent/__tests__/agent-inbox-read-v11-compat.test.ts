import { describe, expect, it } from "vitest";
import {
  agentInboxReadRequestSchema,
  agentInboxReadRequestSchemaV11,
  agentInboxReadResponseSchema,
  agentInboxReadResponseSchemaV11,
  agentInboxReadUpgradeV10ToV11,
} from "@traycer/protocol/host/agent/inbox";

describe("agent.inbox.read v1.1 compatibility", () => {
  it("keeps the released v1.0 request and response shapes frozen", () => {
    expect(Object.keys(agentInboxReadRequestSchema.shape).sort()).toEqual(
      ["agentId", "epicId"],
    );
    expect(Object.keys(agentInboxReadResponseSchema.shape).sort()).toEqual([
      "messages",
    ]);
  });

  it("adds a null cursor when a v1.0 call is upgraded", () => {
    const request = agentInboxReadUpgradeV10ToV11.upgradeRequest({
      epicId: "epic-1",
      agentId: "agent-1",
    });
    const response = agentInboxReadUpgradeV10ToV11.upgradeResponse({
      messages: [],
    });

    expect(agentInboxReadRequestSchemaV11.parse(request)).toEqual({
      epicId: "epic-1",
      agentId: "agent-1",
      after: null,
    });
    expect(agentInboxReadResponseSchemaV11.parse(response)).toEqual({
      messages: [],
      nextCursor: null,
    });
  });
});
