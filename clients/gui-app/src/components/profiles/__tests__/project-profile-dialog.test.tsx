import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectProfile } from "@/lib/profiles/types";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { ProjectProfileDialog } from "../project-profile-dialog";

const pickAndPrepareFolders = vi.fn();

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders,
    isPreparing: false,
    isRemoving: false,
    prepareFoldersMutation: {},
    removeEpicRepoMutation: {},
  }),
}));

function resetStores(): void {
  useProjectProfilesStore.getState().resetForTests();
  useActiveProjectProfileStore.getState().resetForTests();
}

const existingProfile: ProjectProfile = {
  id: "p-edit",
  name: "Existing",
  icon: "rocket",
  color: "red",
  folders: [{ path: "/Users/x/Existing", hostId: "h1" }],
  assignedEpicIds: [],
  createdAt: 1,
  updatedAt: 1,
};

describe("ProjectProfileDialog", () => {
  beforeEach(() => {
    resetStores();
    pickAndPrepareFolders.mockReset();
    pickAndPrepareFolders.mockResolvedValue({
      folders: [
        {
          workspacePath: "/Users/x/Acme",
          workspaceName: "Acme",
          repoIdentifier: null,
          repoUrl: null,
        },
      ],
      repoIdentifiers: [],
      hostId: "h1",
    });
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("renders create mode with submit disabled until name and folder", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <ProjectProfileDialog
        open
        onOpenChange={onOpenChange}
        editing={null}
      />,
    );

    expect(screen.getByText("New project")).toBeTruthy();
    const submit = screen.getByTestId(
      "project-profile-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await user.type(screen.getByTestId("project-profile-name"), "Acme");
    expect(submit.disabled).toBe(true);

    await user.click(screen.getByTestId("project-profile-add-folder"));
    await waitFor(() => {
      expect(screen.getByText("/Users/x/Acme")).toBeTruthy();
    });
    expect(submit.disabled).toBe(false);
  });

  it("creates a profile, activates it, and closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <ProjectProfileDialog
        open
        onOpenChange={onOpenChange}
        editing={null}
      />,
    );

    await user.type(screen.getByTestId("project-profile-name"), "Acme");
    await user.click(screen.getByTestId("project-profile-add-folder"));
    await waitFor(() => {
      expect(screen.getByText("/Users/x/Acme")).toBeTruthy();
    });
    await user.click(screen.getByTestId("project-profile-submit"));

    const profiles = useProjectProfilesStore.getState().profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("Acme");
    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(
      profiles[0].id,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("pre-fills edit mode and updates the profile", async () => {
    const user = userEvent.setup();
    useProjectProfilesStore.setState({ profiles: [existingProfile] });
    const onOpenChange = vi.fn();

    render(
      <ProjectProfileDialog
        open
        onOpenChange={onOpenChange}
        editing={existingProfile}
      />,
    );

    expect(screen.getByText("Edit project")).toBeTruthy();
    const nameInput = screen.getByTestId(
      "project-profile-name",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Existing");
    expect(screen.getByText("/Users/x/Existing")).toBeTruthy();

    await user.clear(nameInput);
    await user.type(nameInput, "Renamed");
    await user.click(screen.getByTestId("project-profile-submit"));

    const updated = useProjectProfilesStore.getState().profiles[0];
    expect(updated.name).toBe("Renamed");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("delete flow clears active id when deleting the active project", async () => {
    const user = userEvent.setup();
    useProjectProfilesStore.setState({ profiles: [existingProfile] });
    useActiveProjectProfileStore
      .getState()
      .setActiveProfile(existingProfile.id);
    const onOpenChange = vi.fn();

    render(
      <ProjectProfileDialog
        open
        onOpenChange={onOpenChange}
        editing={existingProfile}
      />,
    );

    await user.click(screen.getByTestId("project-profile-delete"));
    expect(screen.getByTestId("project-profile-delete-confirm")).toBeTruthy();
    await user.click(screen.getByTestId("project-profile-delete-confirm-button"));

    expect(useProjectProfilesStore.getState().profiles).toEqual([]);
    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(null);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
