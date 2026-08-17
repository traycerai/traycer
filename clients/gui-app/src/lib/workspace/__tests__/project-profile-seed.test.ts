import { describe, expect, it } from "vitest";
import {
  canConfirmNewProject,
  folderSeedForNewProfile,
} from "../project-profile-seed";
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

  it("does not silently bind the host-wide primary when no folder is picked", () => {
    expect(folderSeedForNewProfile(CATALOG, "folder", null)).toEqual({
      folderPaths: [],
      primaryPath: null,
    });
  });

  it("ignores a path that is not in the catalog", () => {
    expect(folderSeedForNewProfile(CATALOG, "folder", "/missing")).toEqual({
      folderPaths: [],
      primaryPath: null,
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

describe("canConfirmNewProject", () => {
  it("blocks Create until a folder is picked when the seed is folder", () => {
    expect(
      canConfirmNewProject({
        name: "Titanos",
        seed: "folder",
        pickedFolder: null,
      }),
    ).toBe(false);
    expect(
      canConfirmNewProject({
        name: "Titanos",
        seed: "folder",
        pickedFolder: "/titanos",
      }),
    ).toBe(true);
  });

  it("allows All / Empty with only a name", () => {
    expect(
      canConfirmNewProject({
        name: "Multi",
        seed: "all",
        pickedFolder: null,
      }),
    ).toBe(true);
    expect(
      canConfirmNewProject({
        name: "Blank",
        seed: "empty",
        pickedFolder: null,
      }),
    ).toBe(true);
  });
});
