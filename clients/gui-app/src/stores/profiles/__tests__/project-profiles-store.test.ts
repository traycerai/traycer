import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewProjectProfileInput } from "@/lib/profiles/types";
import {
  activeProjectProfileKey,
  projectProfilesRegistryKey,
} from "@/lib/persist/keys";
import { useActiveProjectProfileStore } from "../active-project-profile-store";
import { useProjectProfilesStore } from "../project-profiles-store";

const PROFILES_KEY = projectProfilesRegistryKey(null);
const ACTIVE_KEY = activeProjectProfileKey(null);

const baseInput: NewProjectProfileInput = {
  name: "  Acme  ",
  icon: "rocket",
  color: "blue",
  folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
};

function resetStores(): void {
  window.localStorage.clear();
  useProjectProfilesStore.persist.setOptions({ name: PROFILES_KEY });
  useActiveProjectProfileStore.persist.setOptions({ name: ACTIVE_KEY });
  useProjectProfilesStore.getState().resetForTests();
  useActiveProjectProfileStore.getState().resetForTests();
}

describe("useProjectProfilesStore", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("createProfile appends, stamps fields, and returns the created profile", () => {
    const created = useProjectProfilesStore.getState().createProfile(baseInput);
    const profiles = useProjectProfilesStore.getState().profiles;

    expect(profiles).toHaveLength(1);
    expect(created).toEqual(profiles[0]);
    expect(created.name).toBe("Acme");
    expect(created.icon).toBe("rocket");
    expect(created.color).toBe("blue");
    expect(created.folders).toEqual(baseInput.folders);
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);
  });

  it("createProfile throws when name is blank or folders empty", () => {
    expect(() =>
      useProjectProfilesStore.getState().createProfile({
        ...baseInput,
        name: "   ",
      }),
    ).toThrow("Project profile requires a name and at least one folder");

    expect(() =>
      useProjectProfilesStore.getState().createProfile({
        ...baseInput,
        folders: [],
      }),
    ).toThrow("Project profile requires a name and at least one folder");
  });

  it("updateProfile applies only defined fields and bumps updatedAt", () => {
    const created = useProjectProfilesStore.getState().createProfile(baseInput);
    const previousUpdatedAt = created.updatedAt;

    useProjectProfilesStore.getState().updateProfile(created.id, {
      name: "Renamed",
      icon: undefined,
      color: "red",
      folders: undefined,
    });

    const updated = useProjectProfilesStore
      .getState()
      .profiles.find((p) => p.id === created.id);
    expect(updated).toBeDefined();
    if (updated === undefined) {
      throw new Error("expected updated profile");
    }
    expect(updated.name).toBe("Renamed");
    expect(updated.icon).toBe("rocket");
    expect(updated.color).toBe("red");
    expect(updated.folders).toEqual(baseInput.folders);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(previousUpdatedAt);
  });

  it("updateProfile is a no-op for unknown id", () => {
    useProjectProfilesStore.getState().createProfile(baseInput);
    const before = useProjectProfilesStore.getState().profiles;

    useProjectProfilesStore.getState().updateProfile("missing", {
      name: "Nope",
      icon: undefined,
      color: undefined,
      folders: undefined,
    });

    expect(useProjectProfilesStore.getState().profiles).toEqual(before);
  });

  it("deleteProfile removes by id", () => {
    const created = useProjectProfilesStore.getState().createProfile(baseInput);
    useProjectProfilesStore.getState().deleteProfile(created.id);
    expect(useProjectProfilesStore.getState().profiles).toEqual([]);
  });
});

describe("useActiveProjectProfileStore", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("defaults to null and supports set/switch/null", () => {
    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(null);

    useActiveProjectProfileStore.getState().setActiveProfile("p1");
    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe("p1");

    useActiveProjectProfileStore.getState().setActiveProfile("p2");
    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe("p2");

    useActiveProjectProfileStore.getState().setActiveProfile(null);
    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(null);
  });
});
