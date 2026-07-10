import { describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  buildAbForkWorkspaceSeed,
  buildForkWorkspaceSeed,
  buildForkWorkspaceSeedFromWorkspaceFolders,
  visibleWorktreeIntent,
} from "@/lib/worktree/fork-workspace-seed";

function bindingEntry(
  overrides: Partial<WorktreeBindingEntry>,
): WorktreeBindingEntry {
  return {
    workspacePath: "/repo",
    mode: "local",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    worktreePath: null,
    branch: "development",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
    ownedSubmodules: [],
    ...overrides,
  };
}

describe("visibleWorktreeIntent", () => {
  it("overlays staged source-chat entries on top of the persisted binding", () => {
    const binding: WorktreeBinding = {
      entries: [
        bindingEntry({ workspacePath: "/repo-a", mode: "local" }),
        bindingEntry({
          workspacePath: "/repo-b",
          mode: "worktree",
          worktreePath: "/wt/repo-b-old",
          branch: "old",
          isPrimary: false,
        }),
      ],
    };
    const stagedIntent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          workspacePath: "/repo-b",
          repoIdentifier: { owner: "traycerai", repo: "repo-b" },
          isPrimary: false,
          branch: {
            type: "new",
            name: "feature/fork",
            source: "development",
            carryUncommittedChanges: false,
          },
          scripts: null,
        },
      ],
    };

    expect(visibleWorktreeIntent(binding, stagedIntent)).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          isPrimary: true,
        },
        stagedIntent.entries[0],
      ],
    });
  });

  it("appends staged-only folders after binding folders", () => {
    const intent = visibleWorktreeIntent(
      { entries: [bindingEntry({ workspacePath: "/repo-a" })] },
      {
        entries: [
          {
            kind: "local",
            workspacePath: "/repo-c",
            repoIdentifier: null,
            isPrimary: false,
          },
        ],
      },
    );

    expect(intent?.entries.map((entry) => entry.workspacePath)).toEqual([
      "/repo-a",
      "/repo-c",
    ]);
  });
});

describe("buildAbForkWorkspaceSeed", () => {
  it("rebases a worktree-bound folder to the origin worktree path", () => {
    const seed = buildAbForkWorkspaceSeed({
      binding: {
        entries: [
          bindingEntry({
            workspacePath: "/Users/me/traycer",
            mode: "worktree",
            worktreePath: "/wt/traycer-rugged-panda",
            branch: "traycer-rugged-panda",
          }),
        ],
      },
      stagedIntent: null,
    });

    // The origin WORKTREE becomes the base folder: the A/B fork must fork off
    // the working copy the source chat actually runs in, not the root repo.
    expect(seed.intent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/wt/traycer-rugged-panda",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          isPrimary: true,
        },
      ],
    });
    expect(seed.workspace.folders).toEqual(["/wt/traycer-rugged-panda"]);
  });

  it("keeps a locally-bound folder as its own base", () => {
    const seed = buildAbForkWorkspaceSeed({
      binding: {
        entries: [bindingEntry({ workspacePath: "/Users/me/traycer" })],
      },
      stagedIntent: null,
    });

    expect(seed.intent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/Users/me/traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          isPrimary: true,
        },
      ],
    });
  });
});

describe("buildForkWorkspaceSeed", () => {
  it("returns a workspace snapshot matching the visible intent folders", () => {
    const seed = buildForkWorkspaceSeed({
      binding: {
        entries: [
          bindingEntry({
            workspacePath: "/Users/me/traycer",
            repoIdentifier: { owner: "traycerai", repo: "traycer" },
          }),
        ],
      },
      stagedIntent: null,
    });

    expect(seed.workspace).toEqual({
      folders: ["/Users/me/traycer"],
      folderInfoByPath: {
        "/Users/me/traycer": {
          path: "/Users/me/traycer",
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
        },
      },
    });
  });

  it("builds a local fallback seed from persisted terminal-agent folders", () => {
    const seed = buildForkWorkspaceSeedFromWorkspaceFolders([
      "/Users/me/traycer",
      "/Users/me/project/some-pkg",
    ]);

    expect(seed.intent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/Users/me/traycer",
          repoIdentifier: null,
          isPrimary: true,
        },
        {
          kind: "local",
          workspacePath: "/Users/me/project/some-pkg",
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    });
    expect(seed.workspace.folders).toEqual([
      "/Users/me/traycer",
      "/Users/me/project/some-pkg",
    ]);
  });
});
