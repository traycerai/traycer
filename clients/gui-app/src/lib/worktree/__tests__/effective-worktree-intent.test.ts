import { describe, expect, it } from "vitest";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { effectiveWorktreeIntent } from "../effective-worktree-intent";

const GIT_FOLDER = {
  path: "/repo/git",
  name: "git",
  repoIdentifier: { owner: "acme", repo: "app" },
};
const NON_GIT_FOLDER = {
  path: "/repo/non-git",
  name: "non-git",
  repoIdentifier: null,
};

function workspace(input: {
  readonly folders: ReadonlyArray<WorkspaceFolderInfo>;
  readonly primaryPath: string | null;
}): LandingDraftWorkspaceSnapshot {
  return {
    folders: input.folders.map((f) => f.path),
    folderInfoByPath: Object.fromEntries(input.folders.map((f) => [f.path, f])),
    primaryPath: input.primaryPath,
  };
}

function stagedWorktreeEntry(workspacePath: string, isPrimary: boolean) {
  return {
    kind: "worktree" as const,
    scripts: null,
    workspacePath,
    repoIdentifier: { owner: "acme", repo: "app" },
    isPrimary,
    branch: {
      type: "new" as const,
      name: "traycer/feature",
      source: "main",
      carryUncommittedChanges: false,
    },
  };
}

describe("effectiveWorktreeIntent", () => {
  it("reproduces the seed verbatim, primary-stamped, when nothing is staged", () => {
    const ws = workspace({
      folders: [GIT_FOLDER, NON_GIT_FOLDER],
      primaryPath: GIT_FOLDER.path,
    });
    const seedIntent: WorktreeIntent = {
      entries: [
        stagedWorktreeEntry(GIT_FOLDER.path, true),
        {
          kind: "local",
          workspacePath: NON_GIT_FOLDER.path,
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    };

    const result = effectiveWorktreeIntent({
      workspace: ws,
      seedIntent,
      stagedIntent: null,
    });

    expect(result).toEqual(seedIntent);
  });

  it("synthesizes a local entry AND stamps it primary for a non-git folder with no staged entry - the finding-1 regression", () => {
    // Two folders seeded: a git folder (auto-staged as a worktree entry) and
    // a non-git folder (never auto-staged - non-git folders can't fork a
    // worktree). "Set as primary" switches to the NON-GIT folder.
    const ws = workspace({
      folders: [GIT_FOLDER, NON_GIT_FOLDER],
      // The user just switched primary to the non-git folder.
      primaryPath: NON_GIT_FOLDER.path,
    });
    const seedIntent: WorktreeIntent = {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
    };
    // Only the git folder ever reached the staging store (auto-seed effect
    // only stages git folders); the non-git folder has NO staged entry.
    const stagedIntent: WorktreeIntent = {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
    };

    const result = effectiveWorktreeIntent({
      workspace: ws,
      seedIntent,
      stagedIntent,
    });

    expect(result).not.toBeNull();
    const primaries = result?.entries.filter((e) => e.isPrimary) ?? [];
    // Exactly one primary - the non-git folder - never zero.
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.workspacePath).toBe(NON_GIT_FOLDER.path);
    expect(primaries[0]?.kind).toBe("local");
    // The git folder is demoted but still present (never dropped).
    const gitEntry = result?.entries.find(
      (e) => e.workspacePath === GIT_FOLDER.path,
    );
    expect(gitEntry?.isPrimary).toBe(false);
    expect(gitEntry?.kind).toBe("worktree");
  });

  it("resolves a primary from workspace.primaryPath when there is no seed and nothing is staged", () => {
    // Neither folder is git, so nothing auto-stages; the user switches
    // primary before anything ever reaches the staging store.
    const nonGitA = { path: "/a", name: "a", repoIdentifier: null };
    const nonGitB = { path: "/b", name: "b", repoIdentifier: null };
    const ws = workspace({
      folders: [nonGitA, nonGitB],
      primaryPath: nonGitB.path,
    });

    const result = effectiveWorktreeIntent({
      workspace: ws,
      seedIntent: null,
      stagedIntent: null,
    });

    const primaries = result?.entries.filter((e) => e.isPrimary) ?? [];
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.workspacePath).toBe(nonGitB.path);
  });

  it("drops a folder that left the workspace, even if it still has a staged entry", () => {
    const ws = workspace({
      folders: [GIT_FOLDER],
      primaryPath: GIT_FOLDER.path,
    });
    const stagedIntent: WorktreeIntent = {
      entries: [
        stagedWorktreeEntry(GIT_FOLDER.path, true),
        stagedWorktreeEntry(NON_GIT_FOLDER.path, false),
      ],
    };

    const result = effectiveWorktreeIntent({
      workspace: ws,
      seedIntent: null,
      stagedIntent,
    });

    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]?.workspacePath).toBe(GIT_FOLDER.path);
  });
});
