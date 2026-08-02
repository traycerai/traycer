import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HomeHero } from "@/components/home/home-hero";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

describe("<HomeHero />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceFoldersStore.setState({ folders: [] });
    useLandingDraftStore.setState({ pendingWorkspace: null });
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceFoldersStore.setState({ folders: [] });
    useLandingDraftStore.setState({ pendingWorkspace: null });
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  it("greets the signed-in user by first name from userName", () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "test-user",
        userName: "Ada Lovelace",
        email: "ada@example.com",
      },
      contextMetadata: { userId: "test-user", username: "Ada Lovelace" },
    });

    render(<HomeHero workspaceFolders={null} workspacePrimaryPath={null} />);

    expect(screen.getByRole("heading").textContent).toMatch(/, Ada$/);
  });

  it("keeps the generic greeting when userName is unavailable", () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "test-user",
        userName: "",
        email: "grace.hopper@example.com",
      },
      contextMetadata: {
        userId: "test-user",
        username: "grace.hopper@example.com",
      },
    });

    render(<HomeHero workspaceFolders={null} workspacePrimaryPath={null} />);

    expect(screen.getByRole("heading").textContent).not.toContain(",");
  });

  it("keeps the generic greeting when userName looks like an email", () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "test-user",
        userName: "grace.hopper@example.com",
        email: "grace.hopper@example.com",
      },
      contextMetadata: {
        userId: "test-user",
        username: "grace.hopper@example.com",
      },
    });

    render(<HomeHero workspaceFolders={null} workspacePrimaryPath={null} />);

    expect(screen.getByRole("heading").textContent).not.toContain(",");
  });

  it("keeps the generic greeting when no profile is available", () => {
    render(<HomeHero workspaceFolders={null} workspacePrimaryPath={null} />);

    expect(screen.getByRole("heading").textContent).not.toContain(",");
  });

  it("uses draft workspace folders over global folders", () => {
    useWorkspaceFoldersStore.setState({ folders: ["/tmp/global-app"] });

    render(
      <HomeHero
        workspaceFolders={["/tmp/draft-app"]}
        workspacePrimaryPath={null}
      />,
    );

    expect(screen.getByText("draft-app")).toBeTruthy();
    expect(screen.queryByText("global-app")).toBeNull();
  });

  it("does not fall back to global folders for an explicit empty draft workspace", () => {
    useWorkspaceFoldersStore.setState({ folders: ["/tmp/global-app"] });

    render(<HomeHero workspaceFolders={[]} workspacePrimaryPath={null} />);

    expect(screen.queryByText("global-app")).toBeNull();
  });

  it("names the draft's MAIN project, not whichever folder is first", () => {
    render(
      <HomeHero
        workspaceFolders={["/tmp/extra-app", "/tmp/main-app"]}
        workspacePrimaryPath="/tmp/main-app"
      />,
    );

    expect(screen.getByText("main-app")).toBeTruthy();
    expect(screen.queryByText("extra-app")).toBeNull();
  });

  it("names the pending blank-landing main over the pinned default", () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/tmp/pinned-app"],
      pinnedPath: "/tmp/pinned-app",
    });
    useLandingDraftStore.setState({
      pendingWorkspace: {
        folders: ["/tmp/switched-app"],
        folderInfoByPath: {},
        primaryPath: "/tmp/switched-app",
      },
    });

    render(<HomeHero workspaceFolders={null} workspacePrimaryPath={null} />);

    expect(screen.getByText("switched-app")).toBeTruthy();
    expect(screen.queryByText("pinned-app")).toBeNull();
  });
});
