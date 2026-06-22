import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  generateTuiAgentTitleRequestSchema,
  generateTuiAgentTitleResponseSchema,
  listTuiHarnessesRequestSchema,
  listTuiHarnessesResponseSchema,
  prepareTuiLaunchRequestSchema,
  prepareTuiLaunchResponseSchema,
  recordTuiAgentActivityRequestSchema,
  recordTuiAgentActivityResponseSchema,
  tuiAgentTurnEndedRequestSchema,
  tuiAgentTurnEndedResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";

// ─── TUI-surface catalog + launch (`agent.tui.*`) ─────────────────────────

export const agentTuiListHarnessesV10 = defineRpcContract({
  method: "agent.tui.listHarnesses",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTuiHarnessesRequestSchema,
  responseSchema: listTuiHarnessesResponseSchema,
});

export const agentTuiPrepareLaunchV10 = defineRpcContract({
  method: "agent.tui.prepareLaunch",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prepareTuiLaunchRequestSchema,
  responseSchema: prepareTuiLaunchResponseSchema,
});

export const agentTuiGenerateTitleV10 = defineRpcContract({
  method: "agent.tui.generateTitle",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: generateTuiAgentTitleRequestSchema,
  responseSchema: generateTuiAgentTitleResponseSchema,
});

export const agentTuiTurnEndedV10 = defineRpcContract({
  method: "agent.tui.turnEnded",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: tuiAgentTurnEndedRequestSchema,
  responseSchema: tuiAgentTurnEndedResponseSchema,
});

export const agentTuiRecordActivityV10 = defineRpcContract({
  method: "agent.tui.recordActivity",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: recordTuiAgentActivityRequestSchema,
  responseSchema: recordTuiAgentActivityResponseSchema,
});
