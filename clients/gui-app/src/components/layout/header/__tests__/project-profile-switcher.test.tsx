import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProfileSwitcher } from "@/components/layout/header/project-profile-switcher";
import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST,
}));

function mount() {
  render(
    <TooltipProvider>
      <ProjectProfileSwitcher />
    </TooltipProvider>,
  );
}

describe("<ProjectProfileSwitcher />", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });

  afterEach(() => {
    cleanup();
    useProjectProfilesStore.setState({ byHost: {} });
  });

  it("labels the trigger All projects when no profile is active", () => {
    mount();
    expect(
      screen.getByRole("button", { name: "Project: All projects" }),
    ).toBeTruthy();
  });

  it("labels the trigger with the active profile name", () => {
    const id = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectProfilesStore.getState().setActiveProfile(HOST, id);
    mount();
    expect(
      screen.getByRole("button", { name: "Project: Titanos" }),
    ).toBeTruthy();
  });

  it("asks before deleting the active project", () => {
    const id = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectProfilesStore.getState().setActiveProfile(HOST, id);
    mount();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Project: Titanos" }));
    fireEvent.click(screen.getByTestId("project-profile-delete"));
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();
    expect(selectActiveProjectProfile(useProjectProfilesStore.getState(), HOST)?.name).toBe(
      "Titanos",
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(selectActiveProjectProfile(useProjectProfilesStore.getState(), HOST)).toBeNull();
  });
});
