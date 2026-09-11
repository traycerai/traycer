import { describe, expect, it } from "vitest";
import {
  epicIdsWithJobs,
  focusCounts,
  isMidTurn,
  runningTasks,
  visibleAgents,
} from "@/lib/home-focus/focus-running";
import {
  focusAgentState,
  focusJobState,
  focusTaskState,
} from "@/lib/home-focus/focus-row-status";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusModel,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";

/**
 * The rule that stops one piece of activity being listed twice, decided here
 * rather than in a component so it is testable without a DOM - and so the
 * Focus view, the Tasks view and the summary line cannot each answer it
 * slightly differently.
 */

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
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
    hostId: "host-local",
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
    browsers: [],
    coverage: {
      activity: "live",
      degradedHostIds: [],
      notifications: "cloud",
      backgroundIsMountedOnly: true,
      browsersAreMountedOnly: true,
    },
    badgeCount: 0,
    ...overrides,
  };
}

describe("runningTasks", () => {
  const withJobs = (...epicIds: ReadonlyArray<string>): ReadonlySet<string> =>
    new Set(epicIds);

  it("keeps a task with at least one mid-turn agent", () => {
    const busy = taskRow({
      epicId: "epic-busy",
      agents: [agentRow({ tier: "background" }), agentRow({ tier: "turn" })],
    });
    expect(runningTasks([busy], withJobs("epic-busy"))).toEqual([busy]);
  });

  // The duplicate the user saw: an idle chat hosting a running monitor is a
  // background-tier working agent AND the source of a Background row.
  it("drops a warm task whose only activity is background-tier", () => {
    expect(
      runningTasks(
        [
          taskRow({
            epicId: "epic-idle",
            agents: [agentRow({ tier: "background" })],
          }),
        ],
        withJobs("epic-idle"),
      ),
    ).toEqual([]);
  });

  // The other half, and it is not symmetric: with no job row to stand in for
  // it, dropping the task takes it off the page rather than de-duplicating it.
  it("keeps a background-only task this window has no job row for", () => {
    const cold = taskRow({
      epicId: "epic-cold",
      mountedHere: false,
      agents: [agentRow({ tier: "background" })],
    });
    expect(runningTasks([cold], withJobs("epic-elsewhere"))).toEqual([cold]);
  });

  it("agrees with visibleAgents on every task, by construction", () => {
    const tasks = [
      taskRow({ epicId: "epic-a", agents: [agentRow({ tier: "turn" })] }),
      taskRow({
        epicId: "epic-idle",
        agents: [agentRow({ tier: "background" })],
      }),
      taskRow({
        epicId: "epic-cold",
        agents: [agentRow({ tier: "background" })],
      }),
    ];
    const jobEpicIds = withJobs("epic-a", "epic-idle");
    for (const task of tasks) {
      const drawn =
        visibleAgents(task.agents, jobEpicIds.has(task.epicId)).length > 0;
      expect(runningTasks([task], jobEpicIds).length > 0).toBe(drawn);
    }
  });

  it("preserves the model's order among the tasks it keeps", () => {
    const tasks = [
      taskRow({ epicId: "epic-a", agents: [agentRow({ tier: "turn" })] }),
      taskRow({
        epicId: "epic-idle",
        agents: [agentRow({ tier: "background" })],
      }),
      taskRow({ epicId: "epic-b", agents: [agentRow({ tier: "turn" })] }),
    ];
    expect(
      runningTasks(tasks, withJobs("epic-a", "epic-idle", "epic-b")).map(
        (task) => task.epicId,
      ),
    ).toEqual(["epic-a", "epic-b"]);
  });
});

describe("visibleAgents", () => {
  const busy = agentRow({ agentId: "busy", tier: "turn" });
  const idle = agentRow({ agentId: "idle", tier: "background" });

  it("hides a background-tier agent whose work has a job row instead", () => {
    expect(visibleAgents([busy, idle], true)).toEqual([busy]);
  });

  // The exception, and the reason it is not a softening: with no job row,
  // hiding the agent loses the work rather than de-duplicating it.
  it("keeps a background-tier agent when this window shows no job for it", () => {
    expect(visibleAgents([busy, idle], false)).toEqual([busy, idle]);
  });

  it("never hides a mid-turn agent", () => {
    expect(visibleAgents([busy], true)).toEqual([busy]);
    expect(isMidTurn(busy)).toBe(true);
    expect(isMidTurn(idle)).toBe(false);
  });
});

describe("epicIdsWithJobs", () => {
  it("reports the epics a job row names, and no others", () => {
    const ids = epicIdsWithJobs([
      backgroundRow({ epicId: "epic-a" }),
      backgroundRow({ epicId: "epic-a" }),
      backgroundRow({ epicId: "epic-b" }),
    ]);
    expect([...ids].sort()).toEqual(["epic-a", "epic-b"]);
  });
});

describe("focusCounts", () => {
  it("counts running by the same rule the Running section draws", () => {
    expect(
      focusCounts(
        model({
          tasks: [
            taskRow({
              epicId: "epic-idle",
              agents: [agentRow({ tier: "background" })],
            }),
            taskRow({
              epicId: "epic-busy",
              agents: [agentRow({ tier: "turn" })],
            }),
          ],
          background: [backgroundRow({ epicId: "epic-idle" })],
        }),
      ),
    ).toEqual({ needsYou: 0, running: 1, background: 1, browsers: 0 });
  });

  it("counts a background-only task with no job row of its own as running", () => {
    expect(
      focusCounts(
        model({
          tasks: [
            taskRow({
              epicId: "epic-cold",
              mountedHere: false,
              agents: [agentRow({ tier: "background" })],
            }),
          ],
          background: [backgroundRow({ epicId: "epic-elsewhere" })],
        }),
      ),
    ).toEqual({ needsYou: 0, running: 1, background: 1, browsers: 0 });
  });
});

describe("row states", () => {
  it("maps an agent's tier one to one", () => {
    expect(focusAgentState(agentRow({ tier: "turn" }))).toBe("turn");
    expect(focusAgentState(agentRow({ tier: "background" }))).toBe(
      "background",
    );
  });

  it("reports every job row as running, which is what the builder emits", () => {
    expect(focusJobState(backgroundRow({}))).toBe("running");
    expect(focusJobState(backgroundRow({ kind: "managed-command" }))).toBe(
      "running",
    );
  });

  it.each([
    [
      "a loaded prompt row",
      taskRow({ agents: [agentRow({})] }),
      1,
      "needs-you",
    ],
    [
      "an indicator flag with no loaded row",
      taskRow({ needsYou: true, agents: [agentRow({})] }),
      0,
      "needs-you",
    ],
    [
      "a mid-turn agent",
      taskRow({ agents: [agentRow({ tier: "turn" })] }),
      0,
      "turn",
    ],
    [
      "only background-tier agents",
      taskRow({ agents: [agentRow({ tier: "background" })] }),
      0,
      "background",
    ],
    ["no agent at all", taskRow({ agents: [] }), 0, "waiting"],
  ] as const)(
    "reads a task with %s as `%s`",
    (_label, task, prompts, state) => {
      expect(focusTaskState(task, prompts)).toBe(state);
    },
  );

  it("reads a group with no task row of its own as waiting", () => {
    expect(focusTaskState(null, 0)).toBe("waiting");
  });
});
