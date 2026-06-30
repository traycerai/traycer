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
  guiHarnessOptionSchemaV10,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { chatSubscribeV20 } from "@traycer/protocol/host/agent/gui/subscribe";

// ─── GUI-surface catalog (`agent.gui.*`) ──────────────────────────────────

// `agent.gui.listHarnesses` always returns the full catalog, so unguarded ACP
// GUI harness ids would reach every caller. v1.0 is frozen without these ids
// (what shipped); v2.0 carries them; the v2→v1 bridge drops them for v1.0
// clients.
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
  // Request shape is identical; a v1.0 response without ACP GUI harnesses is a
  // valid v2.0 response (they are purely additive), so both upgrades are
  // identity.
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
  // Drop post-v1.0 GUI harnesses so a v1.0 client's strict decode never sees
  // them. The re-parse also yields the precise v1.0 type without an assertion.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV10.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV10.safeParse(harness).success,
      ),
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

export { chatSubscribeV20 };
