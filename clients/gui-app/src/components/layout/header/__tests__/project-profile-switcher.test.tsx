import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProfileSwitcher } from "@/components/layout/header/project-profile-switcher";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => HOST,
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
});
