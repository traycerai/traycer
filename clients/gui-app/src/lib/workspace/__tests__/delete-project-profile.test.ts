import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteActiveProjectProfile } from "../delete-project-profile";
import { useProjectNotesStore } from "@/stores/workspace/project-notes-store";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

beforeEach(() => {
  useProjectProfilesStore.setState({ byHost: {} });
  useProjectNotesStore.setState({ byHost: {} });
});

afterEach(() => {
  useProjectProfilesStore.setState({ byHost: {} });
  useProjectNotesStore.setState({ byHost: {} });
});

describe("deleteActiveProjectProfile", () => {
  it("moves that project's notes to General", () => {
    const profileId = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectNotesStore.getState().createNote(HOST, {
      title: "Ads",
      body: "",
      scope: { kind: "project", profileId: profileId ?? "" },
    });
    deleteActiveProjectProfile(HOST, profileId ?? "");
    expect(useProjectProfilesStore.getState().byHost[HOST]?.profiles).toEqual(
      [],
    );
    expect(useProjectNotesStore.getState().byHost[HOST]?.notes[0]?.scope).toEqual(
      { kind: "general" },
    );
  });

  it("leaves notes alone when only the store deleteProfile runs", () => {
    const profileId = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectNotesStore.getState().createNote(HOST, {
      title: "Ads",
      body: "",
      scope: { kind: "project", profileId: profileId ?? "" },
    });
    useProjectProfilesStore.getState().deleteProfile(HOST, profileId ?? "");
    expect(useProjectNotesStore.getState().byHost[HOST]?.notes[0]?.scope).toEqual(
      { kind: "project", profileId },
    );
  });
});
