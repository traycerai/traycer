import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  configSimulatorGetRequestSchema,
  configSimulatorResponseSchema,
  configSimulatorSetRequestSchema,
  configSimulatorSetResponseSchema,
  simulatorCloseRequestSchema,
  simulatorCloseResponseSchema,
  simulatorListRequestSchema,
  simulatorListResponseSchema,
  simulatorOpenRequestSchema,
  simulatorOpenResponseSchema,
  simulatorRemoveToolsRequestSchema,
  simulatorRemoveToolsResponseSchema,
  simulatorScreenshotRequestSchema,
  simulatorScreenshotResponseSchema,
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
 * Streams (`simulator.sessions`, `simulator.stream`), the typed settings
 * actions and the MCP tools are later tickets; this file carries only the
 * verbs the host domain needs to be driven and proven.
 */

/** The machine's simulators, pack and hub state, and this epic's sessions. */
export const simulatorListV10 = defineRpcContract({
  method: "simulator.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorListRequestSchema,
  responseSchema: simulatorListResponseSchema,
});

/** Boots (optionally) and attaches one simulator, recording a session. */
export const simulatorOpenV10 = defineRpcContract({
  method: "simulator.open",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorOpenRequestSchema,
  responseSchema: simulatorOpenResponseSchema,
});

/** Removes the caller's session, optionally powering the simulator off. */
export const simulatorCloseV10 = defineRpcContract({
  method: "simulator.close",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorCloseRequestSchema,
  responseSchema: simulatorCloseResponseSchema,
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

/** Reads the machine-user-global simulator switches. */
export const configSimulatorGetV10 = defineRpcContract({
  method: "config.simulator.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configSimulatorGetRequestSchema,
  responseSchema: configSimulatorResponseSchema,
});

/**
 * Writes both simulator switches. `enabled: true` is the `simulator-tools`
 * pack's enablement; `enabled: false` disables it and closes this host's
 * sessions; `agentAccess: true` with `enabled: false` is refused.
 */
export const configSimulatorSetV10 = defineRpcContract({
  method: "config.simulator.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configSimulatorSetRequestSchema,
  responseSchema: configSimulatorSetResponseSchema,
});
