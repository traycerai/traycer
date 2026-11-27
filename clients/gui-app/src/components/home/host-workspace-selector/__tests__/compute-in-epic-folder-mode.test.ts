import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import { describe, expect, it } from "vitest";
import { computeInEpicFolderMode } from "../compute-in-epic-folder-mode";

function worktreeIntent(branchName: string): WorktreeFolderIntent {
  return {
    kind: "worktree",
    workspacePath: "/repo/alpha",
    repoIdentifier: null,
    isPrimary: false,
    branch: {
      type: "new",
      name: branchName,
      source: "main",
      carryUncommittedChanges: false,
    },
    scripts: null,
  };
}

describe("computeInEpicFolderMode", () => {
  it("shows the staged new branch even while the binding is still local", () => {
    // The reported bug: in-epic "Create new worktree" stages the intent (the
    // binding stays local until the next send), so the chip must read the
    // pending branch, not "Local".
    expect(
      computeInEpicFolderMode({
        boundMode: "local",
        boundBranch: null,
        visibleIntent: worktreeIntent("feat/new-thing"),
      }),
    ).toEqual({ mode: "worktree", label: "feat/new-thing" });
  });

  it("prefers the staged create over an existing worktree binding", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "worktree",
        boundBranch: "feat/old",
        visibleIntent: worktreeIntent("feat/queued"),
      }),
    ).toEqual({ mode: "worktree", label: "feat/queued" });
  });

  it("falls back to Local when nothing is staged and the binding is local", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "local",
        boundBranch: null,
        visibleIntent: null,
      }),
    ).toEqual({ mode: "local", label: "Local" });
  });

  it("treats a missing binding entry as local", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: null,
        boundBranch: null,
        visibleIntent: null,
      }),
    ).toEqual({ mode: "local", label: "Local" });
  });

  it("shows the bound branch when bound to a worktree with no staged create", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "worktree",
        boundBranch: "feat/bound",
        visibleIntent: null,
      }),
    ).toEqual({ mode: "worktree", label: "feat/bound" });
  });

  it("falls back to a generic worktree label when the bound branch is detached", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "worktree",
        boundBranch: null,
        visibleIntent: null,
      }),
    ).toEqual({ mode: "worktree", label: "Worktree" });
  });

  it("shows a visible Local over a worktree binding", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "worktree",
        boundBranch: "feat/bound",
        visibleIntent: {
          kind: "local",
          workspacePath: "/repo/alpha",
          repoIdentifier: null,
          isPrimary: false,
        },
      }),
    ).toEqual({ mode: "local", label: "Local" });
  });

  it("shows a visible import as a worktree over a local binding", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "local",
        boundBranch: null,
        visibleIntent: {
          kind: "import",
          workspacePath: "/repo/alpha",
          repoIdentifier: null,
          isPrimary: false,
          worktreePath: "/wt/adopted",
        },
      }),
    ).toEqual({ mode: "worktree", label: "Worktree" });
  });

  it("falls back to the binding for a visible worktree whose branch name is empty", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "local",
        boundBranch: null,
        visibleIntent: worktreeIntent(""),
      }),
    ).toEqual({ mode: "local", label: "Local" });
  });
});
