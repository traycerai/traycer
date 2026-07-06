import { describe, expect, it } from "vitest";
import type { WorktreeBindingEntry } from "@traycer/protocol/host";
import { resolveBindingRunningDir } from "../resolve-binding-running-dir";

describe("resolveBindingRunningDir", () => {
  it("returns worktreePath for worktree mode", () => {
    const entry: WorktreeBindingEntry = {
      workspacePath: "/home/user/project",
      mode: "worktree",
      repoIdentifier: null,
      worktreePath: "/home/user/.git/worktrees/feat-branch",
      branch: "feat-branch",
      isPrimary: false,
      isImported: false,
      setupState: "succeeded",
      setupTerminalSessionId: null,
      setupExitCode: 0,
      setupFailedAt: null,
      createdAt: Date.now(),
      ownedSubmodules: [],
    };

    expect(resolveBindingRunningDir(entry)).toBe(
      "/home/user/.git/worktrees/feat-branch",
    );
  });

  it("returns null for worktree mode when worktreePath is null", () => {
    const entry: WorktreeBindingEntry = {
      workspacePath: "/home/user/project",
      mode: "worktree",
      repoIdentifier: null,
      worktreePath: null,
      branch: null,
      isPrimary: true,
      isImported: false,
      setupState: "pending",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      createdAt: Date.now(),
      ownedSubmodules: [],
    };

    expect(resolveBindingRunningDir(entry)).toBeNull();
  });

  it("returns workspacePath for local mode", () => {
    const entry: WorktreeBindingEntry = {
      workspacePath: "/home/user/project",
      mode: "local",
      repoIdentifier: null,
      worktreePath: null,
      branch: null,
      isPrimary: true,
      isImported: false,
      setupState: "not_required",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      createdAt: Date.now(),
      ownedSubmodules: [],
    };

    expect(resolveBindingRunningDir(entry)).toBe("/home/user/project");
  });

  it("ignores worktreePath for local mode", () => {
    const entry: WorktreeBindingEntry = {
      workspacePath: "/home/user/project",
      mode: "local",
      repoIdentifier: null,
      worktreePath: "/some/other/path",
      branch: null,
      isPrimary: true,
      isImported: false,
      setupState: "not_required",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      createdAt: Date.now(),
      ownedSubmodules: [],
    };

    expect(resolveBindingRunningDir(entry)).toBe("/home/user/project");
  });
});
