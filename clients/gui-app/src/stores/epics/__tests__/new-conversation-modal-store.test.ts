import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useNewConversationModalStore } from "../new-conversation-modal-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

const WORKSPACE_A: WorkspaceFolderInfo = {
  path: "/tmp/workspace-a",
  name: "workspace-a",
  repoIdentifier: null,
};
const WORKSPACE_B: WorkspaceFolderInfo = {
  path: "/tmp/workspace-b",
  name: "workspace-b",
  repoIdentifier: null,
};

beforeEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

describe("useNewConversationModalStore setPrimaryFolder", () => {
  it("sets primary on the modal's own draft patch, seeded from the given seed workspace", () => {
    const epicId = "epic-1";
    const seed = {
      ...emptyLandingDraftWorkspaceSnapshot(),
      folders: [WORKSPACE_A.path, WORKSPACE_B.path],
      folderInfoByPath: {
        [WORKSPACE_A.path]: WORKSPACE_A,
        [WORKSPACE_B.path]: WORKSPACE_B,
      },
    };

    useNewConversationModalStore
      .getState()
      .setPrimaryFolder(epicId, seed, WORKSPACE_B.path);

    const patch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    expect(patch?.workspace?.primaryPath).toBe(WORKSPACE_B.path);
  });

  it("is isolated per epic - setting primary for one epic's draft doesn't affect another's", () => {
    const seed = {
      ...emptyLandingDraftWorkspaceSnapshot(),
      folders: [WORKSPACE_A.path, WORKSPACE_B.path],
      folderInfoByPath: {
        [WORKSPACE_A.path]: WORKSPACE_A,
        [WORKSPACE_B.path]: WORKSPACE_B,
      },
    };

    useNewConversationModalStore
      .getState()
      .setPrimaryFolder("epic-1", seed, WORKSPACE_B.path);

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-2"],
    ).toBeUndefined();
  });

  it("never touches the global workspace store or any landing draft (full modal isolation)", () => {
    const seed = {
      ...emptyLandingDraftWorkspaceSnapshot(),
      folders: [WORKSPACE_A.path, WORKSPACE_B.path],
      folderInfoByPath: {
        [WORKSPACE_A.path]: WORKSPACE_A,
        [WORKSPACE_B.path]: WORKSPACE_B,
      },
    };
    const draftId = useLandingDraftStore.getState().createDraft(null);

    useNewConversationModalStore
      .getState()
      .setPrimaryFolder("epic-1", seed, WORKSPACE_B.path);

    expect(useWorkspaceFoldersStore.getState().primaryPath).toBeNull();
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === draftId)
        ?.workspace.primaryPath,
    ).toBeNull();
  });

  it("is a no-op for a folder outside the seeded/current workspace", () => {
    const epicId = "epic-1";
    const seed = {
      ...emptyLandingDraftWorkspaceSnapshot(),
      folders: [WORKSPACE_A.path],
      folderInfoByPath: { [WORKSPACE_A.path]: WORKSPACE_A },
    };

    useNewConversationModalStore
      .getState()
      .setPrimaryFolder(epicId, seed, "/not-in-workspace");

    const patch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    // No entry (or workspace field) was written at all since the target
    // folder isn't a member.
    expect(patch?.workspace?.primaryPath ?? null).toBeNull();
  });
});
