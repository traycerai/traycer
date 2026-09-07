/** Host ↔ client wire shapes for local workspace assistance. */
import { z } from "zod";
import {
  preparedWorkspaceFolderSchema,
  taskRepoIdentifierSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  SEARCH_TEXT_PREVIEW_MAX_BYTES,
  searchTextPreviewRangeSchema,
} from "@traycer/protocol/host/search-text-preview-schema";

export const workspaceMentionGitTypeSchema = z.enum([
  "against_uncommitted_changes",
  "against_branch",
  "against_commit",
]);
export type WorkspaceMentionGitType = z.infer<
  typeof workspaceMentionGitTypeSchema
>;

export const workspaceFileTreeGitStatusSchema = z.enum([
  "added",
  "deleted",
  "ignored",
  "modified",
  "renamed",
  "untracked",
]);
export type WorkspaceFileTreeGitStatus = z.infer<
  typeof workspaceFileTreeGitStatusSchema
>;

export const workspacePathMentionSuggestionsRequestSchema = z.object({
  roots: z.array(z.string()),
  query: z.string(),
  limit: z.number().int().min(1).max(100),
});
export type WorkspacePathMentionSuggestionsRequest = z.infer<
  typeof workspacePathMentionSuggestionsRequestSchema
>;

export const workspaceGitMentionSuggestionsRequestSchema = z.object({
  workspacePath: z.string(),
  query: z.string(),
  limit: z.number().int().min(1).max(100),
});
export type WorkspaceGitMentionSuggestionsRequest = z.infer<
  typeof workspaceGitMentionSuggestionsRequestSchema
>;

export const workspaceFileMentionSuggestionSchema = z.object({
  kind: z.literal("file"),
  id: z.string(),
  label: z.string(),
  relPath: z.string(),
  absolutePath: z.string(),
  workspacePath: z.string(),
  description: z.string(),
});
export type WorkspaceFileMentionSuggestion = z.infer<
  typeof workspaceFileMentionSuggestionSchema
>;

export const workspaceFolderMentionSuggestionSchema = z.object({
  kind: z.literal("folder"),
  id: z.string(),
  label: z.string(),
  relPath: z.string(),
  absolutePath: z.string(),
  workspacePath: z.string(),
  description: z.string(),
});
export type WorkspaceFolderMentionSuggestion = z.infer<
  typeof workspaceFolderMentionSuggestionSchema
>;

/** A git worktree of the workspace, surfaced as a directory-context mention. */
export const workspaceWorktreeMentionSuggestionSchema = z.object({
  kind: z.literal("worktree"),
  id: z.string(),
  label: z.string(),
  worktreePath: z.string(),
  workspacePath: z.string(),
  branch: z.string().nullable(),
  isMain: z.boolean(),
  description: z.string(),
});
export type WorkspaceWorktreeMentionSuggestion = z.infer<
  typeof workspaceWorktreeMentionSuggestionSchema
>;

export const workspaceGitUncommittedMentionSuggestionSchema = z.object({
  kind: z.literal("git"),
  id: z.string(),
  label: z.string(),
  description: z.string(),
  workspacePath: z.string(),
  gitType: z.literal("against_uncommitted_changes"),
  branchName: z.null(),
  commitHash: z.null(),
});
export type WorkspaceGitUncommittedMentionSuggestion = z.infer<
  typeof workspaceGitUncommittedMentionSuggestionSchema
>;

export const workspaceGitBranchMentionSuggestionSchema = z.object({
  kind: z.literal("git"),
  id: z.string(),
  label: z.string(),
  description: z.string(),
  workspacePath: z.string(),
  gitType: z.literal("against_branch"),
  branchName: z.string(),
  commitHash: z.null(),
});
export type WorkspaceGitBranchMentionSuggestion = z.infer<
  typeof workspaceGitBranchMentionSuggestionSchema
>;

export const workspaceGitCommitMentionSuggestionSchema = z.object({
  kind: z.literal("git"),
  id: z.string(),
  label: z.string(),
  description: z.string(),
  workspacePath: z.string(),
  gitType: z.literal("against_commit"),
  branchName: z.null(),
  commitHash: z.string(),
});
export type WorkspaceGitCommitMentionSuggestion = z.infer<
  typeof workspaceGitCommitMentionSuggestionSchema
>;

