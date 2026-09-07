/**
 * Schemas for the `git.*` host RPC surface - Git status polling, file diff querying, and repo capability detection.
 * OID fields are nullable to support ADR-0007 degraded mode (very large repos).
 */
import { z } from "zod";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
} from "./git-constants";

/**
 * The file status per `git status --porcelain=v2`: modified, added, deleted,
 * renamed, copied, untracked, conflicted. Orthogonal to `stage`.
 */
export const gitFileStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
]);
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;

/**
 * The stage axis: staged, unstaged, untracked, conflicted.
 * Per Q5 lock: four values, not {staged, unstaged}.
 */
export const gitStageSchema = z.enum([
  "staged",
  "unstaged",
  "untracked",
  "conflicted",
]);
export type GitStage = z.infer<typeof gitStageSchema>;

/**
 * `git.listChangedFiles@1.0` - Per-file metadata from a `git status` poll - the FROZEN v1.0 file shape.
 * `stagedOid` + `worktreeOid` are nullable in degraded mode (ADR-0007).
 */
export const gitChangedFileV10Schema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: gitFileStatusSchema,
  stage: gitStageSchema,
  isBinary: z.boolean(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  stagedOid: z.string().nullable(),
  worktreeOid: z.string().nullable(),
});
export type GitChangedFileV10 = z.infer<typeof gitChangedFileV10Schema>;

/** Back-compat alias for the frozen v1.0 file schema. */
export const gitChangedFileSchema = gitChangedFileV10Schema;
export type GitChangedFile = GitChangedFileV10;

/**
 * Discriminated union of seven repo state kinds per Q17 lock.
 * Covers: clean, merge (in progress), rebase, cherry-pick, revert, am, bisect.
 */
export const repoStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clean") }),
  z.object({
    kind: z.literal("merge"),
    headRef: z.string(),
    mergeHeads: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("rebase"),
    ontoSha: z.string(),
    originalBranch: z.string().nullable(),
    step: z.number().int().nullable(),
    totalSteps: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("cherry-pick"),
    pickingSha: z.string(),
  }),
  z.object({
    kind: z.literal("revert"),
    revertingSha: z.string(),
  }),
  z.object({
    kind: z.literal("am"),
    patchName: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("bisect"),
    goodSha: z.string().nullable(),
    badSha: z.string().nullable(),
  }),
]);
export type RepoState = z.infer<typeof repoStateSchema>;

/** Host-side polling mode for a running directory. */
export const repoModeSchema = z.enum(["normal", "degraded", "refused"]);
export type RepoMode = z.infer<typeof repoModeSchema>;

/** `git.listChangedFiles` request. */
export const gitListChangedFilesRequestSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  ignoreWhitespace: z.boolean(),
});
export type GitListChangedFilesRequest = z.infer<
  typeof gitListChangedFilesRequestSchema
>;

/** `git.listChangedFiles` response. */
export const gitListChangedFilesResponseSchema = z.object({
  runningDir: z.string(),
  headSha: z.string(),
  branch: z.string().nullable(),
  files: z.array(gitChangedFileV10Schema),
  fingerprint: z.string(),
  repoMode: repoModeSchema,
  repoState: repoStateSchema,
});
export type GitListChangedFilesResponse = z.infer<
  typeof gitListChangedFilesResponseSchema
>;

/** `git.getFileDiff` request. */
export const gitGetFileDiffRequestSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  filePath: z.string(),
  previousPath: z.string().nullable(),
  stage: gitStageSchema,
  ignoreWhitespace: z.boolean(),
  byteBudget: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET),
});
export type GitGetFileDiffRequest = z.infer<typeof gitGetFileDiffRequestSchema>;

/** `git.getFileDiff` response. */
export const gitGetFileDiffResponseSchema = z.object({
  filePath: z.string(),
  headSha: z.string(),
  stagedOid: z.string().nullable(),
  worktreeOid: z.string().nullable(),
  patch: z.string(),
  isTruncated: z.boolean(),
  truncatedAfterBytes: z.number().int().nonnegative().nullable(),
  isBinary: z.boolean(),
});
export type GitGetFileDiffResponse = z.infer<
  typeof gitGetFileDiffResponseSchema
