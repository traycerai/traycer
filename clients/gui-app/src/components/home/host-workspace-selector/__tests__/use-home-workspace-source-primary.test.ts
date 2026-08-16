import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHomeWorkspaceSource } from "../use-home-workspace-source";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

const TEST_HOST_ID = "host-a";

// Stamped with the host the hook targets: the store files a folder only in
// the bucket of the host it was actually prepared on, so an unstamped fixture
// would be silently dropped (and would not resemble anything the picker
// produces).
const FIRST: WorkspaceFolderInfo = {
  path: "/tmp/first-repo",
  name: "first-repo",
  repoIdentifier: null,
  hostId: TEST_HOST_ID,
};
const PINNED: WorkspaceFolderInfo = {
  path: "/tmp/pinned-repo",
  name: "pinned-repo",
  repoIdentifier: null,
  hostId: TEST_HOST_ID,
};

function resetStores(): void {
  useWorkspaceFoldersStore.setState({ byHost: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
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
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null, TEST_HOST_ID),
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
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: TEST_HOST_ID,
      draftId,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null, TEST_HOST_ID),
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
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null, TEST_HOST_ID),
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