export const workspaceGitMentionSuggestionSchema = z.discriminatedUnion(
  "gitType",
  [
    workspaceGitUncommittedMentionSuggestionSchema,
    workspaceGitBranchMentionSuggestionSchema,
    workspaceGitCommitMentionSuggestionSchema,
  ],
);
export type WorkspaceGitMentionSuggestion = z.infer<
  typeof workspaceGitMentionSuggestionSchema
>;

export const workspaceGitRootMentionSuggestionSchema = z.discriminatedUnion(
  "gitType",
  [
    workspaceGitUncommittedMentionSuggestionSchema,
    workspaceGitBranchMentionSuggestionSchema,
  ],
);
export type WorkspaceGitRootMentionSuggestion = z.infer<
  typeof workspaceGitRootMentionSuggestionSchema
>;

export const workspaceMentionSuggestionSchema = z.union([
  workspaceFileMentionSuggestionSchema,
  workspaceFolderMentionSuggestionSchema,
  workspaceWorktreeMentionSuggestionSchema,
  workspaceGitMentionSuggestionSchema,
]);
export type WorkspaceMentionSuggestion = z.infer<
  typeof workspaceMentionSuggestionSchema
>;

export const workspaceFileMentionSuggestionsResponseSchema = z.object({
  entries: z.array(workspaceFileMentionSuggestionSchema),
});
export type WorkspaceFileMentionSuggestionsResponse = z.infer<
  typeof workspaceFileMentionSuggestionsResponseSchema
>;

export const workspaceFolderMentionSuggestionsResponseSchema = z.object({
  entries: z.array(workspaceFolderMentionSuggestionSchema),
});
export type WorkspaceFolderMentionSuggestionsResponse = z.infer<
  typeof workspaceFolderMentionSuggestionsResponseSchema
>;

export const workspaceWorktreeMentionSuggestionsResponseSchema = z.object({
  entries: z.array(workspaceWorktreeMentionSuggestionSchema),
});
export type WorkspaceWorktreeMentionSuggestionsResponse = z.infer<
  typeof workspaceWorktreeMentionSuggestionsResponseSchema
>;

export const workspaceGitRootMentionSuggestionsResponseSchema = z.object({
  entries: z.array(workspaceGitRootMentionSuggestionSchema),
});
export type WorkspaceGitRootMentionSuggestionsResponse = z.infer<
  typeof workspaceGitRootMentionSuggestionsResponseSchema
>;

export const workspaceGitBranchMentionSuggestionsResponseSchema = z.object({
  entries: z.array(workspaceGitBranchMentionSuggestionSchema),
});
export type WorkspaceGitBranchMentionSuggestionsResponse = z.infer<
  typeof workspaceGitBranchMentionSuggestionsResponseSchema
>;

export const workspaceGitCommitMentionSuggestionsResponseSchema = z.object({
  entries: z.array(workspaceGitCommitMentionSuggestionSchema),
});
export type WorkspaceGitCommitMentionSuggestionsResponse = z.infer<
  typeof workspaceGitCommitMentionSuggestionsResponseSchema
>;

/** Cross-host workspace lookup. */
export const workspaceResolvePathsByRepoIdentifiersRequestSchema = z.object({
  repoIdentifiers: z.array(taskRepoIdentifierSchema),
});
export type WorkspaceResolvePathsByRepoIdentifiersRequest = z.infer<
  typeof workspaceResolvePathsByRepoIdentifiersRequestSchema
>;

export const workspaceRepoPathMappingSchema = z.object({
  repoIdentifier: taskRepoIdentifierSchema,
  workspacePath: z.string(),
});
export type WorkspaceRepoPathMapping = z.infer<
  typeof workspaceRepoPathMappingSchema
>;

export const workspaceResolvePathsByRepoIdentifiersResponseSchema = z.object({
  mappings: z.array(workspaceRepoPathMappingSchema),
});
export type WorkspaceResolvePathsByRepoIdentifiersResponse = z.infer<
  typeof workspaceResolvePathsByRepoIdentifiersResponseSchema
>;

/**
 * @deprecated Request of the legacy `workspace.listFileTree` snapshot - see the deprecation note on `workspaceListFileTreeV10` in `contracts.ts`.
 * Kept only for the released floor and the old-host fallback; new work uses `workspace.subscribeFileList` / `workspace.searchPaths`.
 */
