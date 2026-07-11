import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { deriveWorkspaceMode } from "../workspace-mode";
import { readSeededLaunchWorkspace } from "../seeded-launch-worktree-intent";

const STAGING_KEY = {
  surface: "owner" as const,
  epicId: "epic-1",
  ownerKind: "chat" as const,
  ownerId: "__pending_fork_chat__",
};

const GIT_FOLDER = { path: "/repo/git", name: "git", repoIdentifier: null };
const NON_GIT_FOLDER = {
  path: "/repo/non-git",
  name: "non-git",
  repoIdentifier: null,
};

function stagedWorktreeEntry(workspacePath: string, isPrimary: boolean) {
  return {
    kind: "worktree" as const,
    scripts: null,
    workspacePath,
    repoIdentifier: null,
    isPrimary,
    branch: {
      type: "new" as const,
      name: "traycer/feature",
      source: "main",
      carryUncommittedChanges: false,
    },
  };
}

beforeEach(() => {
  useWorktreeIntentStagingStore.getState().resetForTests();
  useSeededWorkspaceSnapshotStore.getState().resetForTests();
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
});

afterEach(() => {
  useWorktreeIntentStagingStore.getState().resetForTests();
  useSeededWorkspaceSnapshotStore.getState().resetForTests();
});

describe("readSeededLaunchWorkspace", () => {
  it("falls back to the static seed workspace when the picker never mounted a live snapshot", () => {
    const seedIntent: WorktreeIntent = {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
    };
    const fallbackWorkspace: LandingDraftWorkspaceSnapshot = {
      folders: [GIT_FOLDER.path],
      folderInfoByPath: { [GIT_FOLDER.path]: GIT_FOLDER },
      primaryPath: GIT_FOLDER.path,
    };

    const result = readSeededLaunchWorkspace({
      stagingKey: STAGING_KEY,
      seedIntent,
      fallbackWorkspace,
    });

    expect(result).toEqual({ worktreeIntent: seedIntent, folderCount: 1 });
  });

  it("reads the LIVE seeded workspace snapshot - a primary switch onto a never-staged non-git folder reaches launch with exactly one primary", () => {
    const seedIntent: WorktreeIntent = {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
    };
    const fallbackWorkspace: LandingDraftWorkspaceSnapshot = {
      folders: [GIT_FOLDER.path, NON_GIT_FOLDER.path],
      folderInfoByPath: {
        [GIT_FOLDER.path]: GIT_FOLDER,
        [NON_GIT_FOLDER.path]: NON_GIT_FOLDER,
      },
      primaryPath: GIT_FOLDER.path,
    };
    // Only the git folder ever got auto-staged.
    useWorktreeIntentStagingStore.getState().setIntent(STAGING_KEY, {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
    });
    // The picker mounted and the user clicked "Set as primary" on the
    // non-git folder - mirrored into the external snapshot store exactly as
    // `useHomeWorkspaceSource`'s sync effect would.
    useSeededWorkspaceSnapshotStore.getState().setSnapshot(STAGING_KEY, {
      ...fallbackWorkspace,
      primaryPath: NON_GIT_FOLDER.path,
    });

    const result = readSeededLaunchWorkspace({
      stagingKey: STAGING_KEY,
      seedIntent,
      fallbackWorkspace,
    });

    expect(result.worktreeIntent).not.toBeNull();
    const primaries =
      result.worktreeIntent?.entries.filter((entry) => entry.isPrimary) ?? [];
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.workspacePath).toBe(NON_GIT_FOLDER.path);
    // The git folder survives, demoted - never dropped.
    expect(result.worktreeIntent?.entries).toHaveLength(2);
  });

  it("never produces a zero-primary intent when the staged intent alone is restamped away from its only entry", () => {
    // Reproduces the exact HIGH-severity failure mode: `setPrimaryFolder`
    // restamped the ONLY staged entry (the git folder) to non-primary
    // because the target (non-git) has no entry to promote - without the
    // live-snapshot read, this would leave the launch with zero primaries.
    const fallbackWorkspace: LandingDraftWorkspaceSnapshot = {
      folders: [GIT_FOLDER.path, NON_GIT_FOLDER.path],
      folderInfoByPath: {
        [GIT_FOLDER.path]: GIT_FOLDER,
        [NON_GIT_FOLDER.path]: NON_GIT_FOLDER,
      },
      primaryPath: GIT_FOLDER.path,
    };
    useWorktreeIntentStagingStore.getState().setIntent(STAGING_KEY, {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, false)],
    });
    useSeededWorkspaceSnapshotStore.getState().setSnapshot(STAGING_KEY, {
      ...fallbackWorkspace,
      primaryPath: NON_GIT_FOLDER.path,
    });

    const result = readSeededLaunchWorkspace({
      stagingKey: STAGING_KEY,
      seedIntent: null,
      fallbackWorkspace,
    });

    const primaries =
      result.worktreeIntent?.entries.filter((entry) => entry.isPrimary) ?? [];
    // EXACTLY one, never "at least one": `isPrimary` is stamped from a single
    // resolved path, so a multi-primary intent is as much a regression as a
    // zero-primary one.
    expect(primaries).toHaveLength(1);
  });

  it("uses the live global workspace for an unseeded add-node launch", () => {
    useWorkspaceFoldersStore.setState({
      folders: [GIT_FOLDER.path],
      folderInfoByPath: { [GIT_FOLDER.path]: GIT_FOLDER },
      primaryPath: GIT_FOLDER.path,
    });
    useWorktreeIntentStagingStore.getState().setIntent(STAGING_KEY, {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
    });

    const result = readSeededLaunchWorkspace({
      stagingKey: STAGING_KEY,
      seedIntent: null,
      fallbackWorkspace: null,
    });

    expect(result.folderCount).toBe(1);
    expect(result.worktreeIntent?.entries).toEqual([
      stagedWorktreeEntry(GIT_FOLDER.path, true),
    ]);
    expect(deriveWorkspaceMode(result.folderCount, result.worktreeIntent)).toBe(
      "inherit",
    );
  });

  it("derives a zero-to-one launch from the same live seeded snapshot", () => {
    const emptySeed: LandingDraftWorkspaceSnapshot = {
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    };
    useSeededWorkspaceSnapshotStore.getState().setSnapshot(STAGING_KEY, {
      folders: [GIT_FOLDER.path],
      folderInfoByPath: { [GIT_FOLDER.path]: GIT_FOLDER },
      primaryPath: GIT_FOLDER.path,
    });
    useWorktreeIntentStagingStore.getState().setIntent(STAGING_KEY, {
      entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
    });

    const result = readSeededLaunchWorkspace({
      stagingKey: STAGING_KEY,
      seedIntent: null,
      fallbackWorkspace: emptySeed,
    });

    expect(result.folderCount).toBe(1);
    expect(deriveWorkspaceMode(result.folderCount, result.worktreeIntent)).toBe(
      "inherit",
    );
  });

  it("derives a one-to-zero launch from the same live seeded snapshot", () => {
    const seededWorkspace: LandingDraftWorkspaceSnapshot = {
      folders: [GIT_FOLDER.path],
      folderInfoByPath: { [GIT_FOLDER.path]: GIT_FOLDER },
      primaryPath: GIT_FOLDER.path,
    };
    useSeededWorkspaceSnapshotStore.getState().setSnapshot(STAGING_KEY, {
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });

    const result = readSeededLaunchWorkspace({
      stagingKey: STAGING_KEY,
      seedIntent: {
        entries: [stagedWorktreeEntry(GIT_FOLDER.path, true)],
      },
      fallbackWorkspace: seededWorkspace,
    });

    expect(result).toEqual({ worktreeIntent: null, folderCount: 0 });
    expect(deriveWorkspaceMode(result.folderCount, result.worktreeIntent)).toBe(
      "folderless",
    );
  });
});
