import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHomeWorkspaceSource } from "../use-home-workspace-source";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "@/stores/workspace/workspace-folders-store";
import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";

const HOST = "host-a";

const TITANOS: WorkspaceFolderInfo = {
  path: "/tmp/titanos",
  name: "titanos",
  repoIdentifier: null,
  hostId: HOST,
};
const CRM: WorkspaceFolderInfo = {
  path: "/tmp/crm",
  name: "crm",
  repoIdentifier: null,
  hostId: HOST,
};

const STAGING_KEY: WorktreeStagingKey = {
  surface: "landing",
  hostId: HOST,
  draftId: null,
};

function resetStores(): void {
  useWorkspaceFoldersStore.setState({ byHost: {} });
  useProjectProfilesStore.setState({ byHost: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorktreeIntentStagingStore.getState().resetForTests();
}

describe("useHomeWorkspaceSource picker edits with an active profile", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("add/remove/primary stay on the active project and leave the catalog intact", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST, [TITANOS, CRM]);
    const profileId = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: [TITANOS.path],
      primaryPath: TITANOS.path,
    });
    useProjectProfilesStore.getState().setActiveProfile(HOST, profileId);

    const { result } = renderHook(() =>
      useHomeWorkspaceSource(STAGING_KEY, null, HOST),
    );
    expect(result.current.folders).toEqual([TITANOS.path]);

    act(() => {
      result.current.addResolvedFolders([CRM]);
    });
    expect(result.current.folders).toEqual([TITANOS.path, CRM.path]);
    expect(
      selectActiveProjectProfile(useProjectProfilesStore.getState(), HOST)
        ?.folderPaths,
    ).toEqual([TITANOS.path, CRM.path]);

    act(() => {
      result.current.setPrimaryFolder(CRM.path);
    });
    expect(result.current.primaryWorkspacePath).toBe(CRM.path);
    expect(
      selectActiveProjectProfile(useProjectProfilesStore.getState(), HOST)
        ?.primaryPath,
    ).toBe(CRM.path);
    expect(
      selectWorkspaceFoldersBucket(useWorkspaceFoldersStore.getState(), HOST)
        .primaryPath,
    ).toBe(TITANOS.path);

    act(() => {
      result.current.removeFolder(CRM.path);
    });
    expect(result.current.folders).toEqual([TITANOS.path]);
    expect(
      selectWorkspaceFoldersBucket(useWorkspaceFoldersStore.getState(), HOST)
        .folders,
    ).toEqual([TITANOS.path, CRM.path]);
  });
});