export const workspaceListFileTreeRequestSchema = z.object({
  workspacePath: z.string(),
  maxFiles: z.number().int().min(1).max(50_000),
  includeIgnored: z.boolean(),
});
export type WorkspaceListFileTreeRequest = z.infer<
  typeof workspaceListFileTreeRequestSchema
>;

export const workspaceFileTreeGitStatusEntrySchema = z.object({
  // Same host-canonical path contract as `workspaceFileTreeNodeSchema`:
  // POSIX-relative to the workspace root, `/`-separated, no leading slash.
  path: z.string(),
  status: workspaceFileTreeGitStatusSchema,
});
export type WorkspaceFileTreeGitStatusEntry = z.infer<
  typeof workspaceFileTreeGitStatusEntrySchema
>;

/**
 * A single file node in the workspace tree.
 * The renderer treats it as an opaque token and never parses it.
 */
export const workspaceFileTreeNodeSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
});
export type WorkspaceFileTreeNode = z.infer<typeof workspaceFileTreeNodeSchema>;

export const workspaceListFileTreeResponseSchema = z.object({
  workspacePath: z.string(),
  files: z.array(workspaceFileTreeNodeSchema),
  gitStatus: z.array(workspaceFileTreeGitStatusEntrySchema),
  truncated: z.boolean(),
});
export type WorkspaceListFileTreeResponse = z.infer<
  typeof workspaceListFileTreeResponseSchema
>;

export const workspaceDirectoryEntryKindSchema = z.enum([
  "file",
  "directory",
  "symlink",
  "other",
]);
export type WorkspaceDirectoryEntryKind = z.infer<
  typeof workspaceDirectoryEntryKindSchema
>;

export const workspaceListDirectoryRequestSchema = z.object({
  workspacePath: z.string(),
  directoryPath: z.string(),
});
export type WorkspaceListDirectoryRequest = z.infer<
  typeof workspaceListDirectoryRequestSchema
>;

export const workspaceDirectoryEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: workspaceDirectoryEntryKindSchema,
});
export type WorkspaceDirectoryEntry = z.infer<
  typeof workspaceDirectoryEntrySchema
>;

export const workspaceListDirectoryResponseSchema = z.object({
  workspacePath: z.string(),
  directoryPath: z.string(),
  entries: z.array(workspaceDirectoryEntrySchema),
});
export type WorkspaceListDirectoryResponse = z.infer<
  typeof workspaceListDirectoryResponseSchema
>;

const ABSOLUTE_HOST_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

const absoluteHostPathSchema = z
  .string()
  .min(1)
  .regex(ABSOLUTE_HOST_PATH, "must be an absolute host path");

export const workspaceBrowseFolderEntrySchema = z.object({
  path: absoluteHostPathSchema,
  /** Display basename, computed by the host. */
  name: z.string().min(1),
});
export type WorkspaceBrowseFolderEntry = z.infer<
  typeof workspaceBrowseFolderEntrySchema
>;

export const workspaceBrowseFolderEntrySchemaV11 =
  workspaceBrowseFolderEntrySchema.extend({
    /** Dot-hidden on POSIX/macOS, or carrying Windows' native Hidden attribute. */
    hidden: z.boolean(),
  });
export type WorkspaceBrowseFolderEntryV11 = z.infer<
  typeof workspaceBrowseFolderEntrySchemaV11
>;

export const workspaceBrowseFoldersRequestSchema = z.object({
  directoryPath: absoluteHostPathSchema.nullable(),
});
export type WorkspaceBrowseFoldersRequest = z.infer<
  typeof workspaceBrowseFoldersRequestSchema
>;

export const workspaceBrowseFoldersResponseSchema = z.object({
  /** Absolute path that was listed (resolved from a null request). */
  directoryPath: absoluteHostPathSchema,
  /** Null only at the filesystem root; even the home directory walks up. */
  parentPath: absoluteHostPathSchema.nullable(),
  /** Direct child DIRECTORIES only; files never cross the wire. */
  entries: z.array(workspaceBrowseFolderEntrySchema),
});
export type WorkspaceBrowseFoldersResponse = z.infer<
  typeof workspaceBrowseFoldersResponseSchema
>;

export const workspaceBrowseFoldersResponseSchemaV11 =
  workspaceBrowseFoldersResponseSchema.extend({
    entries: z.array(workspaceBrowseFolderEntrySchemaV11),
  });
