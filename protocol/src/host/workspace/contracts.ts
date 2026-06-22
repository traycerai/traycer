import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  prepareWorkspaceFoldersRequestSchema,
  prepareWorkspaceFoldersResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  workspaceFileMentionSuggestionsResponseSchema,
  workspaceFolderMentionSuggestionsResponseSchema,
  workspaceGitBranchMentionSuggestionsResponseSchema,
  workspaceGitCommitMentionSuggestionsResponseSchema,
  workspaceGitMentionSuggestionsRequestSchema,
  workspaceGitRootMentionSuggestionsResponseSchema,
  workspaceListDirectoryRequestSchema,
  workspaceListDirectoryResponseSchema,
  workspaceListFileTreeRequestSchema,
  workspaceListFileTreeResponseSchema,
  workspacePathMentionSuggestionsRequestSchema,
  workspaceReadFileRequestSchema,
  workspaceReadFileResponseSchema,
  workspaceResolvePathsByRepoIdentifiersRequestSchema,
  workspaceResolvePathsByRepoIdentifiersResponseSchema,
  workspaceWorktreeMentionSuggestionsResponseSchema,
} from "@traycer/protocol/host/workspace/unary-schemas";

export const workspacePrepareFoldersV10 = defineRpcContract({
  method: "workspace.prepareFolders",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prepareWorkspaceFoldersRequestSchema,
  responseSchema: prepareWorkspaceFoldersResponseSchema,
});

export const workspaceMentionFilesV10 = defineRpcContract({
  method: "workspace.mentionFiles",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspacePathMentionSuggestionsRequestSchema,
  responseSchema: workspaceFileMentionSuggestionsResponseSchema,
});

export const workspaceMentionFoldersV10 = defineRpcContract({
  method: "workspace.mentionFolders",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspacePathMentionSuggestionsRequestSchema,
  responseSchema: workspaceFolderMentionSuggestionsResponseSchema,
});

export const workspaceMentionWorktreesV10 = defineRpcContract({
  method: "workspace.mentionWorktrees",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspacePathMentionSuggestionsRequestSchema,
  responseSchema: workspaceWorktreeMentionSuggestionsResponseSchema,
});

export const workspaceMentionGitRootV10 = defineRpcContract({
  method: "workspace.mentionGitRoot",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceGitMentionSuggestionsRequestSchema,
  responseSchema: workspaceGitRootMentionSuggestionsResponseSchema,
});

export const workspaceMentionGitBranchesV10 = defineRpcContract({
  method: "workspace.mentionGitBranches",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceGitMentionSuggestionsRequestSchema,
  responseSchema: workspaceGitBranchMentionSuggestionsResponseSchema,
});

export const workspaceMentionGitCommitsV10 = defineRpcContract({
  method: "workspace.mentionGitCommits",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceGitMentionSuggestionsRequestSchema,
  responseSchema: workspaceGitCommitMentionSuggestionsResponseSchema,
});

export const workspaceResolvePathsByRepoIdentifiersV10 = defineRpcContract({
  method: "workspace.resolvePathsByRepoIdentifiers",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceResolvePathsByRepoIdentifiersRequestSchema,
  responseSchema: workspaceResolvePathsByRepoIdentifiersResponseSchema,
});

export const workspaceListFileTreeV10 = defineRpcContract({
  method: "workspace.listFileTree",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceListFileTreeRequestSchema,
  responseSchema: workspaceListFileTreeResponseSchema,
});

export const workspaceListDirectoryV10 = defineRpcContract({
  method: "workspace.listDirectory",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceListDirectoryRequestSchema,
  responseSchema: workspaceListDirectoryResponseSchema,
});

export const workspaceReadFileV10 = defineRpcContract({
  method: "workspace.readFile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceReadFileRequestSchema,
  responseSchema: workspaceReadFileResponseSchema,
});
