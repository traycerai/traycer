import { describe, expect, it } from "vitest";
import {
  agentInboxReadRequestSchema,
  agentInboxReadRequestSchemaV20,
  agentInboxReadResponseSchema,
  agentInboxReadResponseSchemaV20,
  agentInboxReadDowngradeV20ToV10,
  agentInboxReadUpgradeV10ToV20,
} from "@traycer/protocol/host/agent/inbox";

describe("agent.inbox.read v2.0 compatibility", () => {
  it("keeps the released v1.0 request and response shapes frozen", () => {
    expect(Object.keys(agentInboxReadRequestSchema.shape).sort()).toEqual([
      "agentId",
      "epicId",
    ]);
    expect(Object.keys(agentInboxReadResponseSchema.shape).sort()).toEqual([
      "messages",
    ]);
  });

  it("adds a null cursor when a v1.0 call is upgraded", () => {
    const request = agentInboxReadUpgradeV10ToV20.upgradeRequest({
      epicId: "epic-1",
      agentId: "agent-1",
    });
    const response = agentInboxReadUpgradeV10ToV20.upgradeResponse({
      messages: [],
    });

    expect(agentInboxReadRequestSchemaV20.parse(request)).toEqual({
      epicId: "epic-1",
      agentId: "agent-1",
      after: null,
    });
    expect(agentInboxReadResponseSchemaV20.parse(response)).toEqual({
      messages: [],
      nextCursor: null,
    });
  });

  it("rejects a pagination cursor when projecting onto a v1.0 host", () => {
    const downgraded = agentInboxReadDowngradeV20ToV10.downgradeRequest({
      epicId: "epic-1",
      agentId: "agent-1",
      after: { createdAt: 1_000, eventId: "event-1" },
    });

    expect(downgraded).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
  });

  it("allows a first-page read to project onto a v1.0 host", () => {
    expect(
      agentInboxReadDowngradeV20ToV10.downgradeRequest({
        epicId: "epic-1",
        agentId: "agent-1",
        after: null,
      }),
    ).toEqual({
      ok: true,
      value: { epicId: "epic-1", agentId: "agent-1" },
    });
  });

  it("refuses to truncate a paginated v2.0 response for a v1.0 client", () => {
    expect(
      agentInboxReadDowngradeV20ToV10.downgradeResponse({
        messages: [],
        nextCursor: { createdAt: 1_000, eventId: "event-1" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
  });

  it("projects a complete v2.0 response onto a v1.0 client", () => {
    expect(
      agentInboxReadDowngradeV20ToV10.downgradeResponse({
        messages: [],
        nextCursor: null,
      }),
    ).toEqual({ ok: true, value: { messages: [] } });
  });
});