export type WorkspaceBrowseFoldersResponseV11 = z.infer<
  typeof workspaceBrowseFoldersResponseSchemaV11
>;

export const workspaceReadFileRequestSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  maxBytes: z.number().int().min(1).max(1_000_000),
});
export type WorkspaceReadFileRequest = z.infer<
  typeof workspaceReadFileRequestSchema
>;

export const workspaceReadFileResponseSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  content: z.string().nullable(),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type WorkspaceReadFileResponse = z.infer<
  typeof workspaceReadFileResponseSchema
>;

export const WORKSPACE_WRITE_FILE_MAX_CHARS = 1_000_000;

const workspaceFileRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 revision");

/**
 * Conflict-safe text-file write.
 * The host only saves when the live file still matches it (or already equals the submitted content, making a lost-ack retry idempotent).
 */
export const workspaceWriteFileRequestSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  expectedRevision: workspaceFileRevisionSchema,
  content: z.string().max(WORKSPACE_WRITE_FILE_MAX_CHARS),
});
export type WorkspaceWriteFileRequest = z.infer<
  typeof workspaceWriteFileRequestSchema
>;

const workspaceWriteFileResponseBaseSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
});

export const workspaceWriteFileResponseSchema = z.discriminatedUnion("status", [
  workspaceWriteFileResponseBaseSchema.extend({
    status: z.literal("saved"),
    revision: workspaceFileRevisionSchema,
  }),
  workspaceWriteFileResponseBaseSchema.extend({
    status: z.literal("conflict"),
    currentRevision: workspaceFileRevisionSchema,
    error: z.string(),
  }),
  workspaceWriteFileResponseBaseSchema.extend({
    status: z.literal("error"),
    error: z.string(),
  }),
]);
export type WorkspaceWriteFileResponse = z.infer<
  typeof workspaceWriteFileResponseSchema
>;

// Workspace root picking (T14, Journey 3; re-homed onto `workspace.prepareFolders` v1.1 by T18 - see the RPC backward-compat decision log) - the pre-workspace operations a remote client needs before it has a workspace to.

export const workspacePathRejectionReasonSchema = z.enum([
  "NOT_ABSOLUTE",
  "NOT_FOUND",
  "NOT_A_DIRECTORY",
  "NO_PERMISSION",
]);
export type WorkspacePathRejectionReason = z.infer<
  typeof workspacePathRejectionReasonSchema
>;

/**
 * Shared outcome shape for both the `validatePath` operation (live, as-you-type probing - safe to call on every keystroke, never records anything) and a newly-opened `recordRecentWorkspace` commit.
 */
export const workspaceValidatePathResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), resolvedPath: z.string() }),
  z.object({
    ok: z.literal(false),
    reason: workspacePathRejectionReasonSchema,
  }),
]);
export type WorkspaceValidatePathResponse = z.infer<
  typeof workspaceValidatePathResponseSchema
>;

export const workspaceRecentEntrySchema = z.object({
  path: z.string(),
  lastOpenedAt: z.string(),
});
export type WorkspaceRecentEntry = z.infer<typeof workspaceRecentEntrySchema>;

// `workspace.prepareFolders` v1.1 - additive `operation` discriminator folding the 4 standalone workspace-picker methods (`workspace.getHomeDir`, `workspace.validatePath`, `workspace.recordRecentWorkspace`.
// `folderPaths` stays a plain (non-nullable) array ONLY for `operation: "prepare"` - every other operation sends `folderPaths: null`, which v1.0's `z.array(z.string())` request schema rejects.

export const workspacePrepareFoldersOperationSchema = z.enum([
  "prepare",
  "getHomeDir",
  "validatePath",
  "recordRecentWorkspace",
  "listRecentWorkspaces",
]);
export type WorkspacePrepareFoldersOperation = z.infer<
  typeof workspacePrepareFoldersOperationSchema
>;

export const workspacePrepareFoldersRequestSchemaV11 = z.object({
  operation: workspacePrepareFoldersOperationSchema,
  /** Set only for `operation: "prepare"`. */
  folderPaths: z.array(z.string()).nullable(),
  /** Set only for `operation: "validatePath" | "recordRecentWorkspace"`. */
  path: z.string().nullable(),
});
export type WorkspacePrepareFoldersRequestV11 = z.infer<
  typeof workspacePrepareFoldersRequestSchemaV11
