import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { ProjectProfileSwitcher } from "../project-profile-switcher";

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
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

describe("ProjectProfileSwitcher", () => {
  beforeEach(() => {
    resetStores();
    useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    useProjectProfilesStore.getState().createProfile({
      name: "Bagisto",
      icon: "store",
      color: "green",
      folders: [{ path: "/Users/x/Bagisto", hostId: "h1" }],
    });
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("selects a project and updates the active store", async () => {
    const user = userEvent.setup();
    render(<ProjectProfileSwitcher />);

    await user.click(screen.getByTestId("project-profile-switcher"));
    const profiles = useProjectProfilesStore.getState().profiles;
    await user.click(
      screen.getByTestId(`project-profile-option-${profiles[0].id}`),
    );

    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(
      profiles[0].id,
    );
  });

  it("returns to All projects when selected", async () => {
    const user = userEvent.setup();
    const profiles = useProjectProfilesStore.getState().profiles;
    useActiveProjectProfileStore.getState().setActiveProfile(profiles[0].id);

    render(<ProjectProfileSwitcher />);
    await user.click(screen.getByTestId("project-profile-switcher"));
    await user.click(screen.getByTestId("project-profile-option-all"));

    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(null);
  });

  it("opens the create dialog from New project…", async () => {
    const user = userEvent.setup();
    render(<ProjectProfileSwitcher />);

    await user.click(screen.getByTestId("project-profile-switcher"));
    await user.click(screen.getByTestId("project-profile-option-new"));

    await waitFor(() => {
      expect(screen.getByTestId("project-profile-dialog")).toBeTruthy();
    });
    expect(screen.getByText("New project")).toBeTruthy();
  });
});
