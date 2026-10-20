import { describe, expect, it } from "vitest";
import type { AgentReach } from "@traycer/protocol/host/agent/shared";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import {
  TASK_HOST_UNNAMED_LABEL,
  TASK_HOST_UNREACHABLE_LINE,
  taskHostGroups,
  type TaskHostGroup,
  type TaskHostGroupRow,
  type TaskHostGroupsInput,
} from "../task-host-groups-model";

const VIEWER = "u-viewer";

function hostRow(
  hostId: string,
  label: string | null,
  principal: TaskHostPrincipal,
  reach: AgentReach,
): TaskHostRow {
  return { hostId, label, principal, reach };
}

function ownRow(hostId: string, label: string | null): TaskHostRow {
  return hostRow(hostId, label, { kind: "user", id: VIEWER }, "same_principal");
}

function teamRow(
  hostId: string,
  label: string | null,
  teamId: string,
): TaskHostRow {
  return hostRow(
    hostId,
    label,
    { kind: "team", id: teamId },
    "other_principal",
  );
}

function otherUserRow(
  hostId: string,
  label: string | null,
  userId: string,
): TaskHostRow {
  return hostRow(
    hostId,
    label,
    { kind: "user", id: userId },
    "other_principal",
  );
}

function input(
  hosts: readonly TaskHostRow[],
  overrides: Partial<TaskHostGroupsInput>,
): TaskHostGroupsInput {
  return {
    hosts,
    viewerUserId: VIEWER,
    teams: [],
    collaboratorNames: new Map<string, string>(),
    directoryLabels: new Map<string, string>(),
    ...overrides,
  };
}

function groupsOf(
  hosts: readonly TaskHostRow[],
  overrides: Partial<TaskHostGroupsInput>,
): readonly TaskHostGroup[] {
  return taskHostGroups(input(hosts, overrides));
}

function onlyRow(group: TaskHostGroup): TaskHostGroupRow {
  expect(group.rows).toHaveLength(1);
  return group.rows[0];
}

describe("task host copy constants", () => {
  it("pins the two strings the section renders", () => {
    expect(TASK_HOST_UNREACHABLE_LINE).toBe("not reachable from this host");
    expect(TASK_HOST_UNNAMED_LABEL).toBe("Unnamed host");
  });
});

describe("taskHostGroups grouping", () => {
  it("returns no groups for no hosts", () => {
    expect(groupsOf([], {})).toEqual([]);
  });

  it("keys the viewer's own hosts as personal, titled Personal", () => {
    const groups = groupsOf([ownRow("h-1", "laptop")], {});

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("personal");
    expect(groups[0].title).toBe("Personal");
  });

  it("keys a team host as team:<id> and a collaborator's as user:<id>", () => {
    const groups = groupsOf(
      [teamRow("h-t", "ci", "team-1"), otherUserRow("h-a", "ana-box", "u-ana")],
      {},
    );

    expect(groups.map((group) => group.key)).toEqual([
      "team:team-1",
      "user:u-ana",
    ]);
  });

  it("titles a team by its name in the person's teams", () => {
    const groups = groupsOf([teamRow("h-t", "ci", "team-1")], {
      teams: [{ teamId: "team-1", name: "acme" }],
    });

    expect(groups[0].title).toBe("acme");
  });

  it("titles a team the person is not in as A team", () => {
    const groups = groupsOf([teamRow("h-t", "ci", "team-9")], {
      teams: [{ teamId: "team-1", name: "acme" }],
    });

    expect(groups[0].title).toBe("A team");
  });

  it("titles a collaborator as their possessive name", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      collaboratorNames: new Map([["u-ana", "Ana"]]),
    });

    expect(groups[0].title).toBe("Ana's");
  });

  it("titles a collaborator not in the names map as A collaborator's", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      collaboratorNames: new Map([["u-bo", "Bo"]]),
    });

    expect(groups[0].title).toBe("A collaborator's");
  });

  it("puts every host of one principal in one group", () => {
    const groups = groupsOf(
      [ownRow("h-1", "laptop"), ownRow("h-2", "desktop")],
      {},
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(2);
  });

  it("keeps a team and a user that share an id in separate groups", () => {
    const groups = groupsOf(
      [teamRow("h-t", "ci", "same-id"), otherUserRow("h-u", "box", "same-id")],
      {},
    );

    expect(groups.map((group) => group.key)).toEqual([
      "team:same-id",
      "user:same-id",
    ]);
  });
});

