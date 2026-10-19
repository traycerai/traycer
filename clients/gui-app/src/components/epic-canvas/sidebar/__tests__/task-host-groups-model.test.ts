import { describe, expect, it } from "vitest";
import type { AgentReach } from "@traycer/protocol/host/agent/shared";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import {
  TASK_HOST_UNNAMED_LABEL,
  TASK_HOST_UNREACHABLE_LINE,
  taskHostAgentsLine,
  taskHostGroups,
  type TaskHostDirectoryFact,
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
    directory: new Map<string, TaskHostDirectoryFact>(),
    agentCountByHostId: new Map<string, number>(),
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

describe("taskHostAgentsLine", () => {
  it("says 1 agent and N agents", () => {
    expect(taskHostAgentsLine(1)).toBe("1 agent");
    expect(taskHostAgentsLine(2)).toBe("2 agents");
    expect(taskHostAgentsLine(12)).toBe("12 agents");
  });

  it("says nothing at zero", () => {
    expect(taskHostAgentsLine(0)).toBeNull();
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
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "alpha", state: "online" }],
      ]),
    });

    expect(groups[0].rows.map((row) => row.hostId)).toEqual(["h-1", "h-2"]);
  });
});

describe("taskHostGroups row label", () => {
  it("shows the server's label when it has one, over the directory's", () => {
    const groups = groupsOf([ownRow("h-1", "server-label")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "directory-label", state: "online" }],
      ]),
    });

    expect(onlyRow(groups[0]).label).toBe("server-label");
  });

  it("falls back to the directory's label for that host", () => {
    const groups = groupsOf([ownRow("h-1", null)], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "directory-label", state: "offline" }],
      ]),
    });

    expect(onlyRow(groups[0]).label).toBe("directory-label");
  });

  it("falls back to Unnamed host when neither names it", () => {
    const groups = groupsOf([otherUserRow("h-a", null, "u-ana")], {});

    expect(onlyRow(groups[0]).label).toBe("Unnamed host");
  });
});

describe("taskHostGroups agents line", () => {
  it("reads the count for the host from the map", () => {
    const groups = groupsOf(
      [ownRow("h-1", "a"), ownRow("h-2", "b"), ownRow("h-3", "c")],
      {
        agentCountByHostId: new Map([
          ["h-1", 1],
          ["h-2", 2],
          ["h-3", 0],
        ]),
      },
    );

    expect(groups[0].rows.map((row) => row.agentsLine)).toEqual([
      "1 agent",
      "2 agents",
      null,
    ]);
  });

  it("is null for a host absent from the map", () => {
    const groups = groupsOf([ownRow("h-1", "a")], {
      agentCountByHostId: new Map([["h-other", 3]]),
    });

    expect(onlyRow(groups[0]).agentsLine).toBeNull();
  });
});

describe("taskHostGroups unreachable", () => {
  it("is true exactly when reach is other_principal", () => {
    const groups = groupsOf(
      [ownRow("h-1", "mine"), otherUserRow("h-2", "theirs", "u-ana")],
      {},
    );
    const own = groups.find((group) => group.key === "personal");
    const theirs = groups.find((group) => group.key === "user:u-ana");

    expect(own === undefined ? null : onlyRow(own).unreachable).toBe(false);
    expect(theirs === undefined ? null : onlyRow(theirs).unreachable).toBe(
      true,
    );
  });

  it("does not follow directory state: a reachable offline host is not unreachable", () => {
    const groups = groupsOf([ownRow("h-1", "mine")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "mine", state: "offline" }],
      ]),
    });

    expect(onlyRow(groups[0]).state).toBe("offline");
    expect(onlyRow(groups[0]).unreachable).toBe(false);
  });

  it("does not follow directory state: an unreachable online host is unreachable", () => {
    const groups = groupsOf([teamRow("h-t", "theirs", "team-1")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-t", { label: "theirs", state: "online" }],
      ]),
    });

    expect(onlyRow(groups[0]).state).toBe("online");
    expect(onlyRow(groups[0]).unreachable).toBe(true);
  });

  it("is true for a team host the server marks other_principal", () => {
    const groups = groupsOf([teamRow("h-t", "ci", "team-1")], {});

    expect(onlyRow(groups[0]).unreachable).toBe(true);
  });

  it("is false for a team host the server marks same_principal", () => {
    const groups = groupsOf(
      [hostRow("h-t", "ci", { kind: "team", id: "team-1" }, "same_principal")],
      {},
    );

    expect(onlyRow(groups[0]).unreachable).toBe(false);
  });
});

