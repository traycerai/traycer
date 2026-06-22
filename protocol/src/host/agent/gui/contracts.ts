import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  getGuiAgentPlanRequestSchema,
  getGuiAgentPlanResponseSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsResponseSchema,
  listGuiAgentModelsRequestSchema,
  listGuiAgentModelsResponseSchema,
  listGuiHarnessesRequestSchema,
  listGuiHarnessesResponseSchema,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { chatSubscribeV10 } from "@traycer/protocol/host/agent/gui/subscribe";

// ─── GUI-surface catalog (`agent.gui.*`) ──────────────────────────────────

export const agentGuiListHarnessesV10 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchema,
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
