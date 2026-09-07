/**
 * The unary managed-command controls: watch, lifecycle - start, stop, delete - and Deliver.
 * That document was never part of what landed on the default branch - it stayed a working document on its feature branch - so the constraint lives here now, where the contract it governs can be read beside it.)
 */
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  managedCommandConfigureRequestSchema,
  managedCommandControlRequestSchema,
  managedCommandControlResponseSchema,
  managedCommandControlResponseSchemaV10,
  managedCommandDeleteRequestSchema,
  managedCommandDeleteResponseSchema,
  managedCommandDeliverHeldRequestSchema,
  managedCommandDeliverHeldResponseSchema,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  managedCommandSubscribeOutputV10,
  managedCommandSubscribeOutputV11,
} from "@traycer/protocol/host/managed-command/subscribe";

/** Idempotent: starting an already-running command is a no-op, not an error. */
export const managedCommandStartV10 = defineRpcContract({
  method: "managedCommand.start",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandControlRequestSchema,
  responseSchema: managedCommandControlResponseSchemaV10,
});

/** `@1.1`: the same call, returning the command with `relaunchOnHostRestart`. */
export const managedCommandStartV11 = defineRpcContract({
  method: "managedCommand.start",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: managedCommandControlRequestSchema,
  responseSchema: managedCommandControlResponseSchema,
});

// The request did not change.
export const managedCommandStartUpgradeV10ToV11 = defineUpgradePath<
  typeof managedCommandStartV10,
  typeof managedCommandStartV11
>({
  from: managedCommandStartV10.schemaVersion,
  to: managedCommandStartV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) =>
    managedCommandControlResponseSchema.parse(response),
});

/**
 * The supervisor's graceful stop: TERM to the process group, grace, then KILL.
 * Same `1.0` pre-image / `1.1` live split as `managedCommand.start`.
 */
export const managedCommandStopV10 = defineRpcContract({
  method: "managedCommand.stop",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandControlRequestSchema,
  responseSchema: managedCommandControlResponseSchemaV10,
});

export const managedCommandStopV11 = defineRpcContract({
  method: "managedCommand.stop",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: managedCommandControlRequestSchema,
  responseSchema: managedCommandControlResponseSchema,
});

export const managedCommandStopUpgradeV10ToV11 = defineUpgradePath<
  typeof managedCommandStopV10,
  typeof managedCommandStopV11
>({
  from: managedCommandStopV10.schemaVersion,
  to: managedCommandStopV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) =>
    managedCommandControlResponseSchema.parse(response),
});

/** Kills the process if running, drops the row, and removes the log directory. */
export const managedCommandDeleteV10 = defineRpcContract({
  method: "managedCommand.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandDeleteRequestSchema,
  responseSchema: managedCommandDeleteResponseSchema,
});

/**
 * Sets whether the command relaunches after a host restart.
 * The "no update" rule above still stands - this edits lifecycle policy, not what the command is - and it exists because the person watching a host relaunch a shell they never asked for needs a switch the agent's.
 */
export const managedCommandConfigureV10 = defineRpcContract({
  method: "managedCommand.configure",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandConfigureRequestSchema,
  responseSchema: managedCommandControlResponseSchema,
});

/**
 * Releases the holds a committed Stop fence installed on this chat's shells and offers each shell's captured output from where the agent last consumed it.
 * IDEMPOTENT in the direction that matters: delivering a chat that holds nothing succeeds with three empty lists.
 */
export const managedCommandDeliverHeldV10 = defineRpcContract({
  method: "managedCommand.deliverHeld",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandDeliverHeldRequestSchema,
  responseSchema: managedCommandDeliverHeldResponseSchema,
});

export { managedCommandSubscribeOutputV10, managedCommandSubscribeOutputV11 };
