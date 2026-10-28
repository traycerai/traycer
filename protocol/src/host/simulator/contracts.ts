import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  simulatorCatalogReadRequestSchema,
  simulatorCatalogReadResponseSchema,
} from "./catalog-contracts";
import {
  configSimulatorGetRequestSchema,
  configSimulatorResponseSchema,
  configSimulatorResponseSchemaV10,
  configSimulatorSetRequestSchema,
  configSimulatorSetRequestSchemaV10,
  configSimulatorSetResponseSchema,
  configSimulatorSetResponseSchemaV10,
  simulatorCloseRequestSchema,
  simulatorCloseRequestSchemaV10,
  simulatorCloseResponseSchema,
  simulatorInstancesRequestSchema,
  simulatorInstancesResponseSchema,
  simulatorListRequestSchema,
  simulatorListResponseSchema,
  simulatorListResponseSchemaV10,
  simulatorOpenRequestSchema,
  simulatorOpenRequestSchemaV10,
  simulatorOpenResponseSchema,
  simulatorOpenResponseSchemaV10,
  simulatorPowerOffRequestSchema,
  simulatorPowerOffResponseSchema,
  simulatorRemoveToolsRequestSchema,
  simulatorRemoveToolsResponseSchema,
  simulatorScreenshotRequestSchema,
  simulatorScreenshotResponseSchema,
  simulatorSetKeepRunningRequestSchema,
  simulatorSetKeepRunningResponseSchema,
  simulatorShutdownRequestSchema,
  simulatorShutdownResponseSchema,
  simulatorStatusRequestSchema,
  simulatorStatusResponseSchema,
} from "./schemas";

/**
 * Unary verbs of the host's simulator domain. Every one is an OPTIONAL
 * capability (`degrade: { kind: "unsupported" }` in the registry) and stays
 * off `RELEASED_FLOOR_METHOD_NAMES`: a host that predates the domain, or one
 * whose machine can run neither platform, reports the method as missing
 * rather than answering for it.
 *
 * The `@1.1` minors add only optional keys, so every request upgrade is the
 * identity: a `@1.0` request is a `@1.1` request with the new keys absent,
 * which the host reads as the `@1.0` meaning. There is no same-major
 * downgrade bridge; the `simulator.list` and `simulator.sessions` resolvers
 * branch on the caller's minor to serve a `@1.0` caller its own shape.
 *
 * Streams and typed settings actions have their own contract modules.
 */

/** The machine's simulators, pack and hub state, and this epic's sessions. */
export const simulatorListV10 = defineRpcContract({
  method: "simulator.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorListRequestSchema,
  responseSchema: simulatorListResponseSchemaV10,
});

/**
 * `@1.1`: clones appear under their source's `instances`, not as devices;
 * sessions carry their identity and the opens in flight are listed.
 */
export const simulatorListV11 = defineRpcContract({
  method: "simulator.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: simulatorListRequestSchema,
  responseSchema: simulatorListResponseSchema,
});
export const simulatorListUpgradeV10ToV11 = defineUpgradePath<
  typeof simulatorListV10,
  typeof simulatorListV11
