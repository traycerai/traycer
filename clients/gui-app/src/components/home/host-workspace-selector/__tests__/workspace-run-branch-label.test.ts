import { describe, expect, it } from "vitest";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  locationSelectionChanges,
  workspaceRunBranchLabel,
  workspaceRunBranchSourceLabel,
} from "../workspace-run-item";

const BASE = {
  workspacePath: "/repo",
  repoIdentifier: null,
  isPrimary: true,
} as const;

function newWorktree(
  source: string,
  carryUncommittedChanges: boolean,
): WorktreeFolderIntent {
  return {
    kind: "worktree",
    ...BASE,
    scripts: null,
    branch: {
      type: "new",
      name: "traycer/swift-otter",
      source,
      carryUncommittedChanges,
    },
  };
}

describe("workspaceRunBranchLabel — new worktree shows its target branch", () => {
  it("shows the new branch name for a carry-WIP fork", () => {
    expect(
      workspaceRunBranchLabel({
        mode: "worktree",
        currentBranch: "development",
        currentIntent: newWorktree("development", true),
        diskWorktrees: [],
      }),
    ).toBe("traycer/swift-otter");
  });

  it("shows the new branch name for a clean fork", () => {
    expect(
      workspaceRunBranchLabel({
        mode: "worktree",
        currentBranch: "development",
        currentIntent: newWorktree("development", false),
        diskWorktrees: [],
      }),
    ).toBe("traycer/swift-otter");
  });

  it("shows the new branch name rather than a non-working-tree source", () => {
    expect(
      workspaceRunBranchLabel({
        mode: "worktree",
        currentBranch: "development",
        currentIntent: newWorktree("release/2", false),
        diskWorktrees: [],
      }),
    ).toBe("traycer/swift-otter");
  });

  it("shows the adopted branch name for an existing-branch checkout (the name IS the source)", () => {
    const intent: WorktreeFolderIntent = {
      kind: "worktree",
      ...BASE,
      scripts: null,
      branch: { type: "existing", name: "release/1.2" },
    };
    expect(
      workspaceRunBranchLabel({
        mode: "worktree",
        currentBranch: "development",
        currentIntent: intent,
        diskWorktrees: [],
      }),
    ).toBe("release/1.2");
  });

  it("falls back to the current branch for a local intent", () => {
    const intent: WorktreeFolderIntent = { kind: "local", ...BASE };
    expect(
      workspaceRunBranchLabel({
        mode: "local",
        currentBranch: "development",
        currentIntent: intent,
        diskWorktrees: [],
      }),
    ).toBe("development");
  });
});

describe("workspaceRunBranchSourceLabel", () => {
  it("keeps clean source context secondary to the target label", () => {
    expect(workspaceRunBranchSourceLabel(newWorktree("release/2", false))).toBe(
      "release/2",
    );
  });

  it("identifies working-tree WIP in the source context", () => {
    expect(
      workspaceRunBranchSourceLabel(newWorktree("development", true)),
    ).toBe("Working tree · development");
  });

  it("returns no secondary source for non-new-worktree intents", () => {
    expect(
      workspaceRunBranchSourceLabel({ kind: "local", ...BASE }),
    ).toBeNull();
  });
});

describe("locationSelectionChanges — existing → new worktree is a real switch", () => {
  const importIntent: WorktreeFolderIntent = {
    kind: "import",
    ...BASE,
    worktreePath: "/wt/feat",
  };

  it("treats New worktree as a change from an adopted (import) worktree", () => {
    // The bug: import is `mode: "worktree"`, so a coarse `nextMode === mode`
    // guard made this a no-op. The kind differs (import → worktree), so it must
    // register as a change.
    expect(locationSelectionChanges("worktree", importIntent, "worktree")).toBe(
      true,
    );
  });

  it("treats New worktree as a no-op when already a new worktree", () => {
    expect(
      locationSelectionChanges(
        "worktree",
        newWorktree("development", false),
        "worktree",
      ),
    ).toBe(false);
  });

  it("treats Local as a change from an adopted worktree, and a no-op from local", () => {
    expect(locationSelectionChanges("local", importIntent, "worktree")).toBe(
      true,
    );
    const local: WorktreeFolderIntent = { kind: "local", ...BASE };
    expect(locationSelectionChanges("local", local, "local")).toBe(false);
  });
});
