import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useNewConversationModalStore } from "../new-conversation-modal-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

const WORKSPACE_A: WorkspaceFolderInfo = {
  path: "/tmp/workspace-a",
  name: "workspace-a",
  repoIdentifier: null,
  hostId: null,
};
const WORKSPACE_B: WorkspaceFolderInfo = {
  path: "/tmp/workspace-b",
  name: "workspace-b",
  repoIdentifier: null,
  hostId: null,
};

beforeEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useWorkspaceFoldersStore.setState({ byHost: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useWorkspaceFoldersStore.setState({ byHost: {} });
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

    // "Never touches" means the byHost map itself stays empty - not merely
    // that a particular host's bucket reads as empty (which the shared empty
    // bucket would show trivially regardless).
    expect(useWorkspaceFoldersStore.getState().byHost).toEqual({});
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

describe("useNewConversationModalStore setSettings", () => {
  const SETTINGS: ChatRunSettings = {
    harnessId: "claude",
    model: "sonnet",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    identityId: null,
  };

  // The equality key once enumerated fields by hand and omitted these two, so
  // a change to only one of them compared "unchanged" and was discarded.
  it.each([
    ["identityId", { identityId: "identity-1" }],
    ["profileId", { profileId: "work" }],
  ] as const)("keeps a change to only %s", (_field, change) => {
    const epicId = "epic-1";
    const store = useNewConversationModalStore.getState();
    store.setSettings(epicId, SETTINGS);
    store.setSettings(epicId, { ...SETTINGS, ...change });

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
        ?.settings,
    ).toEqual({ ...SETTINGS, ...change });
  });
});
