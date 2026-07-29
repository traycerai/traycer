import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHomeWorkspaceSource } from "../use-home-workspace-source";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

const FIRST: WorkspaceFolderInfo = {
  path: "/tmp/first-repo",
  name: "first-repo",
  repoIdentifier: null,
};
const PINNED: WorkspaceFolderInfo = {
  path: "/tmp/pinned-repo",
  name: "pinned-repo",
  repoIdentifier: null,
};

function resetStores(): void {
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
    allowMultipleFolders: false,
  });
  useLandingDraftStore.setState({
    drafts: [],
    activeDraftId: null,
    pendingWorkspace: null,
  });
  useWorktreeIntentStagingStore.getState().resetForTests();
}

beforeEach(resetStores);
afterEach(resetStores);

/**
 * `primaryWorkspacePath` is the cwd the landing terminal panel spawns every
 * new terminal in. The panel's own tests mock this hook away, so these pin the
 * contract it depends on with the real stores: the PINNED folder wins over
 * array order, whether the landing surface is backed by a draft or falls
 * through to the global folder cache.
 */
describe("useHomeWorkspaceSource primaryWorkspacePath - the pinned folder wins", () => {
  it("resolves the pinned folder, not the first one (no active draft)", () => {
    // Adding TWO folders needs multi-select on; in the default single-project
    // mode the add would keep only the first as the pending landing's main.
    useWorkspaceFoldersStore.setState({ allowMultipleFolders: true });
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      draftId: null,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    act(() => {
      result.current.addResolvedFolders([FIRST, PINNED]);
    });
    // Nothing pinned yet: array order is the deterministic fallback.
    expect(result.current.primaryWorkspacePath).toBe(FIRST.path);

    act(() => {
      result.current.setPrimaryFolder(PINNED.path);
    });
    expect(result.current.primaryWorkspacePath).toBe(PINNED.path);
  });

  it("resolves the pinned folder for the active landing draft", () => {
    // A draft-backed add of TWO folders needs multi-select on; in the default
    // single-project mode the add would switch the main instead.
    useWorkspaceFoldersStore.setState({ allowMultipleFolders: true });
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    act(() => {
      result.current.addResolvedFolders([FIRST, PINNED]);
    });
    act(() => {
      result.current.setPrimaryFolder(PINNED.path);
    });

    expect(result.current.folders).toEqual([FIRST.path, PINNED.path]);
    expect(result.current.primaryWorkspacePath).toBe(PINNED.path);
  });

  it("falls back to the first folder when the pin names a removed folder", () => {
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      draftId: null,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    act(() => {
      result.current.addResolvedFolders([FIRST, PINNED]);
    });
    act(() => {
      result.current.setPrimaryFolder(PINNED.path);
    });
    act(() => {
      result.current.removeFolder(PINNED.path);
    });

    expect(result.current.primaryWorkspacePath).toBe(FIRST.path);
  });
});
