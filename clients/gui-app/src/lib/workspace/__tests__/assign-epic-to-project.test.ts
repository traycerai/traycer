import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignEpicToProjectProfile,
  claimEpicOnMatchingProfile,
  createProjectFromWorkspaceHint,
} from "../assign-epic-to-project";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

describe("assignEpicToProjectProfile", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });
  afterEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });

  it("moves an epic from All projects onto Titanos", () => {
    const titanos = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    assignEpicToProjectProfile(HOST, "epic-login", titanos);
    expect(
      useProjectProfilesStore.getState().byHost[HOST].profiles[0].epicIds,
    ).toEqual(["epic-login"]);
  });

  it("moves an epic off CRM onto Titanos", () => {
    const titanos = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    const crm = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "CRM",
      color: "blue",
      folderPaths: ["/crm"],
      primaryPath: "/crm",
    });
    assignEpicToProjectProfile(HOST, "epic-1", crm);
    assignEpicToProjectProfile(HOST, "epic-1", titanos);
    const profiles = useProjectProfilesStore.getState().byHost[HOST].profiles;
    expect(profiles.find((p) => p.id === titanos)?.epicIds).toEqual(["epic-1"]);
    expect(profiles.find((p) => p.id === crm)?.epicIds).toEqual([]);
  });
});

describe("claimEpicOnMatchingProfile", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });
  afterEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });

  it("claims a Titanos-only chat while All projects is active", () => {
    useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectProfilesStore.getState().createProfile(HOST, {
      name: "CRM",
      color: "blue",
      folderPaths: ["/crm"],
      primaryPath: "/crm",
    });
    claimEpicOnMatchingProfile(HOST, "epic-titanos", {
      primaryPath: "/titanos",
      linkedWorkspaces: [{ hostId: HOST, workspacePath: "/titanos" }],
      worktreePaths: [],
    });
    expect(
      useProjectProfilesStore.getState().byHost[HOST].profiles[0].epicIds,
    ).toEqual(["epic-titanos"]);
  });

  it("does not claim a fan-out chat that touched two projects", () => {
    useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectProfilesStore.getState().createProfile(HOST, {
      name: "CRM",
      color: "blue",
      folderPaths: ["/crm"],
      primaryPath: "/crm",
    });
    claimEpicOnMatchingProfile(HOST, "epic-fanout", {
      primaryPath: "/titanos",
      linkedWorkspaces: [
        { hostId: HOST, workspacePath: "/titanos" },
        { hostId: HOST, workspacePath: "/crm" },
      ],
      worktreePaths: [],
    });
    expect(
      useProjectProfilesStore.getState().byHost[HOST].profiles[0].epicIds,
    ).toEqual([]);
  });

  it("does not steal an epic the user already moved", () => {
    const titanos = useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useProjectProfilesStore.getState().createProfile(HOST, {
      name: "CRM",
      color: "blue",
      folderPaths: ["/crm"],
      primaryPath: "/crm",
    });
    assignEpicToProjectProfile(HOST, "epic-1", titanos);
    claimEpicOnMatchingProfile(HOST, "epic-1", {
      primaryPath: "/crm",
      linkedWorkspaces: [{ hostId: HOST, workspacePath: "/crm" }],
      worktreePaths: [],
    });
    const profiles = useProjectProfilesStore.getState().byHost[HOST].profiles;
    expect(profiles[0].epicIds).toEqual(["epic-1"]);
    expect(profiles[1].epicIds).toEqual([]);
  });
});

describe("createProjectFromWorkspaceHint", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });
  afterEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
  });

  it("creates a project from the chat folder and claims the epic", () => {
    const id = createProjectFromWorkspaceHint(HOST, "epic-new", {
      primaryPath: "/Users/g/work/NovoApp",
      linkedWorkspaces: [
        { hostId: HOST, workspacePath: "/Users/g/work/NovoApp" },
      ],
      worktreePaths: [],
    });
    expect(id).not.toBeNull();
    const profile = useProjectProfilesStore.getState().byHost[HOST].profiles[0];
    expect(profile.name).toBe("NovoApp");
    expect(profile.folderPaths).toEqual(["/Users/g/work/NovoApp"]);
    expect(profile.epicIds).toEqual(["epic-new"]);
    expect(
      useProjectProfilesStore.getState().byHost[HOST].activeProfileId,
    ).toBeNull();
  });

  it("does not duplicate a project that already owns the folder", () => {
    useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    expect(
      createProjectFromWorkspaceHint(HOST, "epic-1", {
        primaryPath: "/titanos",
        linkedWorkspaces: [{ hostId: HOST, workspacePath: "/titanos" }],
        worktreePaths: [],
      }),
    ).toBeNull();
    expect(useProjectProfilesStore.getState().byHost[HOST].profiles).toHaveLength(
      1,
    );
  });
});