>;

/** `git.getFileDiffs` request - batch diff query. */
export const gitGetFileDiffsRequestSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  files: z
    .array(
      z.object({
        filePath: z.string(),
        previousPath: z.string().nullable(),
        stage: gitStageSchema,
      }),
    )
    .min(1)
    .max(10),
  ignoreWhitespace: z.boolean(),
  byteBudget: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET),
});
export type GitGetFileDiffsRequest = z.infer<
  typeof gitGetFileDiffsRequestSchema
>;

/** `git.getFileDiffs` response - array of per-file diffs. */
export const gitGetFileDiffsResponseSchema = z.object({
  runningDir: z.string(),
  headSha: z.string(),
  diffs: z.array(gitGetFileDiffResponseSchema),
});
export type GitGetFileDiffsResponse = z.infer<
  typeof gitGetFileDiffsResponseSchema
>;

/**
 * On-demand full text needed to hydrate a patch-backed Diffs editor.
 * Kept out of the ordinary diff response so opening a read-only diff never transfers both complete file versions.
 */
export const gitGetFileContentsRequestSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  filePath: z.string(),
  previousPath: z.string().nullable(),
  stage: gitStageSchema,
});
export type GitGetFileContentsRequest = z.infer<
  typeof gitGetFileContentsRequestSchema
>;

export const gitEditableFileContentsSchema = z.object({
  name: z.string(),
  contents: z.string(),
});
export type GitEditableFileContents = z.infer<
  typeof gitEditableFileContentsSchema
>;

export const gitGetFileContentsResponseSchema = z.object({
  runningDir: z.string(),
  filePath: z.string(),
  oldFile: gitEditableFileContentsSchema.nullable(),
  newFile: gitEditableFileContentsSchema.nullable(),
  worktreeFile: gitEditableFileContentsSchema.nullable(),
  error: z.string().nullable(),
});
export type GitGetFileContentsResponse = z.infer<
  typeof gitGetFileContentsResponseSchema
>;

/** `git.getCapabilities` response. */
export const gitGetCapabilitiesResponseSchema = z.discriminatedUnion(
  "available",
  [
    z
      .object({
        available: z.literal(true),
        gitVersion: z.string().nullable(),
        reason: z.null(),
        repoMode: z.undefined().optional(),
      })
      .strict(),
    z
      .object({
        available: z.literal(false),
        gitVersion: z.string().nullable(),
        reason: z.string(),
        repoMode: repoModeSchema.optional(),
      })
      .strict(),
  ],
);
export type GitGetCapabilitiesResponse = z.infer<
  typeof gitGetCapabilitiesResponseSchema
>;

/**
 * `git.subscribeStatus` event - the FROZEN minor-0 status subscription frame.
 * Frozen at minor 0: connections negotiated at 1.0 receive frames the host resolver projects onto exactly this shape (v1.0 file rows, parent-only `fingerprint`, no submodule fields).
 */
export const gitSubscribeStatusEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV10Schema),
    fingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    pollStartedAtMs: z.number().int(),
  }),
  z.object({
    type: z.literal("updated"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV10Schema),
    fingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    changedPaths: z.array(z.string()),
    pollStartedAtMs: z.number().int(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    isFatal: z.boolean(),
  }),
]);
export type GitSubscribeStatusEvent = z.infer<
  typeof gitSubscribeStatusEventSchema
>;

/**
 * `git.subscribeStatus` request - shared verbatim by minors 0 and 1 (v1.1 deliberately adds NO `includeSubmodules` knob; the host always computes the nested snapshot and the resolver projects per negotiated minor).
 * No `pollIntervalMs` per ADR-0003 - the host owns the refresh cadence (watcher-driven with a fallback tick on v1.1 hosts; fixed-interval polling before that), and it is never a client knob.
 */
export const gitSubscribeStatusRequestSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  ignoreWhitespace: z.boolean(),
});
export type GitSubscribeStatusRequest = z.infer<
  typeof gitSubscribeStatusRequestSchema
>;

