import { describe, expect, it } from "vitest";
import {
  agentListDowngradeV9ToV8,
  agentListUpgradeV90ToV91,
} from "@traycer/protocol/host/agent/contracts";
import {
  agentSummarySchemaV90,
  listAgentsResponseSchema,
} from "@traycer/protocol/host/agent/shared";

/**
 * Contract tests for the `agent.list@9.1` session facet - the same
 * `sessionState` / `lastExit` pair `epic.listTuiAgents@1.3` puts on its
 * registry rows, here on the cross-surface agent summary. See
 * `agent-session-state.ts` and `contracts.ts`'s `agentListV91` block.
 */

const V90_AGENT = {
  id: "agent-1",
  parentId: null,
  hostId: "host-1",
  isLocal: true,
  surface: "gui" as const,
  harnessId: "codex" as const,
  title: "Existing chat",
  isSelf: true,
  capabilities: {
    readTranscript: true,
    sendMessage: true,
  },
  active: false,
  folderPaths: ["/repo"],
  isWorktree: false,
  runConfig: null,
};

const ANTIGRAVITY_AGENT = {
  ...V90_AGENT,
  id: "agent-2",
  harnessId: "antigravity" as const,
};

describe("agent.list v9.0 -> v9.1 upgrade path", () => {
  it("D14: stamps null on both facet fields and the result parses under the canonical schema", () => {
    const response = {
      caller: { agentId: "agent-1", canSendMessages: true },
      scope: "user" as const,
      agents: [V90_AGENT],
    };

    const upgraded = agentListUpgradeV90ToV91.upgradeResponse(response);

    expect(upgraded.agents).toEqual([
      { ...V90_AGENT, sessionState: null, lastExit: null },
    ]);

    const parsed = listAgentsResponseSchema.parse(upgraded);
    expect(parsed.agents).toEqual(upgraded.agents);
  });
});

describe("agent.list@9.1 row", () => {
  it("D15: a @9.1 row parses under @9.0's schema with both facet keys stripped", () => {
    const v91Row = {
      ...V90_AGENT,
      sessionState: "running" as const,
      lastExit: null,
    };

    const reparsed = agentSummarySchemaV90.parse(v91Row);
    expect(Object.hasOwn(reparsed, "sessionState")).toBe(false);
    expect(Object.hasOwn(reparsed, "lastExit")).toBe(false);
    expect(reparsed).toEqual(V90_AGENT);
  });
});

describe("agent.list v9.1 -> v8.0 downgrade path", () => {
  it("D16: drops both facet keys from every surviving row and still filters out antigravity rows", () => {
    const response = {
      caller: { agentId: "agent-1", canSendMessages: true },
      scope: "user" as const,
      agents: [
        { ...V90_AGENT, sessionState: "running" as const, lastExit: null },
        {
          ...ANTIGRAVITY_AGENT,
          sessionState: null,
          lastExit: "reaped" as const,
        },
      ],
    };

    const downgraded = agentListDowngradeV9ToV8.downgradeResponse(response);

    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) {
      throw new Error("expected the downgrade to succeed");
    }
    // The antigravity row is gone - the facet did not disturb the existing
    // id filtering `agentSummarySchemaV80.safeParse` performs.
    expect(downgraded.value.agents.map((agent) => agent.id)).toEqual([
      V90_AGENT.id,
    ]);
    expect(downgraded.value.agents[0]).not.toHaveProperty("sessionState");
    expect(downgraded.value.agents[0]).not.toHaveProperty("lastExit");
  });
});
