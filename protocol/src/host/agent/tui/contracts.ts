import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  generateTuiAgentTitleRequestSchema,
  generateTuiAgentTitleResponseSchema,
  listTuiHarnessesRequestSchema,
  listTuiHarnessesResponseSchema,
  prepareTuiLaunchRequestSchema,
  prepareTuiLaunchResponseSchema,
  recordTuiAgentActivityRequestSchema,
  recordTuiAgentActivityRequestSchemaV11,
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

/**
 * `agent.tui.recordActivity@1.1` - adds the request-side
 * `observedHarnessSessionId` (Claude TUI session-id resync) and the pure
 * `event: "resync"` edge. The response is unchanged from v1.0. See the schema
 * note in `unary-schemas.ts`.
 */
export const agentTuiRecordActivityV11 = defineRpcContract({
  method: "agent.tui.recordActivity",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: recordTuiAgentActivityRequestSchemaV11,
  responseSchema: recordTuiAgentActivityResponseSchema,
});

// A v1.0 request carries no observed id (nothing to resync) and only the
// `start`/`stop` edges, both of which are a subset of the v1.1 event set. The
// response is byte-identical, so its upgrade is the identity. A v1.1 peer
// projects onto a v1.0 host by re-parsing through the (non-strict) v1.0 request
// schema, which strips `observedHarnessSessionId` on the wire - so no downgrade
// path is needed for the same-major minor.
export const agentTuiRecordActivityUpgradeV10ToV11 = defineUpgradePath<
  typeof agentTuiRecordActivityV10,
  typeof agentTuiRecordActivityV11
>({
  from: agentTuiRecordActivityV10.schemaVersion,
  to: agentTuiRecordActivityV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    observedHarnessSessionId: null,
  }),
  upgradeResponse: (response) => response,
});
