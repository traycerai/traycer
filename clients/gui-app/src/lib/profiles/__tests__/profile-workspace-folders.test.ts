import { describe, expect, it } from "vitest";
import {
  profileFoldersForHost,
  profileHasUsableFolders,
} from "../profile-workspace-folders";
import type { ProjectProfile } from "../types";

function makeProfile(
  folders: ProjectProfile["folders"],
): ProjectProfile {
  return {
    id: "p1",
    name: "Test",
    icon: "rocket",
    color: "blue",
    folders,
    assignedEpicIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("profileFoldersForHost", () => {
  it("keeps null-hostId folders on any host", () => {
    const profile = makeProfile([
      { path: "/a", hostId: null },
    ]);
    expect(profileFoldersForHost(profile, "host-x")).toEqual([
      { path: "/a", hostId: null },
    ]);
    expect(profileFoldersForHost(profile, null)).toEqual([
      { path: "/a", hostId: null },
    ]);
  });

  it("keeps folders whose hostId matches the active host", () => {
    const profile = makeProfile([
      { path: "/a", hostId: "h1" },
    ]);
    expect(profileFoldersForHost(profile, "h1")).toEqual([
      { path: "/a", hostId: "h1" },
    ]);
  });

  it("drops folders with a foreign hostId", () => {
    const profile = makeProfile([
      { path: "/a", hostId: "h1" },
    ]);
    expect(profileFoldersForHost(profile, "h2")).toEqual([]);
    expect(profileFoldersForHost(profile, null)).toEqual([]);
  });

  it("keeps mixed list order (profile.folders order)", () => {
    const profile = makeProfile([
      { path: "/a", hostId: null },
      { path: "/b", hostId: "h1" },
      { path: "/c", hostId: "h2" },
      { path: "/d", hostId: "h1" },
    ]);
    expect(profileFoldersForHost(profile, "h1")).toEqual([
      { path: "/a", hostId: null },
      { path: "/b", hostId: "h1" },
      { path: "/d", hostId: "h1" },
    ]);
  });
});

describe("profileHasUsableFolders", () => {
  it("returns false when the profile has no folders", () => {
    const profile = makeProfile([]);
    expect(profileHasUsableFolders(profile, "h1")).toBe(false);
  });

  it("returns false when all folders are foreign to the host", () => {
    const profile = makeProfile([
      { path: "/a", hostId: "h1" },
    ]);
    expect(profileHasUsableFolders(profile, "h2")).toBe(false);
  });

  it("returns true when at least one folder is usable", () => {
    const profile = makeProfile([
      { path: "/a", hostId: "h1" },
      { path: "/b", hostId: null },
    ]);
    expect(profileHasUsableFolders(profile, "h2")).toBe(true);
  });
});
