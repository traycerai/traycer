import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  claimShutdownRequestSchema,
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