/**
 * `git.subscribeStatus@1.2` open request.
 * The v1.0/v1.1 request shape is released and must stay byte-for-byte stable for negotiated older peers.
 */
export const gitSubscribeStatusRequestSchemaV12 =
  gitSubscribeStatusRequestSchema.extend({
    freshNonce: z.string().nullable(),
  });
export type GitSubscribeStatusRequestV12 = z.infer<
  typeof gitSubscribeStatusRequestSchemaV12
>;

// `git.listChangedFiles@1.1` - ---- Submodule-aware v1.1 ------------------------------------------------ //
// None of it may reach a peer negotiated at minor 0 - `git.subscribeStatus@1.0` stays frozen and parent-only via resolver-side projection.

/**
 * Base/ours/theirs pins carried by a conflicted (`u UU S...`) parent gitlink row.
 * Each is nullable because a stage may be absent (e.g. an add/add conflict has no base).
 */
const submoduleConflictShas = {
  baseSha: z.string().nullable(),
  oursSha: z.string().nullable(),
  theirsSha: z.string().nullable(),
};

/**
 * The parent's view of a gitlink row - the descriptor hung off a parent file row via `gitChangedFileV11Schema.gitlink`, and the SINGLE canonical home for a submodule pointer conflict.
 * A discriminated union so a normal pin-and-flags row can never also carry conflict SHAs (an unrepresentable mixture)
 */
export const submodulePointerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("normal"),
    recordedPinSha: z.string().nullable(),
    submoduleHeadSha: z.string().nullable(),
    diverged: z.boolean(),
    commitChanged: z.boolean(),
    modifiedContent: z.boolean(),
    untrackedContent: z.boolean(),
  }),
  z.object({ kind: z.literal("conflicted"), ...submoduleConflictShas }),
]);
export type SubmodulePointer = z.infer<typeof submodulePointerSchema>;

/**
 * `git.subscribeStatus@1.1` - The v1.1 file shape: the frozen v1.0 file EXTENDED with a nullable `gitlink` descriptor.
 */
export const gitChangedFileV11Schema = gitChangedFileV10Schema.extend({
  gitlink: submodulePointerSchema.nullable().default(null),
});
export type GitChangedFileV11 = z.infer<typeof gitChangedFileV11Schema>;

/**
 * Whether the host could actually inspect a discovered submodule.
 * A new `state` must ship as a MAJOR bump, or the newer side must explicitly project it onto `ok`/`unavailable` before the payload reaches a peer negotiated at 1.1.
 */
export const submoduleAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok") }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum(["git-error"]).catch("git-error"),
  }),
]);
export type SubmoduleAvailability = z.infer<typeof submoduleAvailabilitySchema>;

/**
 * One initialized submodule section in the `git.listChangedFiles@1.1` response (plan §1.3) - working-tree only, NO commits-ahead.
 */
export const submoduleChangesetSchema = z.object({
  repoRoot: z.string(),
  parentPath: z.string(),
  branch: z.string().nullable(),
  repoState: repoStateSchema,
  files: z.array(gitChangedFileV11Schema),
  pointer: submodulePointerSchema,
  availability: submoduleAvailabilitySchema.default({ state: "ok" }),
});
export type SubmoduleChangeset = z.infer<typeof submoduleChangesetSchema>;

/**
 * `git.listChangedFiles@1.1` request.
 * The frozen v1.0 request plus `includeSubmodules`: the host runs the per-submodule fan-out (discovery + git status into initialized submodules + `.gitmodules` enumeration) only when asked.
 */
export const gitListChangedFilesRequestSchemaV11 =
  gitListChangedFilesRequestSchema.extend({
    includeSubmodules: z.boolean().default(false),
  });
export type GitListChangedFilesRequestV11 = z.infer<
  typeof gitListChangedFilesRequestSchemaV11
>;

/**
 * `git.listChangedFiles@1.1` response.
 * The frozen v1.0 response with two additive fields: parent `files` carry the v1.1 file shape (nullable `gitlink`), and `submodules` is the host-composed nested snapshot.
 */
export const gitListChangedFilesResponseSchemaV11 =
  gitListChangedFilesResponseSchema.extend({
    files: z.array(gitChangedFileV11Schema),
    submodules: z.array(submoduleChangesetSchema).default([]),
  });