describe("taskHostGroups order", () => {
  it("puts Personal first, then teams, then collaborators, whatever order the rows arrive in", () => {
    const groups = groupsOf(
      [
        otherUserRow("h-a", "ana-box", "u-ana"),
        teamRow("h-t", "ci", "team-1"),
        ownRow("h-1", "laptop"),
      ],
      {
        teams: [{ teamId: "team-1", name: "acme" }],
        collaboratorNames: new Map([["u-ana", "Ana"]]),
      },
    );

    expect(groups.map((group) => group.key)).toEqual([
      "personal",
      "team:team-1",
      "user:u-ana",
    ]);
  });

  it("orders teams by title, then by id on a tie", () => {
    const groups = groupsOf(
      [
        teamRow("h-1", "a", "team-c"),
        teamRow("h-2", "b", "team-b"),
        teamRow("h-3", "c", "team-a"),
        teamRow("h-4", "d", "team-d"),
      ],
      {
        teams: [
          { teamId: "team-c", name: "zeta" },
          { teamId: "team-b", name: "acme" },
          { teamId: "team-a", name: "acme" },
          { teamId: "team-d", name: "beta" },
        ],
      },
    );

    expect(groups.map((group) => group.key)).toEqual([
      "team:team-a",
      "team:team-b",
      "team:team-d",
      "team:team-c",
    ]);
  });

  it("orders collaborators by title, then by id on a tie, after every team", () => {
    const groups = groupsOf(
      [
        otherUserRow("h-1", "a", "u-3"),
        otherUserRow("h-2", "b", "u-2"),
        otherUserRow("h-3", "c", "u-1"),
        teamRow("h-t", "ci", "team-z"),
      ],
      {
        teams: [{ teamId: "team-z", name: "zzz" }],
        collaboratorNames: new Map([
          ["u-3", "Ana"],
          ["u-2", "Bo"],
          ["u-1", "Bo"],
        ]),
      },
    );

    expect(groups.map((group) => group.key)).toEqual([
      "team:team-z",
      "user:u-3",
      "user:u-1",
      "user:u-2",
    ]);
  });

  it("orders rows in a group by label, then hostId", () => {
    const groups = groupsOf(
      [
        ownRow("h-4", "zebra"),
        ownRow("h-3", "alpha"),
        ownRow("h-2", "alpha"),
        ownRow("h-1", "mid"),
      ],
      {},
    );

    expect(groups[0].rows.map((row) => row.hostId)).toEqual([
      "h-2",
      "h-3",
      "h-1",
      "h-4",
    ]);
  });

  it("sorts rows by the label the row shows, not the server's alone", () => {
    const groups = groupsOf([ownRow("h-1", null), ownRow("h-2", "beta")], {
      directoryLabels: new Map<string, string>([["h-1", "alpha"]]),
    });

    expect(groups[0].rows.map((row) => row.hostId)).toEqual(["h-1", "h-2"]);
  });
});

describe("taskHostGroups row label", () => {
  it("shows the server's label when it has one, over the directory's", () => {
    const groups = groupsOf([ownRow("h-1", "server-label")], {
      directoryLabels: new Map<string, string>([["h-1", "directory-label"]]),
    });

    expect(onlyRow(groups[0]).label).toBe("server-label");
  });

  it("falls back to the directory's label for that host", () => {
    const groups = groupsOf([ownRow("h-1", null)], {
      directoryLabels: new Map<string, string>([["h-1", "directory-label"]]),
    });

    expect(onlyRow(groups[0]).label).toBe("directory-label");
  });

  it("falls back to Unnamed host when neither names it", () => {
    const groups = groupsOf([otherUserRow("h-a", null, "u-ana")], {});

    expect(onlyRow(groups[0]).label).toBe("Unnamed host");
  });
});

describe("taskHostGroups a collaborator's host that is in the person's directory", () => {
  const COLLABORATOR_IN_DIRECTORY = new Map<string, string>([
    ["h-a", "directory-label"],
  ]);

  it("shows the server's label, and never the directory's", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      directoryLabels: COLLABORATOR_IN_DIRECTORY,
    });

    expect(groups[0].key).toBe("user:u-ana");
    expect(onlyRow(groups[0]).label).toBe("ana-box");
  });

  it("is Unnamed host without a server label, not the directory's label", () => {
    const groups = groupsOf([otherUserRow("h-a", null, "u-ana")], {
      directoryLabels: COLLABORATOR_IN_DIRECTORY,
    });

    expect(onlyRow(groups[0]).label).toBe("Unnamed host");
  });

  it("does not change the viewer's own host or a team's host in the same directory", () => {
    const groups = groupsOf(
      [ownRow("h-1", null), teamRow("h-t", null, "team-1")],
      {
        directoryLabels: new Map<string, string>([
          ["h-1", "laptop"],
          ["h-t", "team-box"],
        ]),
      },
    );
    const own = groups.find((group) => group.key === "personal");
    const team = groups.find((group) => group.key === "team:team-1");

    expect(own === undefined ? null : onlyRow(own).label).toBe("laptop");
    expect(team === undefined ? null : onlyRow(team).label).toBe("team-box");
  });
});
