import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  workspaceFileMentionSuggestionsResponseSchema,
  workspaceGitBranchMentionSuggestionsResponseSchema,
  workspaceGitMentionSuggestionsRequestSchema,
  workspaceListDirectoryRequestSchema,
  workspaceListDirectoryResponseSchema,
  workspaceListFileTreeRequestSchema,
  workspaceListFileTreeResponseSchema,
  workspacePathMentionSuggestionsRequestSchema,
  workspaceReadFileRequestSchema,
  workspaceReadFileResponseSchema,
  workspaceWorktreeMentionSuggestionsResponseSchema,
} from "@traycer/protocol/host/index";

describe("workspace mention host schemas", () => {
  it("accepts separate file/folder and git mention shapes", () => {
    expect(
      workspacePathMentionSuggestionsRequestSchema.safeParse({
        roots: ["/repo"],
        query: "src",
        limit: 8,
      }).success,
    ).toBe(true);

    expect(
      workspaceGitMentionSuggestionsRequestSchema.safeParse({
        workspacePath: "/repo",
        query: "main",
        limit: 8,
      }).success,
    ).toBe(true);

    expect(
      workspaceFileMentionSuggestionsResponseSchema.safeParse({
        entries: [
          {
            kind: "file",
            id: "file:/repo/src/app.ts",
            label: "app.ts",
            relPath: "src/app.ts",
            absolutePath: "/repo/src/app.ts",
            workspacePath: "/repo",
            description: "src",
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      workspaceGitBranchMentionSuggestionsResponseSchema.safeParse({
        entries: [
          {
            kind: "git",
            id: "git:branch:/repo:main",
            label: "Diff against branch 'main'",
            description: "repo",
            workspacePath: "/repo",
            gitType: "against_branch",
            branchName: "main",
            commitHash: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts worktree mention shapes carrying the absolute directory", () => {
    expect(
      workspaceWorktreeMentionSuggestionsResponseSchema.safeParse({
        entries: [
          {
            kind: "worktree",
            id: "worktree:/repo:/home/u/.traycer/worktrees/o/r/feature",
            label: "feature",
            worktreePath: "/home/u/.traycer/worktrees/o/r/feature",
            workspacePath: "/repo",
            branch: "feature",
            isMain: false,
            description: "/home/u/.traycer/worktrees/o/r/feature",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts file tree paths and Trees-compatible git status entries", () => {
    expect(
      workspaceListFileTreeRequestSchema.safeParse({
        workspacePath: "/repo",
        maxFiles: 10_000,
        includeIgnored: false,
      }).success,
    ).toBe(true);

    expect(
      workspaceListFileTreeResponseSchema.safeParse({
        workspacePath: "/repo",
        files: [
          { path: "package.json", name: "package.json" },
          { path: "src/app.tsx", name: "app.tsx" },
        ],
        gitStatus: [
          { path: "src/app.tsx", status: "modified" },
          { path: "README.md", status: "untracked" },
        ],
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it("accepts lazy directory entries for file tree expansion", () => {
    expect(
      workspaceListDirectoryRequestSchema.safeParse({
        workspacePath: "/repo",
        directoryPath: "src",
      }).success,
    ).toBe(true);

    expect(
      workspaceListDirectoryResponseSchema.safeParse({
        workspacePath: "/repo",
        directoryPath: "src",
        entries: [
          { path: "src/components/", name: "components", kind: "directory" },
          { path: "src/app.tsx", name: "app.tsx", kind: "file" },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts bounded workspace file reads", () => {
    expect(
      workspaceReadFileRequestSchema.safeParse({
        workspacePath: "/repo",
        filePath: "src/app.tsx",
        maxBytes: 500_000,
      }).success,
    ).toBe(true);

    expect(
      workspaceReadFileResponseSchema.safeParse({
        workspacePath: "/repo",
        filePath: "src/app.tsx",
        content: "export const app = true;\n",
        truncated: false,
        error: null,
      }).success,
    ).toBe(true);
  });

  it("registers single-purpose workspace mention methods at v1.0", () => {
    expect(
      hostRpcRegistry["workspace.listFileTree"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.listDirectory"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.readFile"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.mentionFiles"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.mentionFolders"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.mentionWorktrees"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.mentionGitRoot"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.mentionGitBranches"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["workspace.mentionGitCommits"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
  });
});
