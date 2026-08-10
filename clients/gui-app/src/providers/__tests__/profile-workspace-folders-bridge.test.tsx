import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ProjectProfile } from "@/lib/profiles/types";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { ProfileWorkspaceFoldersBridge } from "../profile-workspace-folders-bridge";

const mockUseActiveProjectProfile = vi.hoisted(() =>
  vi.fn((): ProjectProfile | null => null),
);
const mockUseReactiveActiveHostId = vi.hoisted(() =>
  vi.fn((): string | null => "h1"),
);

vi.mock("@/lib/profiles/use-active-project-profile", () => ({
  useActiveProjectProfile: () => mockUseActiveProjectProfile(),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mockUseReactiveActiveHostId(),
}));

function makeProfile(
  id: string,
  folders: ProjectProfile["folders"],
): ProjectProfile {
  return {
    id,
    name: id,
    icon: "rocket",
    color: "blue",
    folders,
    assignedEpicIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function folderInfo(path: string, hostId: string | null = null) {
  return {
    path,
    name: path.split("/").pop() ?? path,
    repoIdentifier: null as null,
    hostId,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
  mockUseActiveProjectProfile.mockReturnValue(null);
  mockUseReactiveActiveHostId.mockReturnValue("h1");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProfileWorkspaceFoldersBridge", () => {
  it("replaces the store with usable profile folders (drops foreign host)", () => {
    const profile = makeProfile("p1", [
      { path: "/Users/x/Acme", hostId: "h1" },
      { path: "/Users/x/OtherHost", hostId: "h2" },
      { path: "/Users/x/Shared", hostId: null },
    ]);
    mockUseActiveProjectProfile.mockReturnValue(profile);

    render(<ProfileWorkspaceFoldersBridge />);

    const state = useWorkspaceFoldersStore.getState();
    expect(state.folders).toEqual(["/Users/x/Acme", "/Users/x/Shared"]);
    expect(state.primaryPath).toBe("/Users/x/Acme");
    expect(state.folderInfoByPath["/Users/x/OtherHost"]).toBeUndefined();
    expect(state.folderInfoByPath["/Users/x/Acme"]?.hostId).toBe("h1");
    expect(state.folderInfoByPath["/Users/x/Shared"]?.hostId).toBeNull();
  });

  it("does not touch the store when the active profile is null", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([folderInfo("/last-used")]);
    mockUseActiveProjectProfile.mockReturnValue(null);

    render(<ProfileWorkspaceFoldersBridge />);

    const state = useWorkspaceFoldersStore.getState();
    expect(state.folders).toEqual(["/last-used"]);
    expect(state.primaryPath).toBe("/last-used");
  });

  it("does not touch the store when the profile has no usable folders", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([folderInfo("/last-used")]);
    mockUseActiveProjectProfile.mockReturnValue(
      makeProfile("empty-or-foreign", [
        { path: "/Users/x/OnlyOnH2", hostId: "h2" },
      ]),
    );
    mockUseReactiveActiveHostId.mockReturnValue("h1");

    render(<ProfileWorkspaceFoldersBridge />);

    const state = useWorkspaceFoldersStore.getState();
    expect(state.folders).toEqual(["/last-used"]);
  });

  it("does not re-apply on same-profile re-render after user edits the store", () => {
    const profile = makeProfile("p1", [
      { path: "/Users/x/Acme", hostId: "h1" },
    ]);
    mockUseActiveProjectProfile.mockReturnValue(profile);

    const { rerender } = render(<ProfileWorkspaceFoldersBridge />);
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      "/Users/x/Acme",
    ]);

    // User hand-edits folders within the same profile session.
    useWorkspaceFoldersStore
      .getState()
      .replaceResolvedFolders([
        folderInfo("/Users/x/Acme", "h1"),
        folderInfo("/Users/x/Extra", "h1"),
      ]);
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      "/Users/x/Acme",
      "/Users/x/Extra",
    ]);

    // Same profile + host re-render must leave the user edit alone.
    rerender(<ProfileWorkspaceFoldersBridge />);
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      "/Users/x/Acme",
      "/Users/x/Extra",
    ]);
  });

  it("re-applies when the active profile id changes", () => {
    const p1 = makeProfile("p1", [{ path: "/a", hostId: "h1" }]);
    const p2 = makeProfile("p2", [{ path: "/b", hostId: "h1" }]);
    mockUseActiveProjectProfile.mockReturnValue(p1);

    const { rerender } = render(<ProfileWorkspaceFoldersBridge />);
    expect(useWorkspaceFoldersStore.getState().folders).toEqual(["/a"]);

    mockUseActiveProjectProfile.mockReturnValue(p2);
    rerender(<ProfileWorkspaceFoldersBridge />);
    expect(useWorkspaceFoldersStore.getState().folders).toEqual(["/b"]);
    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/b");
  });
});