>;

export const workspacePrepareFoldersResponseSchemaV11 = z.object({
  operation: workspacePrepareFoldersOperationSchema,
  /** Set for `operation: "prepare"`; `[]` otherwise. */
  folders: z.array(preparedWorkspaceFolderSchema),
  /** Set for `operation: "prepare"`; `[]` otherwise. */
  repoIdentifiers: z.array(taskRepoIdentifierSchema),
  /** Set only for `operation: "getHomeDir"`. */
  homeDir: z.string().nullable(),
  /** Set only for `operation: "validatePath" | "recordRecentWorkspace"`. */
  validation: workspaceValidatePathResponseSchema.nullable(),
  /** Set for `operation: "listRecentWorkspaces"` and successful recent writes. */
  recentWorkspaces: z.array(workspaceRecentEntrySchema).nullable(),
});
export type WorkspacePrepareFoldersResponseV11 = z.infer<
  typeof workspacePrepareFoldersResponseSchemaV11
>;

// v1.2 keeps the v1.1 operation envelope and adds the one mutation needed by the creation pickers' integrated Recent tier.
export const workspacePrepareFoldersOperationSchemaV12 = z.enum([
  ...workspacePrepareFoldersOperationSchema.options,
  "forgetRecentWorkspace",
]);

export const workspacePrepareFoldersRequestSchemaV12 =
  workspacePrepareFoldersRequestSchemaV11.extend({
    operation: workspacePrepareFoldersOperationSchemaV12,
    /** Set only for `operation: "recordRecentWorkspace"`. */
    bumpRecency: z.boolean().nullable(),
  });
export type WorkspacePrepareFoldersRequestV12 = z.infer<
  typeof workspacePrepareFoldersRequestSchemaV12
>;

export const workspacePrepareFoldersResponseSchemaV12 =
  workspacePrepareFoldersResponseSchemaV11.extend({
    operation: workspacePrepareFoldersOperationSchemaV12,
  });
export type WorkspacePrepareFoldersResponseV12 = z.infer<
  typeof workspacePrepareFoldersResponseSchemaV12
>;

// v1.3 adds the one filesystem mutation the folder picker needs when its final typed segment does not exist.
export const workspacePrepareFoldersOperationSchemaV13 = z.enum([
  ...workspacePrepareFoldersOperationSchemaV12.options,
  "createAndPrepare",
]);

export const workspacePrepareFoldersRequestSchemaV13 =
  workspacePrepareFoldersRequestSchemaV12
    .extend({
      operation: workspacePrepareFoldersOperationSchemaV13,
    })
    .superRefine((request, context) => {
      if (request.operation !== "createAndPrepare") return;
      if (request.path === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "createAndPrepare requires path",
          path: ["path"],
        });
        return;
      }
      const absolutePath = absoluteHostPathSchema.safeParse(request.path);
      if (!absolutePath.success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "createAndPrepare requires an absolute host path",
          path: ["path"],
        });
      }
    });
export type WorkspacePrepareFoldersRequestV13 = z.infer<
  typeof workspacePrepareFoldersRequestSchemaV13
>;

export const workspacePrepareFoldersResponseSchemaV13 =
  workspacePrepareFoldersResponseSchemaV12.extend({
    operation: workspacePrepareFoldersOperationSchemaV13,
  });
export type WorkspacePrepareFoldersResponseV13 = z.infer<
  typeof workspacePrepareFoldersResponseSchemaV13
>;

// v1.4 gives the existing `bumpRecency` field meaning on `prepare` and `createAndPrepare`: true records every canonical prepared folder in one host-side recents mutation.
// The shape is unchanged; the minor version gates the new behavior so v1.3 hosts never silently ignore the request.
export const workspacePrepareFoldersRequestSchemaV14 =
  workspacePrepareFoldersRequestSchemaV13;
export type WorkspacePrepareFoldersRequestV14 = z.infer<
  typeof workspacePrepareFoldersRequestSchemaV14
>;

export const workspacePrepareFoldersResponseSchemaV14 =
  workspacePrepareFoldersResponseSchemaV13;
export type WorkspacePrepareFoldersResponseV14 = z.infer<
  typeof workspacePrepareFoldersResponseSchemaV14