describe("taskHostGroups state", () => {
  it("is the directory's state for a host in the directory", () => {
    const groups = groupsOf([ownRow("h-1", "a"), ownRow("h-2", "b")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "a", state: "online" }],
        ["h-2", { label: "b", state: "offline" }],
      ]),
    });

    expect(groups[0].rows.map((row) => row.state)).toEqual([
      "online",
      "offline",
    ]);
  });

  it("is null when the directory cannot say", () => {
    const groups = groupsOf([ownRow("h-1", "a")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "a", state: null }],
      ]),
    });

    expect(onlyRow(groups[0]).state).toBeNull();
  });

  it("is null for the viewer's own host that is not in the directory, never offline", () => {
    const groups = groupsOf([ownRow("h-1", "mine")], {});

    expect(onlyRow(groups[0]).state).toBeNull();
  });

  it("is null for a collaborator's host that is not in the directory", () => {
    const groups = groupsOf([otherUserRow("h-a", "theirs", "u-ana")], {});

    expect(onlyRow(groups[0]).state).toBeNull();
  });
});

describe("taskHostGroups openable", () => {
  it("is true exactly when the host is in the directory", () => {
    const groups = groupsOf([ownRow("h-1", "in"), ownRow("h-2", "out")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "in", state: "online" }],
      ]),
    });

    expect(groups[0].rows.map((row) => [row.hostId, row.openable])).toEqual([
      ["h-1", true],
      ["h-2", false],
    ]);
  });

  it("is true for a directory host whose state is unknown", () => {
    const groups = groupsOf([ownRow("h-1", "in")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-1", { label: "in", state: null }],
      ]),
    });

    expect(onlyRow(groups[0]).openable).toBe(true);
  });

  it("is false for a collaborator's host that is not in the directory, even when it is labelled", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      collaboratorNames: new Map([["u-ana", "Ana"]]),
    });

    expect(onlyRow(groups[0]).label).toBe("ana-box");
    expect(onlyRow(groups[0]).openable).toBe(false);
    expect(onlyRow(groups[0]).state).toBeNull();
  });
});

describe("taskHostGroups a collaborator's host that is in the person's directory", () => {
  const COLLABORATOR_IN_DIRECTORY = new Map<string, TaskHostDirectoryFact>([
    ["h-a", { label: "directory-label", state: "online" }],
  ]);

  it("gets no state, whatever the directory says", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      directory: COLLABORATOR_IN_DIRECTORY,
    });

    expect(groups[0].key).toBe("user:u-ana");
    expect(onlyRow(groups[0]).state).toBeNull();
  });

  it("is not openable, whatever the directory says", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      directory: COLLABORATOR_IN_DIRECTORY,
    });

    expect(onlyRow(groups[0]).openable).toBe(false);
  });

  it("keeps its offline directory entry out of the row too", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      directory: new Map<string, TaskHostDirectoryFact>([
        ["h-a", { label: "directory-label", state: "offline" }],
      ]),
    });

    expect(onlyRow(groups[0]).state).toBeNull();
    expect(onlyRow(groups[0]).openable).toBe(false);
  });

  it("shows the server's label, and never the directory's", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      directory: COLLABORATOR_IN_DIRECTORY,
    });

    expect(onlyRow(groups[0]).label).toBe("ana-box");
  });

  it("is Unnamed host without a server label, not the directory's label", () => {
    const groups = groupsOf([otherUserRow("h-a", null, "u-ana")], {
      directory: COLLABORATOR_IN_DIRECTORY,
    });

    expect(onlyRow(groups[0]).label).toBe("Unnamed host");
  });

  it("is still marked unreachable, from the server's reach", () => {
    const groups = groupsOf([otherUserRow("h-a", "ana-box", "u-ana")], {
      directory: COLLABORATOR_IN_DIRECTORY,
    });

    expect(onlyRow(groups[0]).unreachable).toBe(true);
  });

  it("does not change the viewer's own host or a team's host in the same directory", () => {
    const groups = groupsOf(
      [ownRow("h-1", null), teamRow("h-t", null, "team-1")],
      {
        directory: new Map<string, TaskHostDirectoryFact>([
          ["h-1", { label: "laptop", state: "online" }],
          ["h-t", { label: "team-box", state: "offline" }],
        ]),
      },
    );
    const own = groups.find((group) => group.key === "personal");
    const team = groups.find((group) => group.key === "team:team-1");

    expect(own === undefined ? null : onlyRow(own)).toMatchObject({
      label: "laptop",
      state: "online",
      openable: true,
    });
    expect(team === undefined ? null : onlyRow(team)).toMatchObject({
      label: "team-box",
      state: "offline",
      openable: true,
    });
  });
});
