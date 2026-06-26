import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  getGuiAgentPlanRequestSchema,
  getGuiAgentPlanResponseSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsResponseSchema,
  listGuiAgentModelsRequestSchema,
  listGuiAgentModelsResponseSchema,
  listGuiHarnessesRequestSchema,
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV10,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { chatSubscribeV10 } from "@traycer/protocol/host/agent/gui/subscribe";

// ─── GUI-surface catalog (`agent.gui.*`) ──────────────────────────────────

// `agent.gui.listHarnesses` always returns the full catalog (incl. grok), so an
// unguarded grok value would reach every caller. v1.0 is frozen grok-less (what
// shipped); v2.0 carries grok; the v2→v1 bridge drops grok for v1.0 clients.
export const agentGuiListHarnessesV10 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchemaV10,
});

export const agentGuiListHarnessesV20 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchema,
});

export const agentGuiListHarnessesUpgradeV1ToV2 = defineUpgradePath<
  typeof agentGuiListHarnessesV10,
  typeof agentGuiListHarnessesV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  // Request shape is identical; a grok-less v1.0 response is a valid v2.0
  // response (grok is purely additive), so both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesDowngradeV2ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV20,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop grok so a v1.0 client's strict (grok-less) decode never sees it. The
  // re-parse also yields the precise v1.0 type without an assertion.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV10.parse({
      harnesses: response.harnesses.filter((harness) => harness.id !== "grok"),
    }),
  }),
});

export const agentGuiListModelsV10 = defineRpcContract({
  method: "agent.gui.listModels",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiAgentModelsRequestSchema,
  responseSchema: listGuiAgentModelsResponseSchema,
});

export const agentGuiListCommandsV10 = defineRpcContract({
  method: "agent.gui.listCommands",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiAgentCommandsRequestSchema,
  responseSchema: listGuiAgentCommandsResponseSchema,
});

export const agentGuiGetPlanV10 = defineRpcContract({
  method: "agent.gui.getPlan",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: getGuiAgentPlanRequestSchema,
  responseSchema: getGuiAgentPlanResponseSchema,
});

export { chatSubscribeV10 };
