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

/**
 * Scoped file/folder name search over a SINGLE Epic-attached root.
 *
 * `epicId` is explicit and required (the decision log forbids an omitted Epic
 * or a cross-Epic sentinel). `reference.root` names the client-selected
 * workspace-folder or worktree root - it is the same on-disk path the Epic
 * workspace pickers already expose (a binding `runningDir` or a resolved
 * workspace-folder path). It is a SELECTOR, not authority: the host resolves
 * the Epic's attached folders/bindings for THIS host, canonicalizes both
 * sides, and rejects any root that is not in that allow-list (unknown, moved,
 * escaped, or cross-host). The host never accepts an arbitrary absolute path
 * as search authority - this is the boundary that `workspace.listFileTree`
 * (which trusts the client `workspacePath`) does not enforce.
 */
export const workspaceSearchPathsReferenceSchema = z.object({
  root: z.string(),
});
export type WorkspaceSearchPathsReference = z.infer<
  typeof workspaceSearchPathsReferenceSchema
>;

/**
 * An opaque, Epic-scoped source selector. The renderer may name this source,
 * but never the host-local mirror directory behind it; the resolver derives
 * that directory from the required request `epicId` after authorizing access.
 */
export const workspaceEpicArtifactsSourceSchema = z.object({
  kind: z.literal("epic-artifacts"),
});
export type WorkspaceEpicArtifactsSource = z.infer<
  typeof workspaceEpicArtifactsSourceSchema
>;

/**
 * A search source is either the original attached-root selector or the
 * additive, host-derived Epic artifact source. Keep the `{ root }` branch
 * intact: already-built renderers continue to send and receive its legacy
 * shape without learning about artifact mirrors.
 */
export const workspaceSearchSourceSchema = z.union([
  workspaceEpicArtifactsSourceSchema,
  workspaceSearchPathsReferenceSchema,
]);
export type WorkspaceSearchSource = z.infer<typeof workspaceSearchSourceSchema>;

/**
 * Which candidate kinds a caller wants back. The host filters candidates to
 * this set BEFORE ranking and applying `limit`, so a `folders` request spends
 * every one of its `limit` slots on folders (files never crowd them out) and a
 * `files` request never pays to rank/serialize folders. `both` ranks the union.
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
 * A single ranked result. `relPath` is host-canonical: POSIX-relative to the
 * authorized root, `/`-separated, no leading slash, and (for folders) no
 * trailing slash. `name` is the host-computed display basename so the renderer
 * never parses the path. The renderer reconstructs any absolute/open target by
 * joining `relPath` onto the reference root it already holds - the host does
 * NOT return a host-absolute path as search authority.
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
 * Distinguishes a genuine search from a refused root:
 * - `ready`: the root was authorized and searched. `results` is the (possibly
 *   empty) match set - an empty `ready` means "searched, nothing matched".
 * - `root_unavailable`: the selected root is not authorized/attached/resolvable
 *   for this Epic on this host (unknown, moved, escaped, or cross-host). No
 *   search ran; `results` is empty. This is deliberately a status, NOT a reason
 *   or a path, so it never leaks WHY a root was refused. Callers treat it like
 *   an unsupported/errored request: the file-tree panel falls back to its local
 *   filter, and mention callers re-issue that root through the legacy RPC.
 */
export const workspaceSearchPathsOutcomeSchema = z.enum([
  "ready",
  "root_unavailable",
]);
export type WorkspaceSearchPathsOutcome = z.infer<
  typeof workspaceSearchPathsOutcomeSchema
>;

/**
 * Echoes the authorized `epicId` and `root` so a late response that crosses an
 * Epic/host/workspace/worktree selection change is detectable and discardable
 * by the caller. `truncated` marks that enumeration hit an internal cap.
 */
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

/**
 * Additive response branch for the opaque artifact source. It echoes the typed
 * selector rather than a mirror path, so a stale response is still detectable
 * without making the host filesystem layout part of the wire contract.
 */
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
 * Scoped code TEXT (file-content) search over one attached root or the
 * host-derived Epic artifact source.
 *
 * Same authorization boundary as {@link workspaceSearchPathsRequestSchema}:
 * `epicId` is explicit/required. For `reference: { root }`, the host authorizes
 * that selector against the Epic's attached folders/bindings for THIS host
 * (never an arbitrary absolute path). For `reference: { kind: "epic-artifacts" }`,
 * the host authorizes the Epic first, then derives its mirror root internally.
 * An unavailable source yields the typed `root_unavailable` outcome without
 * ever reaching ripgrep.
 *
 * Where path search fuzzy-ranks file NAMES, text search matches file CONTENTS
 * with ripgrep. Matching semantics are literal by default; `options.regex`
 * enables explicit regex (a bad pattern returns the typed `invalid_regex`
 * outcome, distinct from a zero-match `ready`). Arguments are passed directly to
 * `rg` as an argv array - the host never builds a shell string.
 */
