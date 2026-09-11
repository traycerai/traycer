import { describe, expect, it } from "vitest";
import {
  focusHostIds,
  focusPromptHostId,
  groupRowsByHost,
  isUnknownHostId,
  resolveFocusHostId,
  shouldGroupByHost,
  splitTaskByHost,
  UNKNOWN_HOST_ID,
} from "@/lib/home-focus/focus-host-groups";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusModel,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function activation(feedId: string): MergedNotificationRow {
  return {
    feedId,
    source: "host",
    sourceId: feedId,
    createdAt: 0,
    readAt: null,
    title: "Approve",
    body: "",
    payload: null,
    hostKind: "approval.requested",
    appLocalKind: null,
    globalEntry: null,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    sourceRef: null,
    originHostId: null,
    providerPackAttribution: null,
    category: "task",
  };
}

function promptRow(overrides: Partial<FocusPromptRow>): FocusPromptRow {
  const key = overrides.key ?? nextId("prompt");
  return {
    key,
    kind: "approval",
    epicId: "epic-1",
    chatId: "chat-1",
    taskTitle: "Task",
    title: "Approve",
    body: "",
    createdAt: 0,
    originHostId: null,
    activation: activation(key),
    ...overrides,
  };
}

function agentRow(overrides: Partial<FocusAgentRow>): FocusAgentRow {
  return {
    agentId: overrides.agentId ?? nextId("agent"),
    title: null,
    surface: "chat",
    tier: "turn",
    parentId: null,
    hostId: null,
    hostUnattributed: false,
    stoppable: true,
    ...overrides,
  };
}

function taskRow(overrides: Partial<FocusTaskRow>): FocusTaskRow {
  return {
    epicId: overrides.epicId ?? nextId("epic"),
    taskTitle: "Task",
    mountedHere: true,
    agents: [],
    needsYou: false,
    stoppable: true,
    ...overrides,
  };
}

function backgroundRow(
  overrides: Partial<FocusBackgroundRow>,
): FocusBackgroundRow {
  return {
    key: overrides.key ?? nextId("bg"),
    epicId: "epic-1",
    chatId: "chat-1",
    taskTitle: "Task",
    chatTitle: "Chat",
    hostId: null,
    label: "10min heartbeat",
    kind: "background-item",
    itemKind: "monitor",
    startedAtMs: null,
    stoppable: false,
    ...overrides,
  };
}

function model(overrides: Partial<FocusModel>): FocusModel {
  return {
    prompts: [],
    tasks: [],
    background: [],
    coverage: {
      activity: "live",
      degradedHostIds: [],
      notifications: "cloud",
      backgroundIsMountedOnly: true,
    },
    badgeCount: 0,
    ...overrides,
  };
}

describe("resolveFocusHostId", () => {
  // A row with no host of its own is acted on where this client is pointing,
  // so that is the machine it belongs under. Resolving BEFORE counting is what
  // keeps a single-host install single-host.
  it("resolves an unnamed host to the active one", () => {
    expect(resolveFocusHostId(null, "host-a")).toBe("host-a");
    expect(resolveFocusHostId("host-b", "host-a")).toBe("host-b");
  });

  // With no active host there is nothing to resolve TO, and the row still has
  // to land somewhere: dropping it made a section's heading count disagree
  // with the rows under it, silently, exactly when the page knows least.
  it("falls back to the unknown bucket when there is no active host either", () => {
    const resolved = resolveFocusHostId(null, null);
    expect(resolved).toBe(UNKNOWN_HOST_ID);
    expect(isUnknownHostId(resolved)).toBe(true);
    expect(isUnknownHostId("host-a")).toBe(false);
  });
});

