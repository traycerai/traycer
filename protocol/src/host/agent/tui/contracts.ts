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
  recordTuiAgentActivityRequestSchemaV12,
  recordTuiAgentActivityResponseSchema,
  tuiAgentPromptSubmittedRequestSchema,
  tuiAgentPromptSubmittedRequestSchemaV11,
  tuiAgentPromptSubmittedRequestSchemaV12,
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
 * `agent.tui.prepareLaunch@1.1` - adds the request-side
 * `forkSourceTuiAgentId` (stable fork-source identity). The response is
 * unchanged from v1.0. See the schema note in `unary-schemas.ts`.
 */
export const agentTuiPrepareLaunchV11 = defineRpcContract({
  method: "agent.tui.prepareLaunch",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: prepareTuiLaunchRequestSchemaV11,
  responseSchema: prepareTuiLaunchResponseSchema,
});

// A v1.0 request carries no fork-source agent id, so the resolver falls back
// to the strict-scan source lookup - upgrading fills the field with that
// same `null`. The response is byte-identical, so its upgrade is the
// identity. A v1.1 peer projects onto a v1.0 host by re-parsing through the
// (non-strict) v1.0 request schema, which strips `forkSourceTuiAgentId` on
// the wire - so no downgrade path is needed for the same-major minor.
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
 * Optional (non-floor) capability: read-only cross-profile fork-admission
 * preflight (tech plan governing mechanism 2). Registered with a
 * `degrade: unsupported` strategy in `registry.ts` so an old host that lacks
 * it fails only this call - it must never enter the released floor, which
 * would be handshake-fatal for existing peers. See the schema doc in
 * `unary-schemas.ts`.
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

/**
 * `agent.tui.recordActivity@1.2` - adds the request-side idle evidence
 * (`spawnToken`, `turnId`, `inFlight`) and the `started` and
 * `idle-confirmed` events. The response is unchanged. See the schema note in
 * `unary-schemas.ts`.
 */
export const agentTuiRecordActivityV12 = defineRpcContract({
  method: "agent.tui.recordActivity",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: recordTuiAgentActivityRequestSchemaV12,
  responseSchema: recordTuiAgentActivityResponseSchema,
});

// A v1.1 request reported no evidence, so the upgrade fills all three fields
// with `null` (the host keeps the agent). The response is byte-identical. A
// v1.2 peer projects onto a v1.1 host by the non-strict re-parse, which strips
// the fields on the wire; the two new events cannot be projected at all.
export const agentTuiRecordActivityUpgradeV11ToV12 = defineUpgradePath<
  typeof agentTuiRecordActivityV11,
  typeof agentTuiRecordActivityV12
>({
  from: agentTuiRecordActivityV11.schemaVersion,
  to: agentTuiRecordActivityV12.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    spawnToken: null,
    turnId: null,
    inFlight: null,
  }),
  upgradeResponse: (response) => response,
});

/**
 * Optional (non-floor) capability: the `UserPromptSubmit` hook's combined
 * activity-edge + roles-digest-pull call (roles-snapshot-delivery pull point
 * 1). Registered with a `degrade: unsupported` strategy in `registry.ts` so
 * an old host that lacks it fails only this call and the CLI hook falls back
 * to plain `recordActivity` - it must never enter the released floor, which
 * would be handshake-fatal for existing peers. See the schema doc in
 * `unary-schemas.ts`.
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

// A v1.0 request carries no workspace intent, so the upgrade fills `null`
// (binding-as-stored). The response is byte-identical. A v1.1 peer projects
// onto a v1.0 host by re-parsing through the (non-strict) v1.0 request
// schema, which strips `worktreeIntent` on the wire.
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

export const agentTuiPromptSubmittedV12 = defineRpcContract({
  method: "agent.tui.promptSubmitted",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: tuiAgentPromptSubmittedRequestSchemaV12,
  responseSchema: tuiAgentPromptSubmittedResponseSchema,
});

// A v1.1 start edge carried no spawn token or turn id, so it forms no idle
// evidence: the upgrade fills both with `null`. A v1.2 peer projects onto a
// v1.1 host by the non-strict re-parse, which strips them.
export const agentTuiPromptSubmittedUpgradeV11ToV12 = defineUpgradePath<
  typeof agentTuiPromptSubmittedV11,
  typeof agentTuiPromptSubmittedV12
>({
  from: agentTuiPromptSubmittedV11.schemaVersion,
  to: agentTuiPromptSubmittedV12.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    spawnToken: null,
    turnId: null,
  }),
  upgradeResponse: (response) => response,
});
