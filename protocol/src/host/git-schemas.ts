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
 * Per-file metadata from a `git status` poll - the FROZEN v1.0 file shape.
 *
 * `path` and `previousPath` are repo-relative Git paths.
 * `previousPath` is set only for renamed/copied files (ADR-0002).
 * `stagedOid` + `worktreeOid` are nullable in degraded mode (ADR-0007).
 *
 * This is the ONLY file schema on the `git.subscribeStatus@1.0` stream and the
 * `git.listChangedFiles@1.0` response. It must NOT be mutated: the broadcaster
 * streams `listChangedFiles` results directly through it, and stream methods
 * carry no version bridge, so any added field would silently break old peers on
 * the live path. Submodule-aware (v1.1) additions live on the DISTINCT
 * `gitChangedFileV11Schema` below, never here.
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

/**
 * Back-compat alias for the frozen v1.0 file schema. Existing consumers import
 * `gitChangedFileSchema`; new code should reference `gitChangedFileV10Schema`
 * (the stream's only file schema) or `gitChangedFileV11Schema` (unary v1.1).
 */
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
  files: z.array(gitChangedFileV10Schema),
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

// ---- Submodule-aware v1.1 (unary-only) ---------------------------------- //
//
// Everything below is exclusive to the unary `git.listChangedFiles@1.1` surface.
// None of it may reach `git.subscribeStatus@1.0` (frozen, parent-only). The host
// composes one nested snapshot: `git.listChangedFiles@1.1` returns the parent
// changeset plus a `submodules[]` array of working-tree changesets.
// `git.getFileDiff`/`git.getFileDiffs` stay v1.0-only - a submodule's
// working-tree files are diffed by pointing `runningDir` at the submodule repo
// root (plain stage-based diff, no request change). See plan §2.

/**
 * Base/ours/theirs pins carried by a conflicted (`u UU S...`) parent gitlink
 * row. A conflicted gitlink has no single recorded pin (`<hH>`), so the ordinary
 * pin model does not apply; these three SHAs are the only pointer facts. Each is
 * nullable because a stage may be absent (e.g. an add/add conflict has no base).
 */
const submoduleConflictShas = {
  baseSha: z.string().nullable(),
  oursSha: z.string().nullable(),
  theirsSha: z.string().nullable(),
};

/**
 * The parent's view of a gitlink row - the descriptor hung off a parent file
 * row via `gitChangedFileV11Schema.gitlink`, and the SINGLE canonical home for a
 * submodule pointer conflict. A discriminated union so a normal pin-and-flags
 * row can never also carry conflict SHAs (an unrepresentable mixture):
 *
 * - `normal` carries the minimal pointer facts of an ordinary dirty gitlink: the
 *   parent-recorded pin (`<hH>`), the submodule's checkout `HEAD`, whether the
 *   two `diverged` (a plain pin-vs-HEAD inequality - NO ahead/behind/merge-base
 *   direction), and the dirty flags from `<sub>` (`c`/`m`/`u`). Both SHAs are
 *   nullable to tolerate added/removed gitlink edge cases and a missing HEAD.
 * - `conflicted` carries the unmerged base/ours/theirs pins of a pointer-only
 *   `u UU S...` row - which has no single recorded pin and earns no
 *   `submodules[]` section (plan §1.1), so its conflict facts live only here.
 *
 * The same descriptor is reused as `submoduleChangesetSchema.pointer`; the client
 * joins a parent gitlink row to its submodule section by the gitlink row `path`
 * <-> `submoduleChangeset.parentPath`.
 *
 * UNION-EVOLUTION RULE: adding a `kind` variant is NOT an additive minor change.
 * Minor-skew projection strips unknown object KEYS, but a discriminated union
 * hard-rejects an unknown discriminator VALUE - a v1.1 caller re-parsing a
 * response that carries a new `kind` fails, and the dispatcher turns that into a
 * 500 for the ENTIRE `listChangedFiles` response (`handler.ts` caller-schema
 * re-parse). A new variant must therefore ship as a MAJOR bump, or the newer
 * side must explicitly project it onto one of the variants below before the
 * payload reaches a peer negotiated at 1.1.
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
 * The unary v1.1 file shape: the frozen v1.0 file EXTENDED with a nullable
 * `gitlink` descriptor. Additive by construction (`.default(null)`), so a v1.0
 * response upgrades cleanly. Only a parent gitlink row carries a non-null
 * `gitlink`; every ordinary file row keeps it `null`. This schema NEVER touches
 * the stream - the stream stays on `gitChangedFileV10Schema`.
 */