export type GitListChangedFilesResponseV11 = z.infer<
  typeof gitListChangedFilesResponseSchemaV11
>;

// `git.getFileDiff` / `git.getFileDiffs` have NO v1.1 schema - they stay v1.0-only.

// `git.subscribeStatus@1.1` - ---- Stream v1.1: git.subscribeStatus nested-snapshot frames ------------- //
// It must NEVER appear in (or fold into) a minor-0 frame.

export const submoduleChangesetUpdatedSchemaV11 =
  submoduleChangesetSchema.extend({
    changedPaths: z.array(z.string()),
  });
export type SubmoduleChangesetUpdatedV11 = z.infer<
  typeof submoduleChangesetUpdatedSchemaV11
>;

/** `git.subscribeStatus@1.1` event - the nested-snapshot frame. */
export const gitSubscribeStatusEventSchemaV11 = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV11Schema),
    fingerprint: z.string(),
    nestedFingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    submodules: z.array(submoduleChangesetSchema),
    pollStartedAtMs: z.number().int(),
  }),
  z.object({
    type: z.literal("updated"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV11Schema),
    fingerprint: z.string(),
    nestedFingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    changedPaths: z.array(z.string()),
    submodules: z.array(submoduleChangesetUpdatedSchemaV11),
    pollStartedAtMs: z.number().int(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    isFatal: z.boolean(),
  }),
]);
export type GitSubscribeStatusEventV11 = z.infer<
  typeof gitSubscribeStatusEventSchemaV11
>;

// ---- Stream v1.2: guaranteed-fresh replacement correlation -------------- //

export const gitSubscribeStatusEventSchemaV12 = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV11Schema),
    fingerprint: z.string(),
    nestedFingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    submodules: z.array(submoduleChangesetSchema),
    pollStartedAtMs: z.number().int(),
    freshNonce: z.string().nullable(),
  }),
  z.object({
    type: z.literal("updated"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV11Schema),
    fingerprint: z.string(),
    nestedFingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    changedPaths: z.array(z.string()),
    submodules: z.array(submoduleChangesetUpdatedSchemaV11),
    pollStartedAtMs: z.number().int(),
    freshNonce: z.string().nullable(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    isFatal: z.boolean(),
  }),
]);
export type GitSubscribeStatusEventV12 = z.infer<
  typeof gitSubscribeStatusEventSchemaV12
>;

// ---- Stream v1.3: watcher health ---------------------------------------- //

/**
 * Watcher health for the subscribed repo, carried on `snapshot`/`updated` v1.3 frames.
 * `detail` is a HUMAN-READABLE diagnostic string - render it, never parse it.
 */
export const gitWatcherStatusSchema = z.object({
  state: z.enum([
    "starting",
    "watching",
    "degraded-capacity",
    "degraded-error",
  ]),
  detail: z.string().nullable(),
});
export type GitWatcherStatus = z.infer<typeof gitWatcherStatusSchema>;

/** `git.subscribeStatus@1.3` event - v1.2 frames plus `watcher` on `snapshot`/`updated`. */
export const gitSubscribeStatusEventSchemaV13 = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV11Schema),
    fingerprint: z.string(),
    nestedFingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    submodules: z.array(submoduleChangesetSchema),
    pollStartedAtMs: z.number().int(),
    freshNonce: z.string().nullable(),
    watcher: gitWatcherStatusSchema,
  }),
  z.object({
    type: z.literal("updated"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileV11Schema),
    fingerprint: z.string(),
    nestedFingerprint: z.string(),
    repoMode: repoModeSchema,
    repoState: repoStateSchema,
    changedPaths: z.array(z.string()),
    submodules: z.array(submoduleChangesetUpdatedSchemaV11),
    pollStartedAtMs: z.number().int(),
    freshNonce: z.string().nullable(),
    watcher: gitWatcherStatusSchema,
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    isFatal: z.boolean(),
  }),
]);
export type GitSubscribeStatusEventV13 = z.infer<
  typeof gitSubscribeStatusEventSchemaV13
>;
