import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_PROJECT_PROFILES_BUCKET,
  PROJECT_PROFILE_COLORS,
  selectActiveProjectProfile,
  selectProjectProfilesBucket,
  useProjectProfilesStore,
} from "../project-profiles-store";

const HOST_A = "host-a";
const HOST_B = "host-b";

function bucket(hostId: string | null) {
  return selectProjectProfilesBucket(useProjectProfilesStore.getState(), hostId);
}

function create(
  hostId: string | null,
  name: string,
  folderPaths: ReadonlyArray<string>,
  primaryPath: string | null,
): string | null {
  return useProjectProfilesStore.getState().createProfile(hostId, {
    name,
    color: "orange",
    folderPaths,
    primaryPath,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useProjectProfilesStore.setState({ byHost: {} });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useProjectProfilesStore", () => {
  it("starts empty and treats a missing host as the shared empty bucket", () => {
    expect(bucket(HOST_A)).toBe(EMPTY_PROJECT_PROFILES_BUCKET);
    expect(bucket(null)).toBe(EMPTY_PROJECT_PROFILES_BUCKET);
    expect(selectActiveProjectProfile(useProjectProfilesStore.getState(), HOST_A)).toBeNull();
  });

  it("creates a host-scoped profile and leaves other hosts untouched", () => {
    const id = create(HOST_A, "Titanos", ["/titanos"], "/titanos");
    expect(id).toEqual(expect.any(String));
    expect(create(null, "Nope", [], null)).toBeNull();
    expect(create(HOST_A, "   ", [], null)).toBeNull();

    const created = bucket(HOST_A).profiles[0];
    expect(created).toMatchObject({
      id,
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    expect(bucket(HOST_B).profiles).toEqual([]);
  });

  it("trims the name, drops empty folder paths, and resolves primary to a member", () => {
    const id = create(HOST_A, "  Titanos  ", ["", "/titanos", "/titanos", "/crm"], "/missing");
    expect(id).not.toBeNull();
    const created = bucket(HOST_A).profiles[0];
    expect(created.name).toBe("Titanos");
    expect(created.folderPaths).toEqual(["/titanos", "/crm"]);
    expect(created.primaryPath).toBe("/titanos");
  });

  it("activates a profile on its own host only; unknown ids are a no-op", () => {
    const id = create(HOST_A, "Titanos", ["/titanos"], "/titanos");
    useProjectProfilesStore.getState().setActiveProfile(HOST_A, id);
    useProjectProfilesStore.getState().setActiveProfile(HOST_A, "missing");
    expect(bucket(HOST_A).activeProfileId).toBe(id);
    expect(selectActiveProjectProfile(useProjectProfilesStore.getState(), HOST_A)?.name).toBe(
      "Titanos",
    );

    useProjectProfilesStore.getState().setActiveProfile(HOST_B, id);
    expect(bucket(HOST_B).activeProfileId).toBeNull();
  });

  it("renames, recolors, and rewrites folders without leaking across hosts", () => {
    const id = create(HOST_A, "Titanos", ["/titanos"], "/titanos");
    useProjectProfilesStore.getState().renameProfile(HOST_A, id ?? "", "  Ads  ");
    useProjectProfilesStore.getState().setProfileColor(HOST_A, id ?? "", "blue");
    useProjectProfilesStore.getState().setProfileFolders(HOST_A, id ?? "", ["/titanos", "/mcp"], "/mcp");
    useProjectProfilesStore.getState().renameProfile(HOST_B, id ?? "", "Leak");

    const updated = bucket(HOST_A).profiles[0];
    expect(updated.name).toBe("Ads");
    expect(updated.color).toBe("blue");
    expect(updated.folderPaths).toEqual(["/titanos", "/mcp"]);
    expect(updated.primaryPath).toBe("/mcp");
    expect(bucket(HOST_B).profiles).toEqual([]);
  });

  it("adds and removes folders on the active profile without touching another host", () => {
    const id = create(HOST_A, "Titanos", ["/titanos"], "/titanos");
    useProjectProfilesStore.getState().addProfileFolder(HOST_A, id ?? "", "/crm");
    useProjectProfilesStore.getState().setProfilePrimary(HOST_A, id ?? "", "/crm");
    useProjectProfilesStore.getState().removeProfileFolder(HOST_A, id ?? "", "/titanos");

    const updated = bucket(HOST_A).profiles[0];
    expect(updated.folderPaths).toEqual(["/crm"]);
    expect(updated.primaryPath).toBe("/crm");
  });

  it("deleting the active profile returns the host to All projects", () => {
    const id = create(HOST_A, "Titanos", ["/titanos"], "/titanos");
    useProjectProfilesStore.getState().setActiveProfile(HOST_A, id);
    useProjectProfilesStore.getState().deleteProfile(HOST_A, id ?? "");
    expect(bucket(HOST_A).profiles).toEqual([]);
    expect(bucket(HOST_A).activeProfileId).toBeNull();
  });

  it("rejects an unknown color and keeps the catalog closed", () => {
    expect(PROJECT_PROFILE_COLORS).toContain("orange");
    const id = create(HOST_A, "Titanos", [], null);
    useProjectProfilesStore
      .getState()
      .setProfileColor(HOST_A, id ?? "", "not-a-color" as "orange");
    expect(bucket(HOST_A).profiles[0].color).toBe("orange");
  });

  it("rehydration drops a bad color, a stale active id, and empty host keys", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:project-profiles",
      JSON.stringify({
        state: {
          byHost: {
            "": {
              profiles: [
                {
                  id: "ghost",
                  name: "Ghost",
                  color: "orange",
                  folderPaths: ["/x"],
                  primaryPath: "/x",
                },
              ],
              activeProfileId: "ghost",
            },
            [HOST_A]: {
              profiles: [
                {
                  id: "p1",
                  name: "Titanos",
                  color: "orange",
                  folderPaths: ["/titanos"],
                  primaryPath: "/titanos",
                },
                {
                  id: "p2",
                  name: "Bad",
                  color: "nope",
                  folderPaths: ["/x"],
                  primaryPath: "/x",
                },
              ],
              activeProfileId: "missing",
            },
          },
        },
        version: 1,
      }),
    );
    await useProjectProfilesStore.persist.rehydrate();
    expect(bucket("").profiles).toEqual([]);
    expect(bucket(HOST_A).profiles.map((profile) => profile.id)).toEqual(["p1"]);
    expect(bucket(HOST_A).activeProfileId).toBeNull();
  });
});