describe("splitTaskByHost", () => {
  // The defect this replaced: an epic is cloud-homed and can be worked from
  // two machines, so `agents` holds both - and asking for the task's one host
  // answered `null`, which resolved to whichever machine the user was at.
  it("splits a task worked from two hosts into one slice each", () => {
    const task = taskRow({
      epicId: "epic-shared",
      agents: [
        agentRow({ agentId: "agent-a", hostId: "host-a" }),
        agentRow({ agentId: "agent-b", hostId: "host-b" }),
      ],
    });
    const slices = splitTaskByHost(task, [], {
      enabled: true,
      activeHostId: "host-active",
    });

    expect(slices.map((slice) => slice.hostId).sort()).toEqual([
      "host-a",
      "host-b",
    ]);
    for (const slice of slices) {
      expect(slice.splitAcrossHosts).toBe(true);
      expect(slice.task.agents).toHaveLength(1);
      expect(slice.task.agents[0].hostId).toBe(slice.hostId);
      // Never the active host: the task names two machines and neither is it.
      expect(slice.hostId).not.toBe("host-active");
    }
  });

  it("leaves a single-host task whole, by identity", () => {
    const task = taskRow({
      agents: [agentRow({ hostId: "host-a" }), agentRow({ hostId: "host-a" })],
    });
    const slices = splitTaskByHost(task, [], {
      enabled: true,
      activeHostId: "host-active",
    });

    expect(slices).toHaveLength(1);
    expect(slices[0].splitAcrossHosts).toBe(false);
    expect(slices[0].task).toBe(task);
  });

  it("files each job under its own chat's host", () => {
    const task = taskRow({
      epicId: "epic-1",
      agents: [agentRow({ hostId: "host-a" })],
    });
    const jobs = [
      backgroundRow({ key: "a", epicId: "epic-1", hostId: "host-a" }),
      backgroundRow({ key: "b", epicId: "epic-1", hostId: "host-b" }),
    ];
    const slices = splitTaskByHost(task, jobs, {
      enabled: true,
      activeHostId: "host-active",
    });

    const byHost = new Map(slices.map((slice) => [slice.hostId, slice]));
    expect(byHost.get("host-a")?.jobs.map((job) => job.key)).toEqual(["a"]);
    expect(byHost.get("host-b")?.jobs.map((job) => job.key)).toEqual(["b"]);
    // The host that only has a job still gets a slice, with no agents.
    expect(byHost.get("host-b")?.task.agents).toEqual([]);
  });

  // A reachable host's row must not inherit an unreachable sibling's refusal.
  it("re-folds stoppable from the agents that remain", () => {
    const task = taskRow({
      stoppable: false,
      agents: [
        agentRow({ agentId: "here", hostId: "host-a", stoppable: true }),
        agentRow({ agentId: "gone", hostId: "host-b", stoppable: false }),
      ],
    });
    const byHost = new Map(
      splitTaskByHost(task, [], {
        enabled: true,
        activeHostId: "host-active",
      }).map((slice) => [slice.hostId, slice]),
    );
    expect(byHost.get("host-a")?.task.stoppable).toBe(true);
    expect(byHost.get("host-b")?.task.stoppable).toBe(false);
  });

  // A single-host page must be byte-identical to the ungrouped one, so the
  // split does not run at all there - it would re-key rows and re-fold
  // `stoppable` for a distinction the page is not drawing.
  it("returns the task untouched when grouping is off", () => {
    const task = taskRow({
      agents: [agentRow({ hostId: "host-a" }), agentRow({ hostId: "host-b" })],
    });
    const slices = splitTaskByHost(task, [], {
      enabled: false,
      activeHostId: "host-active",
    });
    expect(slices).toHaveLength(1);
    expect(slices[0].task).toBe(task);
    expect(slices[0].splitAcrossHosts).toBe(false);
  });

  it("resolves an unnamed agent host to the active host", () => {
    const slices = splitTaskByHost(
      taskRow({ agents: [agentRow({ hostId: null })] }),
      [],
      { enabled: true, activeHostId: "host-active" },
    );
    expect(slices.map((slice) => slice.hostId)).toEqual(["host-active"]);
  });
});

describe("focusHostIds and shouldGroupByHost", () => {
  it("does not group a page whose rows all resolve to one host", () => {
    const hostIds = focusHostIds(
      model({
        prompts: [promptRow({ originHostId: null })],
        tasks: [
          taskRow({
            epicId: "epic-1",
            agents: [agentRow({ hostId: "host-a", tier: "turn" })],
          }),
        ],
        background: [backgroundRow({ epicId: "epic-2", hostId: null })],
      }),
      "host-a",
    );
    expect([...hostIds]).toEqual(["host-a"]);
    expect(shouldGroupByHost(hostIds)).toBe(false);
  });

  it("groups once a second host is named anywhere on the page", () => {
    const hostIds = focusHostIds(
      model({
        prompts: [promptRow({ originHostId: "host-b" })],
        tasks: [
          taskRow({
            epicId: "epic-1",
            agents: [agentRow({ hostId: "host-a", tier: "turn" })],
          }),
        ],
      }),
      "host-a",
    );
    expect([...hostIds].sort()).toEqual(["host-a", "host-b"]);
    expect(shouldGroupByHost(hostIds)).toBe(true);
  });

  // A task H6 hides must not be the reason the page splits: the reader would
  // see headings with no row that explains them.
  it("ignores a task the Running section does not draw", () => {
    const hostIds = focusHostIds(
      model({
        tasks: [
          taskRow({
            epicId: "epic-idle",
            agents: [agentRow({ hostId: "host-b", tier: "background" })],
          }),
        ],
        background: [backgroundRow({ epicId: "epic-idle", hostId: "host-a" })],
      }),
      "host-a",
    );
    expect([...hostIds]).toEqual(["host-a"]);
    expect(shouldGroupByHost(hostIds)).toBe(false);
  });

  it("names no host on a page with nothing on it", () => {
    expect(shouldGroupByHost(focusHostIds(model({}), "host-a"))).toBe(false);
  });
});

