import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimEpicOnActiveProfile } from "../claim-epic-on-active-profile";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

describe("claimEpicOnActiveProfile", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });
  afterEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });

  it("is a no-op when no project is active", () => {
    claimEpicOnActiveProfile(HOST, "epic-1");
    expect(useProjectProfilesStore.getState().byHost[HOST]).toBeUndefined();
  });

  it("records the epic on the active project so local-mode chats stay visible", () => {
    const id = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectProfilesStore.getState().setActiveProfile(HOST, id);
    claimEpicOnActiveProfile(HOST, "epic-local");
    expect(
      useProjectProfilesStore.getState().byHost[HOST].profiles[0].epicIds,
    ).toEqual(["epic-local"]);
  });
});
