import { describe, expect, it } from "vitest";

import { agentListDowngradeV2ToV1 } from "@traycer/protocol/host/agent/contracts";
import {
  listAgentsResponseSchema,
  listAgentsResponseSchemaV10,
} from "@traycer/protocol/host/agent/shared";
import { agentGuiListHarnessesDowngradeV2ToV1 } from "@traycer/protocol/host/agent/gui/contracts";
import {
  guiHarnessOptionSchema,
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV10,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  providersListResponseSchema,
  providersListResponseSchemaV10,
} from "@traycer/protocol/host/provider-schemas";
// Importing from the registry runs `defineVersionedRpcRegistry` (full structural
// + schema-compatibility validation) at module load, so this import alone
// asserts the new v2.0 lines and their upgrade/downgrade bridges are well-formed.
import { providersListDowngradeV2ToV1 } from "@traycer/protocol/host/registry";

function harnessOption(id: string) {
  return guiHarnessOptionSchema.parse({
    id,
    label: id,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
  });
}

function agentSummary(id: string, harnessId: string | null) {
  return {
    id,
    parentId: null,
    hostId: "host-1",
    isLocal: true,
    surface: "gui",
    harnessId,
    isSelf: false,
    title: id,
    capabilities: { readTranscript: true, sendMessage: true },
    active: false,
    folderPaths: [],
    isWorktree: false,
  };
}

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
  };
}

describe("grok non-breaking v2→v1 downgrade bridges", () => {
  it("drops grok from agent.gui.listHarnesses for v1.0 callers", () => {
    const v2Response = listGuiHarnessesResponseSchema.parse({
      harnesses: [harnessOption("claude"), harnessOption("grok"), harnessOption("cursor")],
    });

    const result = agentGuiListHarnessesDowngradeV2ToV1.downgradeResponse(v2Response);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.harnesses.map((harness) => harness.id)).toEqual(["claude", "cursor"]);
    // The downgraded value must satisfy the frozen grok-less v1.0 schema — i.e.
    // a real v1.0 client's strict decode would accept it.
    expect(() => listGuiHarnessesResponseSchemaV10.parse(result.value)).not.toThrow();
  });

  it("drops grok from providers.list for v1.0 callers", () => {
    const v2Response = providersListResponseSchema.parse({
      providers: [providerState("cursor"), providerState("grok")],
    });

    const result = providersListDowngradeV2ToV1.downgradeResponse(v2Response);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers.map((provider) => provider.providerId)).toEqual(["cursor"]);
    expect(() => providersListResponseSchemaV10.parse(result.value)).not.toThrow();
  });

  it("drops grok agents from agent.list for v1.0 callers", () => {
    const v2Response = listAgentsResponseSchema.parse({
      caller: { agentId: "self", canSendMessages: true },
      scope: "all",
      agents: [
        agentSummary("a-claude", "claude"),
        agentSummary("a-grok", "grok"),
        agentSummary("a-null", null),
      ],
    });

    const result = agentListDowngradeV2ToV1.downgradeResponse(v2Response);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agents.map((agent) => agent.id)).toEqual(["a-claude", "a-null"]);
    // A real v1.0 client's strict (grok-less) decode must accept the result.
    expect(() => listAgentsResponseSchemaV10.parse(result.value)).not.toThrow();
  });
});
