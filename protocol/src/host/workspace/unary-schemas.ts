/**
 * Host ↔ client wire shapes for local workspace assistance.
 *
 * These schemas stay browser-safe. The host owns the filesystem and git
 * commands; clients only send attached local roots and receive display-ready
 * suggestions.
 */
import { z } from "zod";
import { taskRepoIdentifierSchema } from "@traycer/protocol/host/epic/unary-schemas";

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

/**
 * A git worktree of the workspace, surfaced as a directory-context mention.
 * `worktreePath` is the worktree's absolute on-disk directory (it lives
 * OUTSIDE the workspace root, so there is no workspace-relative path); it is
 * what the mention serializes to the agent as `@<worktreePath>`. `workspacePath`
 * is the source workspace root the worktree was listed for; `branch` is the
 * branch checked out in the worktree (null when detached). `isMain` marks the
 * primary checkout (the workspace itself).
 */
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

/**
 * Cross-host workspace lookup. Given a list of repo identifiers the
 * client knows about, returns the host's locally-mapped workspace
 * paths (one per known identifier). Identifiers the host does not
 * know are omitted from the response - callers treat absent rows as
 * "not on this host" and surface a "Locate on this host…"
 * affordance.
 *
 * Backed by `RepoWorkspacePersistence` on the host side; the wire
 * stays per-host by design (paths only mean something on the host
 * that owns them).
 */
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
 *
 * `path` is host-canonical: POSIX-relative to the workspace root,
 * `/`-separated, no leading slash - the host normalizes its native OS
 * separators before sending. The renderer treats it as an opaque token
 * and never parses it. `name` is the display basename, computed by the
 * host, so the renderer never has to derive it from the path string.
 */
export const workspaceFileTreeNodeSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
});
export type WorkspaceFileTreeNode = z.infer<
  typeof workspaceFileTreeNodeSchema
>;

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