>({
  from: simulatorListV10.schemaVersion,
  to: simulatorListV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/** Boots (optionally) and attaches one simulator, recording a session. */
export const simulatorOpenV10 = defineRpcContract({
  method: "simulator.open",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorOpenRequestSchemaV10,
  responseSchema: simulatorOpenResponseSchemaV10,
});

/** `@1.1`: picks the instance by `instance` and answers the `sessionId`. */
export const simulatorOpenV11 = defineRpcContract({
  method: "simulator.open",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: simulatorOpenRequestSchema,
  responseSchema: simulatorOpenResponseSchema,
});
export const simulatorOpenUpgradeV10ToV11 = defineUpgradePath<
  typeof simulatorOpenV10,
  typeof simulatorOpenV11
>({
  from: simulatorOpenV10.schemaVersion,
  to: simulatorOpenV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/** Removes the caller's session, optionally powering the simulator off. */
export const simulatorCloseV10 = defineRpcContract({
  method: "simulator.close",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorCloseRequestSchemaV10,
  responseSchema: simulatorCloseResponseSchema,
});

/** `@1.1`: ends one session by `sessionId`, or as `@1.0` without it. */
export const simulatorCloseV11 = defineRpcContract({
  method: "simulator.close",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: simulatorCloseRequestSchema,
  responseSchema: simulatorCloseResponseSchema,
});
export const simulatorCloseUpgradeV10ToV11 = defineUpgradePath<
  typeof simulatorCloseV10,
  typeof simulatorCloseV11
>({
  from: simulatorCloseV10.schemaVersion,
  to: simulatorCloseV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/** Powers one simulator off and drops every session on it in this epic. */
export const simulatorShutdownV10 = defineRpcContract({
  method: "simulator.shutdown",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorShutdownRequestSchema,
  responseSchema: simulatorShutdownResponseSchema,
});

/** One PNG of the simulator's screen. */
export const simulatorScreenshotV10 = defineRpcContract({
  method: "simulator.screenshot",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorScreenshotRequestSchema,
  responseSchema: simulatorScreenshotResponseSchema,
});

/**
 * Platform availability and the pack's install on this machine, with no
 * epic: the Settings page's read. Never starts the hub or an install.
 */
export const simulatorStatusV10 = defineRpcContract({
  method: "simulator.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorStatusRequestSchema,
  responseSchema: simulatorStatusResponseSchema,
});

/**
 * Removes the downloaded simulator tools from this host's managed store.
 * Refused while the switch is on or the hub or agent daemon runs; the
 * next `enabled: true` installs them again.
 */
export const simulatorRemoveToolsV10 = defineRpcContract({
  method: "simulator.removeTools",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorRemoveToolsRequestSchema,
  responseSchema: simulatorRemoveToolsResponseSchema,
});

/** Every instance booted on this machine, host-wide, with no epic. */
export const simulatorInstancesV10 = defineRpcContract({
  method: "simulator.instances",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorInstancesRequestSchema,
  responseSchema: simulatorInstancesResponseSchema,
});

/** Powers one instance off host-wide; asks first while an agent is mid-turn on it. */
export const simulatorPowerOffV10 = defineRpcContract({
  method: "simulator.powerOff",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorPowerOffRequestSchema,
  responseSchema: simulatorPowerOffResponseSchema,
});

/** Exempts one instance from the idle rule, or ends the exemption. */
export const simulatorSetKeepRunningV10 = defineRpcContract({
  method: "simulator.setKeepRunning",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorSetKeepRunningRequestSchema,
  responseSchema: simulatorSetKeepRunningResponseSchema,
});

/** Stateless relay of the caller's task simulator catalog. */
export const simulatorCatalogReadV10 = defineRpcContract({
  method: "simulator.catalog.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorCatalogReadRequestSchema,
  responseSchema: simulatorCatalogReadResponseSchema,
});

/** Reads the machine-user-global simulator switch. */
export const configSimulatorGetV10 = defineRpcContract({
  method: "config.simulator.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configSimulatorGetRequestSchema,
  responseSchema: configSimulatorResponseSchemaV10,
});

/** `@1.1`: also reads the idle window. */
export const configSimulatorGetV11 = defineRpcContract({
  method: "config.simulator.get",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: configSimulatorGetRequestSchema,
  responseSchema: configSimulatorResponseSchema,
});
export const configSimulatorGetUpgradeV10ToV11 = defineUpgradePath<
  typeof configSimulatorGetV10,
  typeof configSimulatorGetV11
>({
  from: configSimulatorGetV10.schemaVersion,
  to: configSimulatorGetV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/**
 * Writes the simulator switch. `enabled: true` is the `simulator-tools`
 * pack's enablement and the agents' access in one; `enabled: false` disables
 * it, closes this host's sessions and stops its helpers.
 */
export const configSimulatorSetV10 = defineRpcContract({
  method: "config.simulator.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configSimulatorSetRequestSchemaV10,
  responseSchema: configSimulatorSetResponseSchemaV10,
});

/** `@1.1`: a partial write; also sets the idle window. */
export const configSimulatorSetV11 = defineRpcContract({
  method: "config.simulator.set",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: configSimulatorSetRequestSchema,
  responseSchema: configSimulatorSetResponseSchema,
});
export const configSimulatorSetUpgradeV10ToV11 = defineUpgradePath<
  typeof configSimulatorSetV10,
  typeof configSimulatorSetV11
>({
  from: configSimulatorSetV10.schemaVersion,
  to: configSimulatorSetV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