>;

/**
 * Scoped file/folder name search over a SINGLE Epic-attached root.
 * The host never accepts an arbitrary absolute path as search authority - this is the boundary that `workspace.listFileTree` (which trusts the client `workspacePath`) does not enforce.
 */
export const workspaceSearchPathsReferenceSchema = z.object({
  root: z.string(),
});
export type WorkspaceSearchPathsReference = z.infer<
  typeof workspaceSearchPathsReferenceSchema
>;

/**
 * An opaque, Epic-scoped source selector.
 * The renderer may name this source, but never the host-local mirror directory behind it; the resolver derives that directory from the required request `epicId` after authorizing access.
 */
export const workspaceEpicArtifactsSourceSchema = z.object({
  kind: z.literal("epic-artifacts"),
});
export type WorkspaceEpicArtifactsSource = z.infer<
  typeof workspaceEpicArtifactsSourceSchema
>;

/**
 * A search source is either the original attached-root selector or the additive, host-derived Epic artifact source.
 */
export const workspaceSearchSourceSchema = z.union([
  workspaceEpicArtifactsSourceSchema,
  workspaceSearchPathsReferenceSchema,
]);
export type WorkspaceSearchSource = z.infer<typeof workspaceSearchSourceSchema>;

/**
 * Which candidate kinds a caller wants back.
 * The host filters candidates to this set BEFORE ranking and applying `limit`, so a `folders` request spends every one of its `limit` slots on folders (files never crowd them out) and a `files` request never pays to.
 */
export const workspaceSearchPathsKindFilterSchema = z.enum([
  "files",
  "folders",
  "both",
]);
export type WorkspaceSearchPathsKindFilter = z.infer<
  typeof workspaceSearchPathsKindFilterSchema
>;

export const workspaceSearchPathsRequestSchema = z.object({
  epicId: z.string(),
  reference: workspaceSearchSourceSchema,
  query: z.string(),
  limit: z.number().int().min(1).max(100),
  kinds: workspaceSearchPathsKindFilterSchema,
});
export type WorkspaceSearchPathsRequest = z.infer<
  typeof workspaceSearchPathsRequestSchema
>;

export const workspaceSearchPathResultKindSchema = z.enum(["file", "folder"]);
export type WorkspaceSearchPathResultKind = z.infer<
  typeof workspaceSearchPathResultKindSchema
>;

/**
 * A single ranked result.
 * `name` is the host-computed display basename so the renderer never parses the path.
 */
export const workspaceSearchPathResultSchema = z.object({
  kind: workspaceSearchPathResultKindSchema,
  relPath: z.string(),
  name: z.string(),
});
export type WorkspaceSearchPathResult = z.infer<
  typeof workspaceSearchPathResultSchema
>;

/**
 * Distinguishes a genuine search from a refused root: - `ready`: the root was authorized and searched.
 * This is deliberately a status, NOT a reason or a path, so it never leaks WHY a root was refused.
 */
export const workspaceSearchPathsOutcomeSchema = z.enum([
  "ready",
  "root_unavailable",
]);
export type WorkspaceSearchPathsOutcome = z.infer<
  typeof workspaceSearchPathsOutcomeSchema
>;

export const workspaceSearchPathsAttachedRootResponseSchema = z.object({
  epicId: z.string(),
  root: z.string(),
  outcome: workspaceSearchPathsOutcomeSchema,
  results: z.array(workspaceSearchPathResultSchema),
  truncated: z.boolean(),
});
export type WorkspaceSearchPathsAttachedRootResponse = z.infer<
  typeof workspaceSearchPathsAttachedRootResponseSchema
>;

/** Additive response branch for the opaque artifact source. */
export const workspaceSearchPathsEpicArtifactsResponseSchema = z.object({
  epicId: z.string(),
  source: workspaceEpicArtifactsSourceSchema,
  outcome: workspaceSearchPathsOutcomeSchema,
  results: z.array(workspaceSearchPathResultSchema),
  truncated: z.boolean(),
});
export type WorkspaceSearchPathsEpicArtifactsResponse = z.infer<
  typeof workspaceSearchPathsEpicArtifactsResponseSchema
>;

