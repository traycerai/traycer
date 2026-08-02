import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHomeWorkspaceSource } from "../use-home-workspace-source";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";

function folder(name: string): WorkspaceFolderInfo {
  return { path: `/tmp/${name}`, name, repoIdentifier: null };
}

const ALPHA = folder("alpha");
const BETA = folder("beta");
const GAMMA = folder("gamma");

function resetStores(): void {
  window.localStorage.clear();
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
    pinnedPath: null,
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

function seedSavedProjects(): void {
  useWorkspaceFoldersStore.setState({
    folders: [ALPHA.path, BETA.path, GAMMA.path],
    folderInfoByPath: {
      [ALPHA.path]: ALPHA,
      [BETA.path]: BETA,
      [GAMMA.path]: GAMMA,
    },
    primaryPath: ALPHA.path,
    pinnedPath: ALPHA.path,
  });
}

function draftWorkspaceOf(draftId: string) {
  return useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId)?.workspace;
}

describe("useHomeWorkspaceSource - saved-list selection", () => {
  it("selectFolder adds a SAVED project to the draft only; the saved list is untouched", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    // A new draft seeds with the pinned default only.
    expect(result.current.folders).toEqual([ALPHA.path]);
    expect(result.current.canToggleSelection).toBe(true);

    act(() => {
      result.current.selectFolder(BETA.path);
    });

    expect(draftWorkspaceOf(draftId)?.folders).toEqual([ALPHA.path, BETA.path]);
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      ALPHA.path,
      BETA.path,
      GAMMA.path,
    ]);
  });

  it("deselectFolder removes from the draft only and keeps the project saved", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    act(() => {
      result.current.selectFolder(BETA.path);
    });

    act(() => {
      result.current.deselectFolder(ALPHA.path);
    });

    expect(draftWorkspaceOf(draftId)?.folders).toEqual([BETA.path]);
    // The saved list AND the pin are untouched by a per-chat deselect.
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      ALPHA.path,
      BETA.path,
      GAMMA.path,
    ]);
    expect(useWorkspaceFoldersStore.getState().pinnedPath).toBe(ALPHA.path);
  });

  it("deselecting the primary reports the reassignment for the live region", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    act(() => {
      result.current.selectFolder(BETA.path);
    });

    let transition: {
      primaryChanged: boolean;
      newPrimaryName: string | null;
    } = { primaryChanged: false, newPrimaryName: null };
    act(() => {
      transition = result.current.deselectFolder(ALPHA.path);
    });

    expect(transition.primaryChanged).toBe(true);
    expect(transition.newPrimaryName).toBe(BETA.name);
  });

  it("removeFolder deletes from the saved list AND the draft selection", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    act(() => {
      result.current.removeFolder(ALPHA.path);
    });

    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      BETA.path,
      GAMMA.path,
    ]);
    expect(draftWorkspaceOf(draftId)?.folders).toEqual([]);
  });

  it("setPinnedFolder writes the global default without touching the draft selection", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    act(() => {
      result.current.setPinnedFolder(GAMMA.path);
    });

    expect(useWorkspaceFoldersStore.getState().pinnedPath).toBe(GAMMA.path);
    expect(draftWorkspaceOf(draftId)?.folders).toEqual([ALPHA.path]);
  });

  it("switchMainFolder swaps the main in one action, keeping additional folders", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    // Main: alpha (pinned seed) + beta checked as additional.
    act(() => {
      result.current.selectFolder(BETA.path);
    });

    act(() => {
      result.current.switchMainFolder(GAMMA.path);
    });

    const workspace = draftWorkspaceOf(draftId);
    // Old main (alpha) left the chat; the additional folder (beta) stayed;
    // gamma is the new main.
    expect(workspace?.folders).toEqual([BETA.path, GAMMA.path]);
    expect(workspace?.primaryPath).toBe(GAMMA.path);
    // The saved list and pin are untouched by a per-chat switch.
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      ALPHA.path,
      BETA.path,
      GAMMA.path,
    ]);
    expect(useWorkspaceFoldersStore.getState().pinnedPath).toBe(ALPHA.path);
  });

  it("switchMainFolder promotes an additional folder without duplicating it", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    act(() => {
      result.current.selectFolder(BETA.path);
    });

    act(() => {
      result.current.switchMainFolder(BETA.path);
    });

    const workspace = draftWorkspaceOf(draftId);
    expect(workspace?.folders).toEqual([BETA.path]);
    expect(workspace?.primaryPath).toBe(BETA.path);
  });

  it("switchMainFolder on the blank landing writes the pending snapshot a new draft consumes", () => {
    seedSavedProjects();
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      draftId: null,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    // Untouched blank landing shows what a fresh draft would start from.
    expect(result.current.folders).toEqual([ALPHA.path]);
    expect(result.current.canToggleSelection).toBe(true);

    act(() => {
      result.current.switchMainFolder(GAMMA.path);
    });

    expect(result.current.folders).toEqual([GAMMA.path]);
    expect(result.current.primaryWorkspacePath).toBe(GAMMA.path);
    // The saved list and pin are untouched by the pre-typing switch...
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      ALPHA.path,
      BETA.path,
      GAMMA.path,
    ]);
    expect(useWorkspaceFoldersStore.getState().pinnedPath).toBe(ALPHA.path);

    // A pre-typing Branch pick stages under the null landing key.
    act(() => {
      result.current.stageEntry({
        kind: "worktree",
        scripts: null,
        workspacePath: GAMMA.path,
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/pre-typing-pick",
          source: "main",
          carryUncommittedChanges: false,
        },
      });
    });

    // ...and the first substantive edit mints a draft that KEEPS the switch
    // (the original bug discarded it and re-seeded from the pin).
    let draftId = "";
    act(() => {
      draftId = useLandingDraftStore.getState().createDraftWithId("d1", null);
    });
    expect(draftWorkspaceOf(draftId)?.folders).toEqual([GAMMA.path]);
    expect(draftWorkspaceOf(draftId)?.primaryPath).toBe(GAMMA.path);
    expect(useLandingDraftStore.getState().pendingWorkspace).toBeNull();
    // The staged pick follows the pending workspace to the minted draft's
    // own staging slot instead of being orphaned under the null key.
    const staged = useWorktreeIntentStagingStore.getState().intentByKey;
    expect(staged["landing:"]).toBeUndefined();
    expect(staged["landing:d1"]?.entries).toHaveLength(1);
    expect(staged["landing:d1"]?.entries[0]).toMatchObject({
      workspacePath: GAMMA.path,
      branch: { name: "traycer/pre-typing-pick" },
    });
  });

  it("adding on the blank landing in single-project mode survives the draft mint", () => {
    seedSavedProjects();
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      draftId: null,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    const delta = folder("delta");

    // Default: allowMultipleFolders is off - the add becomes the new main.
    act(() => {
      result.current.addResolvedFolders([delta]);
    });

    expect(result.current.folders).toEqual([delta.path]);
    expect(result.current.primaryWorkspacePath).toBe(delta.path);
    // The add SAVED the project globally.
    expect(useWorkspaceFoldersStore.getState().folders).toContain(delta.path);

    let draftId = "";
    act(() => {
      draftId = useLandingDraftStore.getState().createDraftWithId("d1", null);
    });
    expect(draftWorkspaceOf(draftId)?.folders).toEqual([delta.path]);
    expect(draftWorkspaceOf(draftId)?.primaryPath).toBe(delta.path);
  });

  it("addResolvedFolders in single-project mode saves the folder and switches the main to it", () => {
    seedSavedProjects();
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    const delta = folder("delta");

    // Default: allowMultipleFolders is off.
    act(() => {
      result.current.addResolvedFolders([delta]);
    });

    const workspace = draftWorkspaceOf(draftId);
    // The chat holds exactly the added folder (old main alpha left)...
    expect(workspace?.folders).toEqual([delta.path]);
    expect(workspace?.primaryPath).toBe(delta.path);
    // ...and the folder was still saved to the global list.
    expect(useWorkspaceFoldersStore.getState().folders).toContain(delta.path);
    expect(useWorkspaceFoldersStore.getState().folders).toContain(ALPHA.path);
  });

  it("addResolvedFolders with multi-select on keeps the existing selection and appends", () => {
    seedSavedProjects();
    useWorkspaceFoldersStore.setState({ allowMultipleFolders: true });
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const stagingKey: WorktreeStagingKey = { surface: "landing", draftId };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );
    const delta = folder("delta");

    act(() => {
      result.current.addResolvedFolders([delta]);
    });

    const workspace = draftWorkspaceOf(draftId);
    expect(workspace?.folders).toEqual([ALPHA.path, delta.path]);
    expect(workspace?.primaryPath).toBe(ALPHA.path);
  });

  it("disables selection toggles in the global-fallback representation", () => {
    seedSavedProjects();
    // A modal key with no patch and no seed is the remaining true fallback
    // (the blank landing now edits the pending snapshot instead).
    const stagingKey: WorktreeStagingKey = {
      surface: "new-conversation",
      epicId: "epic-1",
      parentId: null,
    };
    const { result } = renderHook(() =>
      useHomeWorkspaceSource(stagingKey, null),
    );

    expect(result.current.canToggleSelection).toBe(false);

    act(() => {
      result.current.deselectFolder(BETA.path);
    });
    // A fallback deselect must never destroy a saved project.
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      ALPHA.path,
      BETA.path,
      GAMMA.path,
    ]);
  });
});
