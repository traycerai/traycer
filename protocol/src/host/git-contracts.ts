/** Versioned RPC contracts for the `git.*` host surface. */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  gitListChangedFilesRequestSchema,
  gitListChangedFilesRequestSchemaV11,
  gitListChangedFilesResponseSchema,
  gitListChangedFilesResponseSchemaV11,
  gitGetFileDiffRequestSchema,
  gitGetFileDiffResponseSchema,
  gitGetFileDiffsRequestSchema,
  gitGetFileDiffsResponseSchema,
  gitGetFileContentsRequestSchema,
  gitGetFileContentsResponseSchema,
  gitGetCapabilitiesResponseSchema,
  gitSubscribeStatusRequestSchema,
  gitSubscribeStatusRequestSchemaV12,
  gitSubscribeStatusEventSchema,
  gitSubscribeStatusEventSchemaV11,
  gitSubscribeStatusEventSchemaV12,
  gitSubscribeStatusEventSchemaV13,
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
 * Optional post-v1 edit hydration. A client asks only after the user enters
 * edit mode; older hosts omit the capability and remain read-only.
 */
export const gitGetFileContentsV10 = defineRpcContract({
  method: "git.getFileContents",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: gitGetFileContentsRequestSchema,
  responseSchema: gitGetFileContentsResponseSchema,
});

// `git.listChangedFiles@1.1` - ---- Submodule-aware v1.1 ------------------------------------------------ //
// No new method names (a new name fatally fails the equal-set handshake against a shipped v1.0.0 host).

/**
 * `git.listChangedFiles@1.1` - adds parent-file `gitlink` descriptors and the `submodules[]` nested snapshot on the response, plus the request-side `includeSubmodules` fan-out gate (default false - the host only spawns.
 */
export const gitListChangedFilesV11 = defineRpcContract({
  method: "git.listChangedFiles",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: gitListChangedFilesRequestSchemaV11,
  responseSchema: gitListChangedFilesResponseSchemaV11,
});

// A v1.0 host knows no submodules: every parent file gains `gitlink: null` and the response gains an empty `submodules[]` (parent-only view).
// A v1.0 request never asks for the fan-out, so its upgrade pins `includeSubmodules: false`.
export const gitListChangedFilesUpgradeV10ToV11 = defineUpgradePath<
  typeof gitListChangedFilesV10,
  typeof gitListChangedFilesV11
>({
  from: gitListChangedFilesV10.schemaVersion,
  to: gitListChangedFilesV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, includeSubmodules: false }),
  upgradeResponse: (response) => ({
    ...response,
    files: response.files.map((file) => ({ ...file, gitlink: null })),
    submodules: [],
  }),
});

// `git.getFileDiff` / `git.getFileDiffs` have no v1.1 - they stay v1.0-only (see
// the section note above). Their v1.0 contracts are defined earlier in this file.

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
 * Zod requires at least one variant, so we create a never-matching variant with a dummy literal that will never actually be sent from the client.
 */
const noClientFramesSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("__never_sent__" as never) }),
]);

/**
 * `git.subscribeStatus@1.0` - streaming RPC for subscriptions to git status changes on a running directory.
 * FROZEN at minor 0: a connection negotiated here receives resolver-projected parent-only frames.
 */
export const gitSubscribeStatusV10 = defineStreamRpcContract({
  method: "git.subscribeStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: gitSubscribeStatusRequestSchema,
  serverFrameSchema: gitSubscribeStatusEventSchema,
  clientFrameSchema: noClientFramesSchema,
});

/**
 * `git.subscribeStatus@1.1` - the nested-snapshot minor.
 * Do not remove either guard. - Streams have no version bridges: this minor exists for handshake negotiation + resolver-side projection only, never for payload upgrading.
 */
export const gitSubscribeStatusV11 = defineStreamRpcContract({
  method: "git.subscribeStatus",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: gitSubscribeStatusRequestSchema,
  serverFrameSchema: gitSubscribeStatusEventSchemaV11,
  clientFrameSchema: noClientFramesSchema,
});

/**
 * `git.subscribeStatus@1.2` adds opaque fresh-replacement correlation.
 * The distinct request and event schemas keep the released v1.0/v1.1 wire shapes frozen; streams have no bridge, so the host resolver projects v1.2 frames down for negotiated lower minors.
 */
export const gitSubscribeStatusV12 = defineStreamRpcContract({
  method: "git.subscribeStatus",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: gitSubscribeStatusRequestSchemaV12,
  serverFrameSchema: gitSubscribeStatusEventSchemaV12,
  clientFrameSchema: noClientFramesSchema,
});

/**
 * `git.subscribeStatus@1.3` adds `watcher` health to snapshot/updated frames - whether the host is watching the filesystem for this repo or has fallen back to adaptive polling, and if so whether that fallback is.
 * This is deliberately NOT a client-subscribable option: watcher health rides every frame or none, because a client that opted out could never learn its updates went stale.
 */
export const gitSubscribeStatusV13 = defineStreamRpcContract({
  method: "git.subscribeStatus",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: gitSubscribeStatusRequestSchemaV12,
  serverFrameSchema: gitSubscribeStatusEventSchemaV13,
  clientFrameSchema: noClientFramesSchema,
});
