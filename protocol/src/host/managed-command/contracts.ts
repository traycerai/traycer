/**
 * The unary managed-command controls: watch, lifecycle - start, stop, delete -
 * and Deliver.
 *
 * There is still deliberately no CREATE or UPDATE. Authoring a command is the
 * agent's job (its tool descriptions carry flush-contract guidance a human form
 * would skip), and changing one is a sentence to the agent.
 *
 * Deliver is the one capability added since, and it is not an edit: a committed
 * Stop fence can leave a shell's final output held behind a durable hold that
 * NOTHING else will ever clear, because the release that normally clears one is
 * the command's own next line and a finished shell has no next line. Without an
 * explicit human path that output is unreachable, and stays unreachable across
 * restarts. Asking for output the host is already holding for you is not
 * authoring a command; it is reading one.
 *
 * (These constraints were recorded in a `UI.md` §2 that several files still
 * cite. That document was never part of what landed on the default branch - it
 * stayed a working document on its feature branch - so the constraint lives
 * here now, where the contract it governs can be read beside it.)
 *
 * The output itself is carried by the stream in `./subscribe.ts`; the set of
 * commands a chat owns, and the subset of them currently held, both ride that
 * chat's `chat.subscribe` stream.
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

/**
 * Idempotent: starting an already-running command is a no-op, not an error.
 *
 * `@1.0` shipped (cli-v1.2.0) returning the command WITHOUT
 * `relaunchOnHostRestart`, so it stays pinned to that pre-image: the host's
 * within-major projection (Zod's default strip against this schema) drops the
 * flag for a `1.0` peer. `@1.1` below is the line that carries it.
 */
export const managedCommandStartV10 = defineRpcContract({
  method: "managedCommand.start",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandControlRequestSchema,
  responseSchema: managedCommandControlResponseSchemaV10,
});

/**
 * `@1.1`: the same call, returning the command with `relaunchOnHostRestart`.
 * A minor rather than an in-place change to `1.0` because the released gate
 * treats any growth of a host→client shape on a shipped line as breaking -
 * a defaulted field included - and a `1.0` peer's frozen schema must keep
 * describing exactly the bytes it gets.
 */
export const managedCommandStartV11 = defineRpcContract({
  method: "managedCommand.start",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: managedCommandControlRequestSchema,
  responseSchema: managedCommandControlResponseSchema,
});

// The request did not change. The response grew a defaulted field, so a `1.0`
// response upgrades by parsing through the live schema, which fills the
// default (`false`: a host that never offered the choice never relaunched).
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

/**
 * Kills the process if running, drops the row, and removes the log directory.
 * The output history dies with it, which is why the UI puts this behind a
 * confirmation that names what is lost.
 */
export const managedCommandDeleteV10 = defineRpcContract({
  method: "managedCommand.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandDeleteRequestSchema,
  responseSchema: managedCommandDeleteResponseSchema,
});

/**
 * Sets whether the command relaunches after a host restart. Live: the running
 * process is never touched. The "no update" rule above still stands - this
 * edits lifecycle policy, not what the command is - and it exists because the
 * person watching a host relaunch a shell they never asked for needs a switch
 * the agent's transcript cannot give them.
 *
 * Brand new alongside `start@1.1` / `stop@1.1`, so its `1.0` already returns
 * the live command shape - there is no released peer to pin a pre-image for.
 */
export const managedCommandConfigureV10 = defineRpcContract({
  method: "managedCommand.configure",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandConfigureRequestSchema,
  responseSchema: managedCommandControlResponseSchema,
});

/**
 * Releases the holds a committed Stop fence installed on this chat's shells and
 * offers each shell's captured output from where the agent last consumed it.
 *
 * IDEMPOTENT in the direction that matters: delivering a chat that holds
 * nothing succeeds with three empty lists. That is deliberate and not merely
 * tolerant - a hold can be released by the command's own next line between the
 * moment a surface renders the button and the moment someone presses it, and
 * treating the resulting no-op as an error would report a race as a failure.
 *
 * Does NOT inherit the host's all-or-nothing release semantics. Internally,
 * resolution means "every in-scope durable hold is provably gone" and anything
 * less throws - the guarantee that lets a caller say the output was delivered.
 * A person delivering four shells needs the split instead, so this reports it:
 * `released` and `unresolved` name commands individually, and only an
 * epic/chat the caller may not touch rejects the call outright.
 */
export const managedCommandDeliverHeldV10 = defineRpcContract({
  method: "managedCommand.deliverHeld",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: managedCommandDeliverHeldRequestSchema,
  responseSchema: managedCommandDeliverHeldResponseSchema,
});

export { managedCommandSubscribeOutputV10, managedCommandSubscribeOutputV11 };
