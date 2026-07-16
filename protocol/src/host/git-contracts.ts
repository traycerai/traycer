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
  gitGetFileDiffResponseSchema,
  gitGetFileDiffsRequestSchema,
  gitGetFileDiffsResponseSchema,
  gitGetCapabilitiesResponseSchema,
  gitSubscribeStatusRequestSchema,
  gitSubscribeStatusEventSchema,
  gitSubscribeStatusEventSchemaV11,
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

// ---- Submodule-aware v1.1 ------------------------------------------------ //
//
// Two v1.1 surfaces carry the host-composed nested snapshot (`submodules[]` +
// parent-row `gitlink`): the unary `git.listChangedFiles@1.1` response and the
// `git.subscribeStatus@1.1` stream frames (contract at the bottom of this
// file - it deliberately REVERSES the earlier "stream stays v1.0" scoping so
// the renderer's separate 5s submodule refetch timer can die).
// `getFileDiff`/`getFileDiffs` stay v1.0-only: the submodule diff path is
// plain stage-based (run against the submodule repo root), so they need no
// request change and earn no v1.1. No new method names (a new name fatally
// fails the equal-set handshake against a shipped v1.0.0 host).
// The same-major unary minor needs no downgrade path: a v1.1 peer projects
// onto a v1.0 host by re-parsing through the (non-strict) v1.0 schema, which
// strips the new response fields on the wire. The upgrade path below bridges
// a v1.0 peer UP to canonical. Streams have no bridges at all: the HOST
// resolver projects frames to each connection's negotiated minor.

/**
 * `git.listChangedFiles@1.1` - adds parent-file `gitlink` descriptors and the
 * `submodules[]` nested snapshot on the response, plus the request-side
 * `includeSubmodules` fan-out gate (default false - the host only spawns git
 * into submodules when a caller asks for the nested snapshot).
 */
export const gitListChangedFilesV11 = defineRpcContract({
  method: "git.listChangedFiles",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: gitListChangedFilesRequestSchemaV11,
  responseSchema: gitListChangedFilesResponseSchemaV11,
});

// A v1.0 host knows no submodules: every parent file gains `gitlink: null` and
// the response gains an empty `submodules[]` (parent-only view). A v1.0 request
// never asks for the fan-out, so its upgrade pins `includeSubmodules: false`.
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
 * host's GitStatusBroadcaster owns the refresh cadence (ref-counted across
 * subscribers; watcher-driven with a fallback tick on newer hosts) and it is
 * never a client knob.
 *
 * FROZEN at minor 0: a connection negotiated here receives resolver-projected
 * parent-only frames. The nested-snapshot frames live on `@1.1` below.
 */
export const gitSubscribeStatusV10 = defineStreamRpcContract({
  method: "git.subscribeStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: gitSubscribeStatusRequestSchema,
  serverFrameSchema: gitSubscribeStatusEventSchema,
  clientFrameSchema: noClientFramesSchema,
});

/**
 * `git.subscribeStatus@1.1` - the nested-snapshot minor. `snapshot`/`updated`
 * frames additionally carry `submodules[]` (with per-submodule `changedPaths`
 * on `updated`), `nestedFingerprint`, and v1.1 `files[]` rows (`gitlink`
 * descriptors). The open request is the v1.0 schema VERBATIM - deliberately no
 * `includeSubmodules` knob: the host always computes the nested snapshot and
 * the resolver projects each frame to the connection's negotiated minor.
 *
 * COMPAT POSTURE (read before touching this line):
 * - `fingerprint` keeps PARENT-ONLY semantics on both minors (stream <-> unary
 *   parity invariant); `nestedFingerprint` is the rich-slot identity and must
 *   never appear in - or fold into the `fingerprint` of - a minor-0 frame.
 * - `gitlink` inside `files[]` rows is a WITHIN-FIELD change the
 *   minor-additivity checker does not inspect (it detects dropped fields, not
 *   item-schema changes). It is wire-safe via two INDEPENDENT guards: the host
 *   resolver projects minor-0 connections onto the frozen v1.0 frame schema,
 *   and released clients parse frames with non-strict zod (unknown fields are
 *   stripped). Do not remove either guard.
 * - Streams have no version bridges: this minor exists for handshake
 *   negotiation + resolver-side projection only, never for payload upgrading.
 */
export const gitSubscribeStatusV11 = defineStreamRpcContract({
  method: "git.subscribeStatus",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: gitSubscribeStatusRequestSchema,
  serverFrameSchema: gitSubscribeStatusEventSchemaV11,
  clientFrameSchema: noClientFramesSchema,
});