describe("groupRowsByHost", () => {
  const options = {
    activeHostId: "host-active",
    registryOrder: ["host-z", "host-active", "host-m"],
  };

  it("puts the active host first, then the registry's own order", () => {
    const rows = [
      { id: "1", hostId: "host-m" },
      { id: "2", hostId: "host-active" },
      { id: "3", hostId: "host-z" },
    ];
    expect(
      groupRowsByHost(rows, (row) => row.hostId, options).map(
        (group) => group.hostId,
      ),
    ).toEqual(["host-active", "host-z", "host-m"]);
  });

  it("sorts a host the registry has never listed last, by id", () => {
    const rows = [
      { id: "1", hostId: "host-unknown-b" },
      { id: "2", hostId: "host-unknown-a" },
      { id: "3", hostId: "host-active" },
    ];
    expect(
      groupRowsByHost(rows, (row) => row.hostId, options).map(
        (group) => group.hostId,
      ),
    ).toEqual(["host-active", "host-unknown-a", "host-unknown-b"]);
  });

  it("folds unnamed hosts into the active host's group", () => {
    const rows = [
      { id: "1", hostId: null },
      { id: "2", hostId: "host-active" },
    ];
    const groups = groupRowsByHost(rows, (row) => row.hostId, options);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((row) => row.id)).toEqual(["1", "2"]);
  });

  // Grouping re-arranges rows; it must not re-RANK them. The model already put
  // attention first, and a group that re-sorted would undo it.
  it("keeps each group's rows in the order they arrived", () => {
    const rows = [
      { id: "first", hostId: "host-active" },
      { id: "other", hostId: "host-z" },
      { id: "second", hostId: "host-active" },
    ];
    const groups = groupRowsByHost(rows, (row) => row.hostId, options);
    expect(groups[0].rows.map((row) => row.id)).toEqual(["first", "second"]);
  });

  it("drops nothing when there is no active host to resolve against", () => {
    const rows = [{ id: "1", hostId: "host-z" }];
    const groups = groupRowsByHost(rows, (row) => row.hostId, {
      activeHostId: null,
      registryOrder: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].hostId).toBe("host-z");
  });
});

describe("groupRowsByHost with no active host", () => {
  // The case the review found: two named hosts turn grouping on, and the
  // unresolved row has nothing to resolve to. It must still appear.
  it("keeps unresolved rows in an unknown group, last, and loses none", () => {
    const rows = [
      { id: "a", hostId: "host-a" },
      { id: "b", hostId: "host-b" },
      { id: "unresolved", hostId: null },
    ];
    const groups = groupRowsByHost(rows, (row) => row.hostId, {
      activeHostId: null,
      registryOrder: ["host-a", "host-b"],
    });

    expect(groups.map((group) => group.hostId)).toEqual([
      "host-a",
      "host-b",
      UNKNOWN_HOST_ID,
    ]);
    // Totals reconcile: every row is in exactly one group.
    expect(groups.flatMap((group) => group.rows)).toHaveLength(rows.length);
    expect(groups[2].rows.map((row) => row.id)).toEqual(["unresolved"]);
  });

  it("sorts the unknown bucket after a host the registry never listed", () => {
    const rows = [
      { id: "unresolved", hostId: null },
      { id: "stranger", hostId: "host-unlisted" },
      { id: "known", hostId: "host-a" },
    ];
    const groups = groupRowsByHost(rows, (row) => row.hostId, {
      activeHostId: null,
      registryOrder: ["host-a"],
    });
    expect(groups.map((group) => group.hostId)).toEqual([
      "host-a",
      "host-unlisted",
      UNKNOWN_HOST_ID,
    ]);
  });

  // One unresolved row must not split a page whose named rows share a host:
  // the bucket is not a machine, so it never turns grouping on by itself.
  it("does not let the unknown bucket enable grouping", () => {
    const hostIds = focusHostIds(
      model({
        background: [
          backgroundRow({ key: "named", hostId: "host-a" }),
          backgroundRow({ key: "unresolved", hostId: null }),
        ],
      }),
      null,
    );
    expect([...hostIds]).toEqual(["host-a"]);
    expect(shouldGroupByHost(hostIds)).toBe(false);
  });
});

describe("focusPromptHostId", () => {
  // Where it was RAISED, not where this window is pointing: an origin-bound
  // prompt has to be answered on its own machine.
  it("reads the prompt's origin host", () => {
    expect(focusPromptHostId(promptRow({ originHostId: "host-b" }))).toBe(
      "host-b",
    );
    expect(focusPromptHostId(promptRow({ originHostId: null }))).toBeNull();
  });
});