export const gitChangedFileV11Schema = gitChangedFileV10Schema.extend({
  gitlink: submodulePointerSchema.nullable().default(null),
});
export type GitChangedFileV11 = z.infer<typeof gitChangedFileV11Schema>;

/**
 * Whether the host could actually inspect a discovered submodule. `ok` is the
 * normal case. `unavailable` marks an initialized submodule the host failed to read
 * (broken worktree, permissions, timeout, or any git error - the production
 * command runner collapses those to an unresolved checkout HEAD), so the client
 * renders a visible "details unavailable" degrade instead of a silent empty
 * section (plan: "visible degrade, never silent omission").
 *
 * `reason` is a single coarse value today but tolerant by construction:
 * `.catch("git-error")` degrades any UNKNOWN future reason (e.g. a later host
 * that emits `"timeout"`) to `"git-error"` rather than hard-failing the entire
 * `listChangedFiles@1.1` response on an already-shipped GUI. This is the trap the
 * plain enum hid: minor-skew projection strips unknown KEYS, not unknown enum
 * VALUES in a retained field, so a bare `z.enum(["git-error"])` would reject the
 * whole response the moment a future host widens this reason. The tolerance has a
 * deliberate side effect: `.catch` also absorbs a MISSING `reason`, defaulting it
 * to `"git-error"` instead of rejecting the payload.
 *
 * UNION-EVOLUTION RULE: the `.catch` tolerance covers ONLY the `reason` enum
 * axis. Adding a `state` variant is NOT an additive minor change - a
 * discriminated union hard-rejects an unknown discriminator VALUE, so a v1.1
 * caller re-parsing a response carrying a new `state` fails and the whole
 * `listChangedFiles` response 500s. A new `state` must ship as a MAJOR bump, or
 * the newer side must explicitly project it onto `ok`/`unavailable` before the
 * payload reaches a peer negotiated at 1.1.
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
 * One initialized submodule section in the `git.listChangedFiles@1.1` response
 * (plan §1.3) - working-tree only, NO commits-ahead. Dirty and unavailable
 * submodules carry visible status/files, while clean initialized submodules may
 * also be present so clients can show clean-module affordances. Conflicted or
 * removed gitlinks remain pointer-only and surface solely on the parent gitlink
 * row.
 *
 * `repoRoot` is a canonical absolute host path (realpath/NFC-normalized).
 * `parentPath` is the gitlink's parent-repo-relative Git path - the join key
 * back to the parent gitlink row. `files` are the submodule's own worktree/
 * index/untracked/conflicted files (v1.1 file shape). `branch`/`repoState`
 * describe the submodule checkout itself. `pointer` is the minimal gitlink
 * descriptor (pin equality via `diverged` + dirty/conflicted flags) - the same
 * shape carried on the parent gitlink row. `availability` flags a submodule the
 * host could not inspect; it defaults to `ok` so the field is additive.
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
 * `git.listChangedFiles@1.1` request. The frozen v1.0 request plus
 * `includeSubmodules`: the host runs the per-submodule fan-out (discovery +
 * git status into initialized submodules + `.gitmodules` enumeration) only when
 * asked. Defaults to false so lightweight callers (and v1.0 requests upgraded
 * to canonical) get the cheap parent-only snapshot with `submodules: []`.
 */
export const gitListChangedFilesRequestSchemaV11 =
  gitListChangedFilesRequestSchema.extend({
    includeSubmodules: z.boolean().default(false),
  });
export type GitListChangedFilesRequestV11 = z.infer<
  typeof gitListChangedFilesRequestSchemaV11
>;

/**
 * `git.listChangedFiles@1.1` response. The frozen v1.0 response with two
 * additive fields: parent `files` carry the v1.1 file shape (nullable `gitlink`),
 * and `submodules` is the host-composed nested snapshot. `submodules` is
 * `.default([])` so a v1.0 host's response upgrades to a parent-only view.
 */
export const gitListChangedFilesResponseSchemaV11 =
  gitListChangedFilesResponseSchema.extend({
    files: z.array(gitChangedFileV11Schema),
    submodules: z.array(submoduleChangesetSchema).default([]),
  });
export type GitListChangedFilesResponseV11 = z.infer<
  typeof gitListChangedFilesResponseSchemaV11
>;

// `git.getFileDiff` / `git.getFileDiffs` have NO v1.1 schema - they stay
// v1.0-only. A submodule's working-tree files are diffed stage-based by pointing
// `runningDir` at the submodule repo root, so the v1.0 request/response shapes
// are unchanged.
