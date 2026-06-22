/**
 * Schemas for the `git.*` host RPC surface - Git status polling,
 * file diff querying, and repo capability detection.
 *
 * `runningDir` values are canonical absolute host paths. Git file paths are
 * repo-relative Git paths; see ADR-0008.
 * OID fields are nullable to support ADR-0007 degraded mode (very large repos).
 * `pollStartedAtMs` on subscription events enables post-hoc debugging of skew
 * per ADR-0004.
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
 * Per-file metadata from a `git status` poll.
 *
 * `path` and `previousPath` are repo-relative Git paths.
 * `previousPath` is set only for renamed/copied files (ADR-0002).
 * `stagedOid` + `worktreeOid` are nullable in degraded mode (ADR-0007).
 */
export const gitChangedFileSchema = z.object({
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
export type GitChangedFile = z.infer<typeof gitChangedFileSchema>;

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

/**
 * Host-side polling mode for a running directory.
 * `normal`: all metrics available, polling fast.
 * `degraded`: large repo, skipping OID computation, polling slower.
 * `refused`: repo exceeds hard cap (5M files), unsupported.
 */
export const repoModeSchema = z.enum(["normal", "degraded", "refused"]);
export type RepoMode = z.infer<typeof repoModeSchema>;

/**
 * `git.listChangedFiles` request.
 * `ignoreWhitespace` is accepted for compatibility but status/list output is
 * whitespace-independent; only diff-content RPCs apply whitespace filtering.
 */
export const gitListChangedFilesRequestSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  ignoreWhitespace: z.boolean(),
});
export type GitListChangedFilesRequest = z.infer<
  typeof gitListChangedFilesRequestSchema
>;

/**
 * `git.listChangedFiles` response.
 * Returns the current file list, fingerprint, and repo state.
 * `runningDir` is canonical absolute. File paths are repo-relative Git paths.
 */
export const gitListChangedFilesResponseSchema = z.object({
  runningDir: z.string(),
  headSha: z.string(),
  branch: z.string().nullable(),
  files: z.array(gitChangedFileSchema),
  fingerprint: z.string(),
  repoMode: repoModeSchema,
  repoState: repoStateSchema,
});
export type GitListChangedFilesResponse = z.infer<
  typeof gitListChangedFilesResponseSchema
>;

/**
 * `git.getFileDiff` request.
 * `filePath` is a repo-relative Git path.
 * `previousPath` is populated for renamed/copied files so git can render
 * rename-aware patches instead of a pure add for the new path.
 * `byteBudget: null` requests the full diff without server-side truncation.
 */
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

/**
 * `git.getFileDiff` response.
 * `filePath` is a repo-relative Git path.
 * Includes `isTruncated` / `truncatedAfterBytes` for large diffs.
 * Response-side `(stagedOid, worktreeOid)` enable ADR-0004 OID mismatch
 * detection in the renderer.
 */
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

/**
 * `git.getFileDiffs` request - batch diff query.
 * `files[].filePath` is a repo-relative Git path.
 * `files[].previousPath` follows `git.getFileDiff.previousPath`.
 * `files` is 1-10 items per spec; `byteBudget` defaults to 1MiB.
 */
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

/**
 * `git.getFileDiffs` response - array of per-file diffs.
 * `runningDir` is canonical absolute. Diff `filePath` values are repo-relative
 * Git paths.
 */
export const gitGetFileDiffsResponseSchema = z.object({
  runningDir: z.string(),
  headSha: z.string(),
  diffs: z.array(gitGetFileDiffResponseSchema),
});
export type GitGetFileDiffsResponse = z.infer<
  typeof gitGetFileDiffsResponseSchema
>;

/**
 * `git.getCapabilities` response.
 * `available` indicates if git feature is supported on this host.
 * `reason` is populated only if `available === false`.
 * `repoMode` is optional, populated only on capability check failure due
 * to repo size (refused mode).
 */
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
 * `git.subscribeStatus` event - status subscription frame.
 * Discriminated union: snapshot (initial full state), updated (incremental
 * change with affected paths), or error (fatal/non-fatal).
 *
 * Both snapshot and updated carry `pollStartedAtMs` per ADR-0004 for debugging.
 * `changedPaths` is an array of repo-relative Git paths that changed since the
 * last event.
 */
export const gitSubscribeStatusEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    runningDir: z.string(),
    headSha: z.string(),
    branch: z.string().nullable(),
    files: z.array(gitChangedFileSchema),
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
    files: z.array(gitChangedFileSchema),
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
 * `git.subscribeStatus` request.
 * No `pollIntervalMs` per ADR-0003 - host polls every 5s, period.
 * `ignoreWhitespace` is accepted for compatibility but status events are
 * whitespace-independent.
 */
export const gitSubscribeStatusRequestSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  ignoreWhitespace: z.boolean(),
});
export type GitSubscribeStatusRequest = z.infer<
  typeof gitSubscribeStatusRequestSchema
>;
