import { describe, expect, it } from "vitest";
import {
  isTileRefRecordBacked,
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  gitDiffTileId,
  makeGitBundleDiffTile,
  makeGitFileDiffTile,
} from "@/lib/git/git-diff-tile";
import type {
  EpicArtifactRef,
  EpicTerminalRef,
  GitDiffTileRef,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";

const HOST = "host-1";

describe("gitDiffTileId", () => {
  it("is stable for the same host + payload", () => {
    const payload = {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
    } as const;
    expect(gitDiffTileId(HOST, payload)).toBe(gitDiffTileId(HOST, payload));
  });

  it("differs across payloads, stages, hosts, and kinds", () => {
    const fileA = gitDiffTileId(HOST, {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
    });
    const fileAStaged = gitDiffTileId(HOST, {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "staged",
    });
    const fileB = gitDiffTileId(HOST, {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/b.ts",
      stage: "unstaged",
    });
    const otherHost = gitDiffTileId("host-2", {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
    });
    const bundle = gitDiffTileId(HOST, {
      kind: "bundle",
      runningDir: "/repo",
      bundleGroup: "changes",
    });
    expect(new Set([fileA, fileAStaged, fileB, otherHost, bundle]).size).toBe(
      5,
    );
  });
});

describe("parseTileRef / serializeTileRef", () => {
  it("round-trips a chat artifact ref", () => {
    const ref: EpicArtifactRef = {
      id: "art-1",
      instanceId: "inst-art-1",
      type: "chat",
      name: "Chat",
      hostId: HOST,
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
  });

  it("round-trips a terminal ref with a cwd", () => {
    const withCwd: EpicTerminalRef = {
      id: "term-1",
      instanceId: "inst-term-1",
      type: "terminal",
      name: "wt-a",
      titleSource: "default",
      hostId: HOST,
      cwd: "/repo/wt-a",
    };
    expect(parseTileRef(serializeTileRef(withCwd))).toEqual(withCwd);
  });

  it("derives terminal title source for legacy refs", () => {
    expect(
      parseTileRef({
        id: "term-default",
        instanceId: "inst-term-default",
        type: "terminal",
        name: "New Terminal",
        hostId: HOST,
        cwd: "/repo",
      }),
    ).toMatchObject({ titleSource: "default" });
    expect(
      parseTileRef({
        id: "term-manual",
        instanceId: "inst-term-manual",
        type: "terminal",
        name: "shell",
        hostId: HOST,
        cwd: "/repo",
      }),
    ).toMatchObject({ titleSource: "manual" });
  });

  it("rejects a terminal ref without a cwd key", () => {
    const legacy = {
      id: "term-legacy",
      instanceId: "inst-term-legacy",
      type: "terminal",
      name: "Terminal",
      hostId: HOST,
    };
    expect(parseTileRef(legacy)).toBeNull();
  });

  it("rejects a malformed terminal cwd", () => {
    const base = {
      id: "term-bad",
      instanceId: "inst-term-bad",
      type: "terminal",
      name: "Terminal",
      hostId: HOST,
    };
    expect(parseTileRef({ ...base, cwd: 42 })).toBeNull();
    expect(parseTileRef({ ...base, cwd: {} })).toBeNull();
    expect(parseTileRef({ ...base, cwd: "" })).toBeNull();
  });

  it("round-trips a workspace-file ref", () => {
    const ref: WorkspaceFileRef = {
      id: "workspace-file:d:w:f",
      instanceId: "inst-file",
      type: "workspace-file",
      name: "f.ts",
      hostId: HOST,
      workspacePath: "/ws",
      filePath: "src/f.ts",
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
  });

  it("round-trips git-diff file and bundle tiles", () => {
    const file = makeGitFileDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: {
        workspaceLabel: "workspace",
        repositoryLabel: "packages/traycer",
      },
    });
    const bundle = makeGitBundleDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      bundleGroup: "changes",
      repositoryContext: {
        workspaceLabel: "workspace",
        repositoryLabel: "packages/traycer",
      },
    });
    expect(parseTileRef(serializeTileRef(file))).toEqual(file);
    expect(parseTileRef(serializeTileRef(bundle))).toEqual(bundle);
  });

  it("recomputes a random git-diff id on parse", () => {
    const tile = makeGitFileDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: null,
    });
    const parsed = parseTileRef({
      id: "legacy-random-uuid",
      type: "git-diff",
      name: tile.name,
      hostId: tile.hostId,
      diff: {
        kind: "file",
        runningDir: "/repo",
        filePath: "src/a.ts",
        stage: "unstaged",
      },
      view: {
        collapsedFilePaths: [],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(tile.id);
  });

  it("upgrades legacy Git bundle titles with the repository directory", () => {
    const parsed = parseTileRef({
      id: "legacy-random-uuid",
      type: "git-diff",
      name: "Changes",
      hostId: HOST,
      diff: {
        kind: "bundle",
        runningDir: "/worktrees/right-click-context-menu/traycer",
        bundleGroup: "changes",
      },
      view: {
        collapsedFilePaths: [],
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("traycer · Changes");
  });

  it("rejects unknown tile kinds", () => {
    expect(parseTileRef({ id: "x", type: "mystery", name: "n" })).toBeNull();
    expect(parseTileRef(null)).toBeNull();
  });
});

describe("isTileRefRecordBacked", () => {
  it("is true for Y.Doc artifacts and false for renderer-local tiles", () => {
    const chat: EpicArtifactRef = {
      id: "c",
      instanceId: "inst-c",
      type: "chat",
      name: "Chat",
      hostId: HOST,
    };
    const terminal: EpicTerminalRef = {
      id: "t",
      instanceId: "inst-t",
      type: "terminal",
      name: "Terminal",
      titleSource: "manual",
      hostId: HOST,
      cwd: "/repo",
    };
    const gitDiff: GitDiffTileRef = makeGitFileDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: null,
    });
    expect(isTileRefRecordBacked(chat)).toBe(true);
    expect(isTileRefRecordBacked(terminal)).toBe(false);
    expect(isTileRefRecordBacked(gitDiff)).toBe(false);
  });

  it("treats stale unknown persisted tile kinds as not record-backed", () => {
    expect(isTileRefRecordBacked({ type: "workspaces" })).toBe(false);
    expect(isTileRefRecordBacked({ type: null })).toBe(false);
  });
});