export const workspaceSearchPathsResponseSchema = z.union([
  workspaceSearchPathsAttachedRootResponseSchema,
  workspaceSearchPathsEpicArtifactsResponseSchema,
]);
export type WorkspaceSearchPathsResponse = z.infer<
  typeof workspaceSearchPathsResponseSchema
>;

/**
 * Scoped code TEXT (file-content) search over one attached root or the host-derived Epic artifact source.
 * Arguments are passed directly to `rg` as an argv array - the host never builds a shell string.
 */
export const workspaceSearchTextOptionsSchema = z.object({
  // `false` (default) matches the query literally (`rg --fixed-strings`); `true` treats it as a regular expression.
  regex: z.boolean(),
  // `false` (default) is case-insensitive; `true` forces a case-sensitive
  // match. This mirrors the renderer's "Match case" toggle directly.
  caseSensitive: z.boolean(),
  // `true` requires the match to fall on word boundaries (`rg --word-regexp`).
  wholeWord: z.boolean(),
  // ripgrep `--glob` include / exclude filters (relative to the selected source).
  // For the artifact source, a terminal `.md` is a virtual alias for its extensionless logical artifact path; the private `index.md` mirror layout is never exposed.
  includeGlobs: z.array(z.string()),
  excludeGlobs: z.array(z.string()),
});
export type WorkspaceSearchTextOptions = z.infer<
  typeof workspaceSearchTextOptionsSchema
>;

export const workspaceSearchTextRequestSchema = z.object({
  epicId: z.string(),
  reference: workspaceSearchSourceSchema,
  query: z.string(),
  options: workspaceSearchTextOptionsSchema,
  limit: z.number().int().min(1).max(1_000),
});
export type WorkspaceSearchTextRequest = z.infer<
  typeof workspaceSearchTextRequestSchema
>;

export const WORKSPACE_SEARCH_TEXT_PREVIEW_MAX_BYTES =
  SEARCH_TEXT_PREVIEW_MAX_BYTES;

/** One preview line for a match. */
export const workspaceSearchTextPreviewSchema = z.object({
  text: z.string(),
  ranges: z.array(searchTextPreviewRangeSchema),
});
export type WorkspaceSearchTextPreview = z.infer<
  typeof workspaceSearchTextPreviewSchema
>;

/**
 * A single content match.
 * `relPath` is host-canonical: POSIX-relative to the authorized root, `/`-separated, no leading slash - the renderer opens it by joining onto the reference root it already holds (the host never returns an absolute path.
 */
export const workspaceSearchTextMatchSchema = z.object({
  relPath: z.string(),
  lineNumber: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: workspaceSearchTextPreviewSchema,
});
export type WorkspaceSearchTextMatch = z.infer<
  typeof workspaceSearchTextMatchSchema
>;

/**
 * Distinguishes a genuine search from a refused root and from a bad pattern: - `ready`: the root was authorized and searched.
 * No search ran; deliberately a bare status that never leaks WHY.
 */
export const workspaceSearchTextOutcomeSchema = z.enum([
  "ready",
  "root_unavailable",
  "invalid_regex",
]);
export type WorkspaceSearchTextOutcome = z.infer<
  typeof workspaceSearchTextOutcomeSchema
>;

export const workspaceSearchTextAttachedRootResponseSchema = z.object({
  epicId: z.string(),
  root: z.string(),
  outcome: workspaceSearchTextOutcomeSchema,
  results: z.array(workspaceSearchTextMatchSchema),
  truncated: z.boolean(),
});
export type WorkspaceSearchTextAttachedRootResponse = z.infer<
  typeof workspaceSearchTextAttachedRootResponseSchema
>;

export const workspaceSearchTextEpicArtifactsResponseSchema = z.object({
  epicId: z.string(),
  source: workspaceEpicArtifactsSourceSchema,
  outcome: workspaceSearchTextOutcomeSchema,
  results: z.array(workspaceSearchTextMatchSchema),
  truncated: z.boolean(),
});
export type WorkspaceSearchTextEpicArtifactsResponse = z.infer<
  typeof workspaceSearchTextEpicArtifactsResponseSchema
>;

export const workspaceSearchTextResponseSchema = z.union([
  workspaceSearchTextAttachedRootResponseSchema,
  workspaceSearchTextEpicArtifactsResponseSchema,
]);
export type WorkspaceSearchTextResponse = z.infer<
  typeof workspaceSearchTextResponseSchema
>;
