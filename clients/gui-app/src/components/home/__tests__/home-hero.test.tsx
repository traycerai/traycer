import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HomeHero } from "@/components/home/home-hero";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

// `HomeHero` resolves its global-folder fallback through the active host's
// bucket (`useReactiveActiveHostId()`), which needs a `<HostRuntimeProvider>`
// this bare-render suite doesn't set up. Pin it to a fixed host id so the
// tests below can seed/assert that host's bucket directly.
const TEST_HOST_ID = "host-a";
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => TEST_HOST_ID,
}));

function setGlobalFolders(folders: ReadonlyArray<string>): void {
  useWorkspaceFoldersStore.setState({
    byHost: {
      [TEST_HOST_ID]: {
        folders,
        folderInfoByPath: {},
        primaryPath: null,
      },
    },
  });
}

describe("<HomeHero />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceFoldersStore.setState({ byHost: {} });
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

    render(<HomeHero workspaceFolders={null} />);

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

    render(<HomeHero workspaceFolders={null} />);

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

    render(<HomeHero workspaceFolders={null} />);

    expect(screen.getByRole("heading").textContent).not.toContain(",");
  });

  it("keeps the generic greeting when no profile is available", () => {
    render(<HomeHero workspaceFolders={null} />);

    expect(screen.getByRole("heading").textContent).not.toContain(",");
  });

  it("uses draft workspace folders over global folders", () => {
    setGlobalFolders(["/tmp/global-app"]);

    render(<HomeHero workspaceFolders={["/tmp/draft-app"]} />);

    expect(screen.getByText("draft-app")).toBeTruthy();
    expect(screen.queryByText("global-app")).toBeNull();
  });

  it("does not fall back to global folders for an explicit empty draft workspace", () => {
    setGlobalFolders(["/tmp/global-app"]);

    render(<HomeHero workspaceFolders={[]} />);

    expect(screen.queryByText("global-app")).toBeNull();
  });
});
