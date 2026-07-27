import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHomeWorkspaceSource } from "../use-home-workspace-source";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

const STAGING_KEY: WorktreeStagingKey = { surface: "landing", draftId: null };
const SCRIPTS = {
  setup: {
    default: "bun install",
    macos: null,
    windows: null,
    linux: null,
  },
  teardown: {
    default: "bun run cleanup",
    macos: null,
    windows: null,
    linux: null,
  },
};

function numberedFolder(index: number): WorkspaceFolderInfo {
  return {
    path: `/tmp/cap-workspace-${index}`,
    name: `cap-workspace-${index}`,
    repoIdentifier: null,
  };
}

function stagedWorktreeEntry(
  workspacePath: string,
  scripts: typeof SCRIPTS | null,
) {
  return {
    kind: "worktree" as const,
    scripts,
    workspacePath,
    repoIdentifier: null,
    isPrimary: false,
    branch: {
      type: "new" as const,
      name: "traycer/feature",
      source: "main",
      carryUncommittedChanges: false,
    },
  };
}

beforeEach(() => {
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorktreeIntentStagingStore.getState().resetForTests();
});

afterEach(() => {
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("useHomeWorkspaceSource addResolvedFolders - cap eviction unstages the evicted secondary", () => {
  it("unstages the staged intent entry of a folder evicted by the 50-folder cap", () => {
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(STAGING_KEY, null),
    );

    // Fill to the cap with 50 folders (0..49). Folder 0 implicitly resolves
    // as primary (nothing explicit set) and is preserved by the cap; stage
    // an intent entry for every folder so whichever one the cap actually
    // evicts (the oldest SECONDARY - folder 1) still has a staged entry to
    // clean up.
    act(() => {
      result.current.addResolvedFolders(
        Array.from({ length: 50 }, (_, i) => numberedFolder(i)),
      );
    });
    act(() => {
      for (let i = 0; i < 50; i += 1) {
        result.current.stageEntry(
          stagedWorktreeEntry(numberedFolder(i).path, null),
        );
      }
    });
    const beforeFolders = useWorkspaceFoldersStore.getState().folders;

    // Add folder 50 - pushes past the cap and evicts the oldest secondary.
    act(() => {
      result.current.addResolvedFolders([numberedFolder(50)]);
    });

    const afterFolders = useWorkspaceFoldersStore.getState().folders;
    const evictedPath = beforeFolders.find(
      (path) => !afterFolders.includes(path),
    );
    expect(evictedPath).toBeDefined();
    if (evictedPath === undefined) return;
    // The primary (folder 0) must survive the cap.
    expect(afterFolders).toContain(numberedFolder(0).path);

    // The evicted folder's staged intent entry must be gone too - otherwise
    // it can still ride along in an outgoing WorktreeIntent even though the
    // row/persistence has already dropped it.
    const stagedEntries =
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(STAGING_KEY)
      ]?.entries ?? [];
    expect(stagedEntries.some((e) => e.workspacePath === evictedPath)).toBe(
      false,
    );
    // Every OTHER folder's staged entry survives untouched.
    expect(stagedEntries.length).toBe(afterFolders.length - 1);
  });

  it("keeps a draft survivor staged when only the divergent global cache evicts it", () => {
    const initialFolders = Array.from({ length: 50 }, (_, index) =>
      numberedFolder(index),
    );
    useWorkspaceFoldersStore.getState().addResolvedFolders(initialFolders);
    const draftId = useLandingDraftStore.getState().createDraft(null);

    // Keep both representations at the supported 50-folder cap while making
    // their membership and primary choices diverge. On the next add, global
    // evicts folder 1, while the active draft preserves folder 1 as primary
    // and evicts folder 0 instead.
    useLandingDraftStore
      .getState()
      .setDraftWorkspacePrimary(draftId, numberedFolder(1).path);
    useLandingDraftStore
      .getState()
      .removeDraftFolder(draftId, numberedFolder(49).path);
    useLandingDraftStore
      .getState()
      .addDraftResolvedFolders(draftId, [numberedFolder(100)]);

    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      draftId,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    const survivingEntry = stagedWorktreeEntry(numberedFolder(1).path, SCRIPTS);
    act(() => {
      result.current.stageEntry(survivingEntry);
      result.current.stageEntry(
        stagedWorktreeEntry(numberedFolder(0).path, null),
      );
    });

    act(() => {
      result.current.addResolvedFolders([numberedFolder(50)]);
    });

    const globalFolders = useWorkspaceFoldersStore.getState().folders;
    const draftWorkspace = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === draftId)?.workspace;
    expect(globalFolders).toHaveLength(50);
    expect(globalFolders).not.toContain(numberedFolder(1).path);
    expect(draftWorkspace?.folders).toHaveLength(50);
    expect(draftWorkspace?.folders).toContain(numberedFolder(1).path);
    expect(draftWorkspace?.folders).not.toContain(numberedFolder(0).path);

    const stagedEntries =
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(stagingKey)
      ]?.entries ?? [];
    expect(stagedEntries).toEqual([survivingEntry]);
    const preservedEntry = stagedEntries[0];
    expect(preservedEntry.kind).toBe("worktree");
    if (preservedEntry.kind !== "worktree") return;
    expect(preservedEntry.scripts).toEqual(SCRIPTS);
  });
});