export const workspaceSearchTextOptionsSchema = z.object({
  // `false` (default) matches the query literally (`rg --fixed-strings`); `true`
  // treats it as a regular expression. An invalid regex is reported as the
  // `invalid_regex` outcome rather than throwing.
  regex: z.boolean(),
  // `false` (default) is case-insensitive; `true` forces a case-sensitive
  // match. This mirrors the renderer's "Match case" toggle directly.
  caseSensitive: z.boolean(),
  // `true` requires the match to fall on word boundaries (`rg --word-regexp`).
  wholeWord: z.boolean(),
  // ripgrep `--glob` include / exclude filters (relative to the selected
  // source). Include globs restrict the walked set; exclude globs are sent as
  // negated globs (`!<glob>`). For the artifact source, a terminal `.md` is a
  // virtual alias for its extensionless logical artifact path; the private
  // `index.md` mirror layout is never exposed. Empty arrays impose no filter.
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

/**
 * Maximum size, in UTF-8 bytes, of a single match `preview.text`. ripgrep
 * returns the FULL matched line in `--json` mode (its `--max-columns` does NOT
 * bound the JSON `lines.text` payload), so the host truncates the preview to
 * this bound on a UTF-8 character boundary and clamps/drops highlight ranges so
 * every returned range still addresses the returned text. Bounds response weight
 * against a pathological single-line file.
 */
export const WORKSPACE_SEARCH_TEXT_PREVIEW_MAX_BYTES = 512;

/**
 * One preview line for a match. `text` is bounded to
 * {@link WORKSPACE_SEARCH_TEXT_PREVIEW_MAX_BYTES} UTF-8 bytes host-side. `ranges`
 * are BYTE offsets into the UTF-8 encoding of `text` (ripgrep submatch offsets),
 * not UTF-16/JS string indices, so a consumer that wants character indices
 * converts deliberately; a highlight past the truncation bound is dropped.
 */
export const workspaceSearchTextPreviewSchema = z.object({
  text: z.string(),
  ranges: z.array(
    z.object({
      startByte: z.number().int().nonnegative(),
      endByte: z.number().int().nonnegative(),
    }),
  ),
});
export type WorkspaceSearchTextPreview = z.infer<
  typeof workspaceSearchTextPreviewSchema
>;

/**
 * A single content match. `relPath` is host-canonical: POSIX-relative to the
 * authorized root, `/`-separated, no leading slash - the renderer opens it by
 * joining onto the reference root it already holds (the host never returns an
 * absolute path as authority). `lineNumber` is 1-based; `column` is the 1-based
 * CHARACTER column of the first submatch on the line (for editor navigation),
 * computed over the full line before preview truncation.
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
 * Distinguishes a genuine search from a refused root and from a bad pattern:
 * - `ready`: the root was authorized and searched. `results` is the (possibly
 *   empty) match set - an empty `ready` means "searched, nothing matched".
 * - `root_unavailable`: the selected root is not authorized/attached/resolvable
 *   for this Epic on this host. No search ran; deliberately a bare status that
 *   never leaks WHY. Callers fall back exactly as for `workspace.searchPaths`.
 * - `invalid_regex`: `options.regex` was set and the query is not a valid
 *   regular expression. No matches; a distinct typed condition so the UI can
 *   show "invalid pattern" rather than a misleading empty result.
 */
export const workspaceSearchTextOutcomeSchema = z.enum([
  "ready",
  "root_unavailable",
  "invalid_regex",
]);
export type WorkspaceSearchTextOutcome = z.infer<
  typeof workspaceSearchTextOutcomeSchema
>;

/**
 * Echoes the authorized `epicId` and `root` so a late response that crosses an
 * Epic/host/workspace/worktree/query change is detectable and discardable by the
 * caller. `truncated` marks that the search hit an internal result/byte/timeout
 * cap.
 */
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
