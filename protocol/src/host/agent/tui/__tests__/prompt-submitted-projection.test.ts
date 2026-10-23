import { describe, expect, it } from "vitest";
import {
  tuiAgentPromptSubmittedRequestSchemaV11,
  tuiAgentPromptSubmittedRequestSchemaV12,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import { agentTuiPromptSubmittedUpgradeV11ToV12 } from "@traycer/protocol/host/agent/tui/contracts";

/**
 * `promptSubmitted@1.2` adds `spawnToken` and `turnId`. A 1.1 request upgrades
 * with both `null`; a 1.2 request projected onto a 1.1 host is re-parsed
 * through the older schema, which strips them so an old host still records the
 * prompt edge.
 */
describe("promptSubmitted@1.1 → @1.2 upgrade", () => {
  it("fills spawnToken and turnId with null", () => {
    const upgraded = agentTuiPromptSubmittedUpgradeV11ToV12.upgradeRequest(
      tuiAgentPromptSubmittedRequestSchemaV11.parse({
        epicId: "epic-1",
        tuiAgentId: "agent-1",
        harnessSessionId: null,
        harnessId: "claude",
        observedHarnessSessionId: "sess-1",
      }),
    );
    expect(upgraded).toMatchObject({
      epicId: "epic-1",
      observedHarnessSessionId: "sess-1",
      spawnToken: null,
      turnId: null,
    });
  });
});

describe("promptSubmitted@1.2 → @1.1 request projection", () => {
  it("strips spawnToken and turnId (projection succeeds)", () => {
    const v12 = tuiAgentPromptSubmittedRequestSchemaV12.parse({
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      observedHarnessSessionId: "sess-1",
      spawnToken: "spawn-1",
      turnId: "turn-1",
    });
    const result = tuiAgentPromptSubmittedRequestSchemaV11.safeParse(v12);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("spawnToken");
      expect(result.data).not.toHaveProperty("turnId");
      expect(result.data.observedHarnessSessionId).toBe("sess-1");
    }
  });
});
