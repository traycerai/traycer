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
  prepareTuiLaunchRequestSchemaV11,
  prepareTuiLaunchResponseSchema,
  recordTuiAgentActivityRequestSchema,
  recordTuiAgentActivityRequestSchemaV11,
  recordTuiAgentActivityResponseSchema,
  tuiAgentPromptSubmittedRequestSchema,
  tuiAgentPromptSubmittedRequestSchemaV11,
  tuiAgentPromptSubmittedResponseSchema,
  tuiAgentTurnEndedRequestSchema,
  tuiAgentTurnEndedResponseSchema,
  validateTuiForkProfileRequestSchema,
  validateTuiForkProfileResponseSchema,
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

/**
 * `agent.tui.prepareLaunch@1.1` - adds the request-side `forkSourceTuiAgentId` (stable fork-source identity).
 */
export const agentTuiPrepareLaunchV11 = defineRpcContract({
  method: "agent.tui.prepareLaunch",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: prepareTuiLaunchRequestSchemaV11,
  responseSchema: prepareTuiLaunchResponseSchema,
});

// A v1.0 request carries no fork-source agent id, so the resolver falls back to the strict-scan source lookup - upgrading fills the field with that same `null`.
export const agentTuiPrepareLaunchUpgradeV10ToV11 = defineUpgradePath<
  typeof agentTuiPrepareLaunchV10,
  typeof agentTuiPrepareLaunchV11
>({
  from: agentTuiPrepareLaunchV10.schemaVersion,
  to: agentTuiPrepareLaunchV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    forkSourceTuiAgentId: null,
  }),
  upgradeResponse: (response) => response,
});

/**
 * Optional (non-floor) capability: read-only cross-profile fork-admission preflight (tech plan governing mechanism 2).
 * Registered with a `degrade: unsupported` strategy in `registry.ts` so an old host that lacks it fails only this call - it must never enter the released floor, which would be handshake-fatal for existing peers.
 */
export const agentTuiValidateForkProfileV10 = defineRpcContract({
  method: "agent.tui.validateForkProfile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: validateTuiForkProfileRequestSchema,
  responseSchema: validateTuiForkProfileResponseSchema,
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
 * `agent.tui.recordActivity@1.1` - adds the request-side `observedHarnessSessionId` (Claude TUI session-id resync) and the pure `event: "resync"` edge.
 */
export const agentTuiRecordActivityV11 = defineRpcContract({
  method: "agent.tui.recordActivity",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: recordTuiAgentActivityRequestSchemaV11,
  responseSchema: recordTuiAgentActivityResponseSchema,
});

// A v1.0 request carries no observed id (nothing to resync) and only the `start`/`stop` edges, both of which are a subset of the v1.1 event set.
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

/**
 * Optional (non-floor) capability: the `UserPromptSubmit` hook's combined activity-edge + roles-digest-pull call (roles-snapshot-delivery pull point 1).
 */
export const agentTuiPromptSubmittedV10 = defineRpcContract({
  method: "agent.tui.promptSubmitted",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: tuiAgentPromptSubmittedRequestSchema,
  responseSchema: tuiAgentPromptSubmittedResponseSchema,
});

export const agentTuiPromptSubmittedV11 = defineRpcContract({
  method: "agent.tui.promptSubmitted",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: tuiAgentPromptSubmittedRequestSchemaV11,
  responseSchema: tuiAgentPromptSubmittedResponseSchema,
});

// A v1.0 request carries no workspace intent, so the upgrade fills `null` (binding-as-stored).
export const agentTuiPromptSubmittedUpgradeV10ToV11 = defineUpgradePath<
  typeof agentTuiPromptSubmittedV10,
  typeof agentTuiPromptSubmittedV11
>({
  from: agentTuiPromptSubmittedV10.schemaVersion,
  to: agentTuiPromptSubmittedV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    worktreeIntent: null,
  }),
  upgradeResponse: (response) => response,
});
