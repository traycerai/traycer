import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createProjectFromPickedFolders } from "../use-pick-and-add-folders";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

const HOST = "host-a";

describe("createProjectFromPickedFolders", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useWorkspaceFoldersStore.setState({ byHost: {} });
  });
  afterEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useWorkspaceFoldersStore.setState({ byHost: {} });
  });

  it("creates and activates a project named after the folder", () => {
    useWorkspaceFoldersStore.getState().addResolvedFolders(HOST, [
      {
        path: "/Users/g/Titanos",
        name: "Titanos",
        repoIdentifier: null,
        hostId: HOST,
      },
    ]);
    expect(
      createProjectFromPickedFolders({
        hostId: HOST,
        folders: [
          {
            path: "/Users/g/Titanos",
            name: "Titanos",
            repoIdentifier: null,
            hostId: HOST,
          },
        ],
      }),
    ).toBe(true);
    const bucket = useProjectProfilesStore.getState().byHost[HOST];
    expect(bucket.profiles[0].name).toBe("Titanos");
    expect(bucket.profiles[0].folderPaths).toEqual(["/Users/g/Titanos"]);
    expect(bucket.activeProfileId).toBe(bucket.profiles[0].id);
  });
});
