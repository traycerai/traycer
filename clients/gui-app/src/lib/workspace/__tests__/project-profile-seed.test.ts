import { describe, expect, it } from "vitest";
import { folderSeedForNewProfile } from "../project-profile-seed";
import type { WorkspaceFoldersHostBucket } from "@/stores/workspace/workspace-folders-store";

const CATALOG: WorkspaceFoldersHostBucket = {
  folders: ["/titanos", "/crm", "/bkza"],
  folderInfoByPath: {},
  primaryPath: "/titanos",
};

describe("folderSeedForNewProfile", () => {
  it("uses the folder the user picked as that project's main", () => {
    expect(folderSeedForNewProfile(CATALOG, "folder", "/crm")).toEqual({
      folderPaths: ["/crm"],
      primaryPath: "/crm",
    });
  });

  it("falls back to the catalog primary when no folder is picked", () => {
    expect(folderSeedForNewProfile(CATALOG, "folder", null)).toEqual({
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
  });

  it("ignores a path that is not in the catalog", () => {
    expect(folderSeedForNewProfile(CATALOG, "folder", "/missing")).toEqual({
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
  });

  it("can copy the full current workspace for a true multi-repo project", () => {
    expect(folderSeedForNewProfile(CATALOG, "all", null)).toEqual({
      folderPaths: ["/titanos", "/crm", "/bkza"],
      primaryPath: "/titanos",
    });
  });

  it("can start empty", () => {
    expect(folderSeedForNewProfile(CATALOG, "empty", null)).toEqual({
      folderPaths: [],
      primaryPath: null,
    });
  });
});
