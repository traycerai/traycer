import { describe, expect, it } from "vitest";
import {
  folderMatchesWorkspace,
  isPathUnderFolder,
  itemVisibleInProfile,
  profileOwnsEpic,
  profileOwnsWorkspaceRefs,
} from "../profile-membership";
import type { ProjectProfile } from "../types";

const fixtureProfile: ProjectProfile = {
  id: "p1",
  name: "Acme",
  icon: "rocket",
  color: "blue",
  folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
  assignedEpicIds: [],
  createdAt: 0,
  updatedAt: 0,
};

const otherProfile: ProjectProfile = {
  id: "p2",
  name: "Buzz",
  icon: "zap",
  color: "orange",
  folders: [{ path: "/Users/x/Buzz", hostId: "h1" }],
  assignedEpicIds: [],
  createdAt: 0,
  updatedAt: 0,
};

const allProfiles = [fixtureProfile, otherProfile];

describe("isPathUnderFolder", () => {
  it("matches exact path", () => {
    expect(isPathUnderFolder("/Users/x/Acme", "/Users/x/Acme")).toBe(true);
  });

  it("matches child path", () => {
    expect(isPathUnderFolder("/Users/x/Acme/src", "/Users/x/Acme")).toBe(true);
  });

  it("rejects sibling with shared prefix", () => {
    expect(isPathUnderFolder("/a/foobar", "/a/foo")).toBe(false);
  });

  it("matches when folder has trailing slash", () => {
    expect(isPathUnderFolder("/Users/x/Acme/src", "/Users/x/Acme/")).toBe(true);
  });

  it("root folder matches everything", () => {
    expect(isPathUnderFolder("/any/path", "/")).toBe(true);
  });
});

describe("folderMatchesWorkspace", () => {
  it("rejects hostId mismatch", () => {
    expect(
      folderMatchesWorkspace(
        { path: "/Users/x/Acme", hostId: "h1" },
        { hostId: "h2", workspacePath: "/Users/x/Acme" },
      ),
    ).toBe(false);
  });

  it("matches any host when folder hostId is null", () => {
    expect(
      folderMatchesWorkspace(
        { path: "/Users/x/Acme", hostId: null },
        { hostId: "h-any", workspacePath: "/Users/x/Acme/src" },
      ),
    ).toBe(true);
  });

  it("matches when hostId is equal", () => {
    expect(
      folderMatchesWorkspace(
        { path: "/Users/x/Acme", hostId: "h1" },
        { hostId: "h1", workspacePath: "/Users/x/Acme" },
      ),
    ).toBe(true);
  });
});

describe("profileOwnsWorkspaceRefs", () => {
  const multiFolder: ProjectProfile = {
    ...fixtureProfile,
    folders: [
      { path: "/Users/x/Acme", hostId: "h1" },
      { path: "/Users/x/Other", hostId: "h1" },
    ],
  };

  it("matches when any linked workspace is under any profile folder", () => {
    expect(
      profileOwnsWorkspaceRefs(multiFolder, [
        { hostId: "h1", workspacePath: "/Users/x/Other/pkg" },
      ]),
    ).toBe(true);
  });

  it("matches multi-workspace items if any workspace is owned", () => {
    expect(
      profileOwnsWorkspaceRefs(fixtureProfile, [
        { hostId: "h1", workspacePath: "/Users/x/Foreign" },
        { hostId: "h1", workspacePath: "/Users/x/Acme/app" },
      ]),
    ).toBe(true);
  });

  it("returns false when no workspace matches", () => {
    expect(
      profileOwnsWorkspaceRefs(fixtureProfile, [
        { hostId: "h1", workspacePath: "/Users/x/Foreign" },
      ]),
    ).toBe(false);
  });
});

describe("itemVisibleInProfile", () => {
  it("returns true for empty workspaces (unscoped / fail-open)", () => {
    expect(itemVisibleInProfile(fixtureProfile, [], "e1", allProfiles)).toBe(
      true,
    );
  });

  it("returns true for owned workspaces", () => {
    expect(
      itemVisibleInProfile(
        fixtureProfile,
        [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
        "e1",
        allProfiles,
      ),
    ).toBe(true);
  });

  it("returns false for foreign workspaces", () => {
    expect(
      itemVisibleInProfile(
        fixtureProfile,
        [{ hostId: "h1", workspacePath: "/Users/x/Foreign" }],
        "e1",
        allProfiles,
      ),
    ).toBe(false);
  });

  it("shows an epic assigned to this profile even when foreign/unscoped", () => {
    const assigned = { ...fixtureProfile, assignedEpicIds: ["e9"] };
    expect(
      itemVisibleInProfile(assigned, [], "e9", [assigned, otherProfile]),
    ).toBe(true);
  });

  it("hides an epic assigned to another profile, even when unscoped", () => {
    const other = { ...otherProfile, assignedEpicIds: ["e9"] };
    expect(
      itemVisibleInProfile(fixtureProfile, [], "e9", [fixtureProfile, other]),
    ).toBe(false);
  });
});

describe("profileOwnsEpic", () => {
  it("owns via folder match", () => {
    expect(
      profileOwnsEpic(fixtureProfile, "e1", [
        { hostId: "h1", workspacePath: "/Users/x/Acme" },
      ]),
    ).toBe(true);
  });

  it("owns via assignment even with no workspace match", () => {
    const assigned = { ...fixtureProfile, assignedEpicIds: ["e1"] };
    expect(profileOwnsEpic(assigned, "e1", [])).toBe(true);
  });

  it("does not own when neither folder nor assignment matches", () => {
    expect(
      profileOwnsEpic(fixtureProfile, "e1", [
        { hostId: "h1", workspacePath: "/Users/x/Foreign" },
      ]),
    ).toBe(false);
  });
});
