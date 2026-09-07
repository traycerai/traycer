import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  claimShutdownRequestSchema,
  claimShutdownRequestSchemaV11,
  claimShutdownResponseSchema,
  commitShutdownRequestSchema,
  commitShutdownResponseSchema,
  releaseShutdownRequestSchema,
  releaseShutdownResponseSchema,
} from "./schemas";

/**
 * Host lifecycle claim. The granted token is intentionally opaque and only a
 * live claim may be committed; expired claims automatically reopen admission.
 */
export const lifecycleClaimShutdownV10 = defineRpcContract({
  method: "lifecycle.claimShutdown",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: claimShutdownRequestSchema,
  responseSchema: claimShutdownResponseSchema,
});

/**
 * @1.1 declares whether the coordinator will bring the host back up.
 * Additive minor on an EXISTING method per the two-sided release invariant - a new method name would break the fail-closed handshake.
 */
export const lifecycleClaimShutdownV11 = defineRpcContract({
  method: "lifecycle.claimShutdown",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: claimShutdownRequestSchemaV11,
  responseSchema: claimShutdownResponseSchema,
});

/** A @1.0 caller said nothing about what happens after the stop, so it is read as `"shutdown"`. */
export const lifecycleClaimShutdownUpgradeV10ToV11 = defineUpgradePath<
  typeof lifecycleClaimShutdownV10,
  typeof lifecycleClaimShutdownV11
>({
  from: lifecycleClaimShutdownV10.schemaVersion,
  to: lifecycleClaimShutdownV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, intent: "shutdown" as const }),
  upgradeResponse: (response) => response,
});

/** Converts a live claim into permanent admission closure and self-exit. */
export const lifecycleCommitShutdownV10 = defineRpcContract({
  method: "lifecycle.commitShutdown",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: commitShutdownRequestSchema,
  responseSchema: commitShutdownResponseSchema,
});

/** Aborts a live shutdown claim and immediately reopens work admission. */
export const lifecycleReleaseShutdownV10 = defineRpcContract({
  method: "lifecycle.releaseShutdown",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: releaseShutdownRequestSchema,
  responseSchema: releaseShutdownResponseSchema,
});
