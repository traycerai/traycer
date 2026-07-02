/**
 * Versioned RPC contracts for the `git.*` host surface.
 * Five methods total: four unary (listChangedFiles, getFileDiff, getFileDiffs,
 * getCapabilities) and one streaming (subscribeStatus).
 */
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
  gitGetFileDiffRequestSchemaV11,
  gitGetFileDiffResponseSchema,
  gitGetFileDiffsRequestSchema,
  gitGetFileDiffsRequestSchemaV11,
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

// ---- Submodule-aware v1.1 (unary-only) ---------------------------------- //
//
// Minor bumps of the three unary methods that carry the host-composed nested
// snapshot. No new method names (a new name fatally fails the equal-set
// handshake against a shipped v1.0.0 host). `git.subscribeStatus` stays v1.0.
// Same-major minors need no downgrade path: a v1.1 peer projects onto a v1.0
// host by re-parsing through the (non-strict) v1.0 schema, which strips the new
// fields on the wire. The upgrade paths below bridge a v1.0 peer UP to canonical.

/**
 * `git.listChangedFiles@1.1` - adds parent-file `gitlink` descriptors and the
 * `submodules[]` nested snapshot, plus a `refreshRelations` request field that
 * forces a relation recompute past the SHA-tuple cache.
 */
export const gitListChangedFilesV11 = defineRpcContract({
  method: "git.listChangedFiles",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: gitListChangedFilesRequestSchemaV11,
  responseSchema: gitListChangedFilesResponseSchemaV11,
});

// A v1.0 host knows no submodules: every parent file gains `gitlink: null` and
// the response gains an empty `submodules[]` (parent-only view). A v1.0 request
// carries no manual-refresh signal, so it upgrades with `refreshRelations: false`
// (cache-served relations).
export const gitListChangedFilesUpgradeV10ToV11 = defineUpgradePath<
  typeof gitListChangedFilesV10,
  typeof gitListChangedFilesV11
>({
  from: gitListChangedFilesV10.schemaVersion,
  to: gitListChangedFilesV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, refreshRelations: false }),
  upgradeResponse: (response) => ({
    ...response,
    files: response.files.map((file) => ({ ...file, gitlink: null })),
    submodules: [],
  }),
});

/**
 * `git.getFileDiff@1.1` - adds `compareFromSha` for ahead-of-pin diffs. Response
 * shape is unchanged from v1.0.
 */
export const gitGetFileDiffV11 = defineRpcContract({
  method: "git.getFileDiff",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: gitGetFileDiffRequestSchemaV11,
  responseSchema: gitGetFileDiffResponseSchema,
});

// A v1.0 request carries no `compareFromSha`, so it upgrades to `null` (ordinary
// stage-based diff). The response is unchanged, so its upgrade is the identity.
export const gitGetFileDiffUpgradeV10ToV11 = defineUpgradePath<
  typeof gitGetFileDiffV10,
  typeof gitGetFileDiffV11
>({
  from: gitGetFileDiffV10.schemaVersion,
  to: gitGetFileDiffV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, compareFromSha: null }),
  upgradeResponse: (response) => response,
});

/**
 * `git.getFileDiffs@1.1` - adds a per-file `compareFromSha`. Response shape is
 * unchanged from v1.0.
 */
export const gitGetFileDiffsV11 = defineRpcContract({
  method: "git.getFileDiffs",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: gitGetFileDiffsRequestSchemaV11,
  responseSchema: gitGetFileDiffsResponseSchema,
});

// Each v1.0 batch item gains `compareFromSha: null`. The response is unchanged,
// so its upgrade is the identity.
export const gitGetFileDiffsUpgradeV10ToV11 = defineUpgradePath<
  typeof gitGetFileDiffsV10,
  typeof gitGetFileDiffsV11
>({
  from: gitGetFileDiffsV10.schemaVersion,
  to: gitGetFileDiffsV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    files: request.files.map((file) => ({ ...file, compareFromSha: null })),
  }),
  upgradeResponse: (response) => response,
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
