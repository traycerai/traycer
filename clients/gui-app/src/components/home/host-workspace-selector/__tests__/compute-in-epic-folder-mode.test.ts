import { describe, expect, it } from "vitest";
import { computeInEpicFolderMode } from "../compute-in-epic-folder-mode";

describe("computeInEpicFolderMode", () => {
  it("shows the staged new branch even while the binding is still local", () => {
    // The reported bug: in-epic "Create new worktree" stages the intent (the
    // binding stays local until the next send), so the chip must read the
    // pending branch, not "Local".
    expect(
      computeInEpicFolderMode({
        boundMode: "local",
        boundBranch: null,
        pendingNewBranch: "feat/new-thing",
      }),
    ).toEqual({ mode: "worktree", label: "feat/new-thing" });
  });

  it("prefers the staged create over an existing worktree binding", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "worktree",
        boundBranch: "feat/old",
        pendingNewBranch: "feat/queued",
      }),
    ).toEqual({ mode: "worktree", label: "feat/queued" });
  });

  it("falls back to Local when nothing is staged and the binding is local", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "local",
        boundBranch: null,
        pendingNewBranch: null,
      }),
    ).toEqual({ mode: "local", label: "Local" });
  });

  it("treats a missing binding entry as local", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: null,
        boundBranch: null,
        pendingNewBranch: null,
      }),
    ).toEqual({ mode: "local", label: "Local" });
  });

  it("shows the bound branch when bound to a worktree with no staged create", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "worktree",
        boundBranch: "feat/bound",
        pendingNewBranch: null,
      }),
    ).toEqual({ mode: "worktree", label: "feat/bound" });
  });

  it("falls back to a generic worktree label when the bound branch is detached", () => {
    expect(
      computeInEpicFolderMode({
        boundMode: "worktree",
        boundBranch: null,
        pendingNewBranch: null,
      }),
    ).toEqual({ mode: "worktree", label: "Worktree" });
  });
});
