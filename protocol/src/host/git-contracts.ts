/**
 * Versioned RPC contracts for the `git.*` host surface.
 * Five methods total: four unary (listChangedFiles, getFileDiff, getFileDiffs,
 * getCapabilities) and one streaming (subscribeStatus).
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  gitListChangedFilesRequestSchema,
  gitListChangedFilesResponseSchema,
  gitGetFileDiffRequestSchema,
  gitGetFileDiffResponseSchema,
  gitGetFileDiffsRequestSchema,
  gitGetFileDiffsResponseSchema,
  gitGetCapabilitiesResponseSchema,
  gitSubscribeStatusRequestSchema,
  gitSubscribeStatusEventSchema,
} from "./git-schemas";

/**
 * `git.listChangedFiles@1.0` - unary RPC to list files with current changes.
 */
export const gitListChangedFilesV10 = defineRpcContract({
  method: "git.listChangedFiles",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: gitListChangedFilesRequestSchema,
  responseSchema: gitListChangedFilesResponseSchema,
});

/**
 * `git.getFileDiff@1.0` - unary RPC to get diff for a single file.
 */
export const gitGetFileDiffV10 = defineRpcContract({
  method: "git.getFileDiff",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: gitGetFileDiffRequestSchema,
  responseSchema: gitGetFileDiffResponseSchema,
});

/**
 * `git.getFileDiffs@1.0` - unary RPC to get diffs for multiple files
 * within a byte budget.
 */
export const gitGetFileDiffsV10 = defineRpcContract({
  method: "git.getFileDiffs",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: gitGetFileDiffsRequestSchema,
  responseSchema: gitGetFileDiffsResponseSchema,
});

/**
 * `git.getCapabilities@1.0` - unary RPC to check if git feature is available
 * on this host (e.g. git version, repo size constraints).
 */
export const gitGetCapabilitiesV10 = defineRpcContract({
  method: "git.getCapabilities",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: gitListChangedFilesRequestSchema,
  responseSchema: gitGetCapabilitiesResponseSchema,
});

/**
 * Empty discriminated union for streaming RPCs with no client frames.
 * Zod requires at least one variant, so we create a never-matching variant
 * with a dummy literal that will never actually be sent from the client.
 */
const noClientFramesSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("__never_sent__" as never) }),
]);

/**
 * `git.subscribeStatus@1.0` - streaming RPC for subscriptions to git status
 * changes on a running directory. Server pushes snapshot + incremental
 * updated events; client has no frames.
 *
 * Per ADR-0003, the open request does NOT include `pollIntervalMs` - the
 * host's GitStatusBroadcaster polls every 5 seconds, period, and is
 * ref-counted across subscribers.
 */
export const gitSubscribeStatusV10 = defineStreamRpcContract({
  method: "git.subscribeStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: gitSubscribeStatusRequestSchema,
  serverFrameSchema: gitSubscribeStatusEventSchema,
  clientFrameSchema: noClientFramesSchema,
});
