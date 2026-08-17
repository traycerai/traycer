import { describe, expect, it } from "vitest";
import { folderSeedForNewProfile } from "../project-profile-seed";
import type { WorkspaceFoldersHostBucket } from "@/stores/workspace/workspace-folders-store";

const CATALOG: WorkspaceFoldersHostBucket = {
  folders: ["/titanos", "/crm", "/bkza"],
  folderInfoByPath: {},
  primaryPath: "/titanos",
};

describe("folderSeedForNewProfile", () => {
  it("defaults isolation to the primary folder only", () => {
    expect(folderSeedForNewProfile(CATALOG, "primary")).toEqual({
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
  });

  it("can copy the full current workspace for a true multi-repo project", () => {
    expect(folderSeedForNewProfile(CATALOG, "all")).toEqual({
      folderPaths: ["/titanos", "/crm", "/bkza"],
      primaryPath: "/titanos",
    });
  });

  it("can start empty", () => {
    expect(folderSeedForNewProfile(CATALOG, "empty")).toEqual({
      folderPaths: [],
      primaryPath: null,
    });
  });
});
