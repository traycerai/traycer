import { describe, expect, it } from "vitest";
import { nextActiveProfileIdAfterDelete } from "../next-active-profile-after-delete";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";

function profile(id: string, name: string): ProjectProfile {
  return {
    id,
    name,
    color: "orange",
    folderPaths: [`/${name.toLowerCase()}`],
    primaryPath: `/${name.toLowerCase()}`,
    epicIds: [],
  };
}

describe("nextActiveProfileIdAfterDelete", () => {
  it("keeps the current profile when a sibling is deleted", () => {
    expect(
      nextActiveProfileIdAfterDelete({
        profiles: [profile("titanos", "Titanos"), profile("crm", "CRM")],
        activeProfileId: "titanos",
        deletedProfileId: "crm",
      }),
    ).toBe("titanos");
  });

  it("activates the next sibling when the active profile is deleted", () => {
    expect(
      nextActiveProfileIdAfterDelete({
        profiles: [
          profile("titanos", "Titanos"),
          profile("crm", "CRM"),
          profile("bkza", "BKZA"),
        ],
        activeProfileId: "titanos",
        deletedProfileId: "titanos",
      }),
    ).toBe("crm");
  });

  it("activates the previous sibling when the last profile is deleted", () => {
    expect(
      nextActiveProfileIdAfterDelete({
        profiles: [profile("titanos", "Titanos"), profile("crm", "CRM")],
        activeProfileId: "crm",
        deletedProfileId: "crm",
      }),
    ).toBe("titanos");
  });

  it("returns All projects when the last remaining profile is deleted", () => {
    expect(
      nextActiveProfileIdAfterDelete({
        profiles: [profile("titanos", "Titanos")],
        activeProfileId: "titanos",
        deletedProfileId: "titanos",
      }),
    ).toBeNull();
  });
});
