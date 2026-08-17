import { describe, expect, it } from "vitest";
import { selectEffectiveWorkspaceFoldersBucket } from "../effective-workspace-folders";
import type { WorkspaceFoldersHostBucket } from "@/stores/workspace/workspace-folders-store";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

function folderInfo(path: string) {
  return {
    path,
    name: path.slice(1),
    repoIdentifier: null,
    hostId: HOST,
  };
}

function catalog(
  folders: ReadonlyArray<string>,
  primaryPath: string | null,
): WorkspaceFoldersHostBucket {
  return {
    folders,
    folderInfoByPath: Object.fromEntries(
      folders.map((path) => [path, folderInfo(path)]),
    ),
    primaryPath,
  };
}

function profile(
  overrides: Partial<ProjectProfile> & Pick<ProjectProfile, "folderPaths">,
): ProjectProfile {
  return {
    id: "p1",
    name: "Titanos",
    color: "orange",
    primaryPath: overrides.folderPaths[0] ?? null,
    ...overrides,
  };
}

describe("selectEffectiveWorkspaceFoldersBucket", () => {
  it("returns the full catalog when no profile is active", () => {
    const foldersState = {
      byHost: { [HOST]: catalog(["/titanos", "/crm", "/bkza"], "/titanos") },
    };
    const profilesState = {
      byHost: { [HOST]: { profiles: [], activeProfileId: null } },
    };
    expect(
      selectEffectiveWorkspaceFoldersBucket(foldersState, profilesState, HOST)
        .folders,
    ).toEqual(["/titanos", "/crm", "/bkza"]);
  });

  it("narrows the catalog to the active profile's folders and primary", () => {
    const foldersState = {
      byHost: { [HOST]: catalog(["/titanos", "/crm", "/bkza"], "/crm") },
    };
    const profilesState = {
      byHost: {
        [HOST]: {
          profiles: [
            profile({ folderPaths: ["/titanos"], primaryPath: "/titanos" }),
          ],
          activeProfileId: "p1",
        },
      },
    };
    const effective = selectEffectiveWorkspaceFoldersBucket(
      foldersState,
      profilesState,
      HOST,
    );
    expect(effective.folders).toEqual(["/titanos"]);
    expect(effective.primaryPath).toBe("/titanos");
    expect(Object.keys(effective.folderInfoByPath)).toEqual(["/titanos"]);
  });

  it("drops profile paths that left the catalog instead of inventing folders", () => {
    const foldersState = {
      byHost: { [HOST]: catalog(["/titanos"], "/titanos") },
    };
    const profilesState = {
      byHost: {
        [HOST]: {
          profiles: [
            profile({
              folderPaths: ["/titanos", "/gone"],
              primaryPath: "/gone",
            }),
          ],
          activeProfileId: "p1",
        },
      },
    };
    const effective = selectEffectiveWorkspaceFoldersBucket(
      foldersState,
      profilesState,
      HOST,
    );
    expect(effective.folders).toEqual(["/titanos"]);
    expect(effective.primaryPath).toBe("/titanos");
  });
});
