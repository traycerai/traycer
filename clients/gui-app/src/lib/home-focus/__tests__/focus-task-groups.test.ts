import { describe, expect, it } from "vitest";
import { selectTaskGroups } from "@/lib/home-focus/focus-task-groups";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusModel,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

/**
 * The join the Tasks view codes against. Everything here is a pure call on a
 * literal model, because the selector's whole job is to be decidable without a
 * store: the counts it produces end up in badges, and a badge that disagrees
 * with the section above it is the one defect this suite exists to catch.
 */

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Only `feedId` is read by anything under test; the rest is the row shape. */
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
    label: "dev server",
    kind: "managed-command",
    itemKind: null,
    startedAtMs: null,
    stoppable: true,
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
      notifications: "cloud",
      backgroundIsMountedOnly: true,
    },
    badgeCount: 0,
    ...overrides,
  };
}

describe("selectTaskGroups shape", () => {
  it("emits one group per task, in the model's order", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({ epicId: "epic-a", taskTitle: "Alpha" }),
          taskRow({ epicId: "epic-b", taskTitle: "Beta" }),
        ],
      }),
    );
    expect(groups.map((group) => group.epicId)).toEqual(["epic-a", "epic-b"]);
  });

  // `model.tasks` covers epics with a running agent, `model.background` covers
  // epics with a warm chat, and the two are not nested. Tasks view has no
  // Background section to catch the difference, so the grouping takes the
  // UNION - otherwise a durable shell in an idle chat is a row with nowhere to
  // go, and on an idle account the page is blank.
  it("gives an epic that is here on its background work alone its own group", () => {
    const job = backgroundRow({
      epicId: "epic-idle",
      taskTitle: "Idle task",
      label: "bun run dev",
    });
    const groups = selectTaskGroups(model({ tasks: [], background: [job] }));

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBe("epic-idle");
    expect(groups[0].taskTitle).toBe("Idle task");
    // `null` is the whole signal: no running agent, nothing to stop, and no
    // attention flags of its own.
    expect(groups[0].task).toBeNull();
    expect(groups[0].agents).toEqual([]);
    expect(groups[0].jobs).toEqual([job]);
    expect(groups[0].backgroundVisible).toBe(true);
  });

  it("puts task groups first and background-only epics after, in their own orders", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" }), taskRow({ epicId: "epic-b" })],
        background: [
          backgroundRow({ epicId: "epic-b", key: "job-b" }),
          backgroundRow({ epicId: "epic-idle-2", key: "job-2" }),
          backgroundRow({ epicId: "epic-idle-1", key: "job-1" }),
        ],
      }),
    );

    expect(groups.map((group) => group.epicId)).toEqual([
      "epic-a",
      "epic-b",
      "epic-idle-2",
      "epic-idle-1",
    ]);
    expect(groups.map((group) => group.task === null)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("counts a background-only epic's own prompts under it", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [],
        prompts: [promptRow({ epicId: "epic-idle" })],
        background: [backgroundRow({ epicId: "epic-idle" })],
      }),
    );
    expect(groups[0].promptCount).toBe(1);
  });

  it("adds no epic that neither a task nor a job names", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" })],
        // A prompt alone never mints a group - it is actionable in the Needs
        // you section and has no running work to group.
        prompts: [promptRow({ epicId: "epic-prompt-only" })],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBe("epic-a");
  });
});

describe("selectTaskGroups prompt counts", () => {
  it("counts the loaded prompt rows that name the task", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" }), taskRow({ epicId: "epic-b" })],
        prompts: [
          promptRow({ epicId: "epic-a" }),
          promptRow({ epicId: "epic-a" }),
          promptRow({ epicId: "epic-b" }),
        ],
      }),
    );
    expect(groups[0].promptCount).toBe(2);
    expect(groups[1].promptCount).toBe(1);
  });

  // The rule the badge depends on: `needsYou` is also true when the host's
  // indicator flags report a pending prompt the feed has not paged in, so a
  // count derived from it would claim rows the page above cannot show.
  it("reports zero for a task that needsYou with no loaded prompt row", () => {
    const groups = selectTaskGroups(
      model({ tasks: [taskRow({ epicId: "epic-a", needsYou: true })] }),
    );
    expect(groups[0].promptCount).toBe(0);
    expect(groups[0].task?.needsYou).toBe(true);
  });

  it("groups no prompt whose epicId is null", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" })],
        prompts: [promptRow({ epicId: null }), promptRow({ epicId: "epic-a" })],
      }),
    );
    expect(groups[0].promptCount).toBe(1);
  });
});

describe("selectTaskGroups jobs", () => {
  it("joins the background rows that name the task and no others", () => {
    const mine = backgroundRow({ epicId: "epic-a", label: "mine" });
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" }), taskRow({ epicId: "epic-b" })],
        background: [mine, backgroundRow({ epicId: "epic-b" })],
      }),
    );
    expect(groups[0].jobs).toEqual([mine]);
    expect(groups[1].jobs).toHaveLength(1);
  });

  // `backgroundVisible` is the question the `N bg` badge asks, and it is NOT
  // `mountedHere`: that one is "has a live Y.Doc projection in this window",
  // and jobs come from warm chat SESSIONS, which is narrower. A mounted task
  // whose chats were never opened must not read "0 bg".
  it("reports background invisible for a mounted task with no warm chat here", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a", mountedHere: true })],
        background: [backgroundRow({ epicId: "epic-other" })],
      }),
    );
    expect(groups[0].task?.mountedHere).toBe(true);
    expect(groups[0].jobs).toEqual([]);
    expect(groups[0].backgroundVisible).toBe(false);
  });

  it("reports background visible for a task that contributed warm-chat rows", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" })],
        background: [backgroundRow({ epicId: "epic-a" })],
      }),
    );
    expect(groups[0].backgroundVisible).toBe(true);
  });

  it("leaves a cold task with no jobs and no agent names", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-cold",
            mountedHere: false,
            agents: [agentRow({ title: null, surface: null })],
          }),
        ],
        // Background only ever covers chats warm in this window, so a cold
        // task has nothing here to join to.
        background: [backgroundRow({ epicId: "epic-warm" })],
      }),
    );
    expect(groups[0].jobs).toEqual([]);
    expect(groups[0].backgroundVisible).toBe(false);
    expect(groups[0].promptCount).toBe(0);
    expect(groups[0].agents).toHaveLength(1);
    expect(groups[0].agents[0].via).toBeNull();
    expect(groups[0].agents[0].agent.title).toBeNull();
  });
});

describe("selectTaskGroups via labels", () => {
  it("names the parent for an agent another listed agent started", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-a",
            agents: [
              agentRow({ agentId: "root", title: "impl", parentId: null }),
              agentRow({
                agentId: "child",
                title: "reviewer",
                parentId: "root",
              }),
            ],
          }),
        ],
      }),
    );
    expect(groups[0].agents.map((entry) => entry.via)).toEqual([null, "impl"]);
  });

  it("falls back to 'agent' when the parent has no known title", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-a",
            agents: [
              agentRow({ agentId: "root", title: null }),
              agentRow({ agentId: "child", title: "docs", parentId: "root" }),
            ],
          }),
        ],
      }),
    );
    expect(groups[0].agents[1].via).toBe("agent");
  });

  // A parent that is not itself running is not a row on this page, so there is
  // nothing to say "via" about - the task IS what this agent hangs off.
  it("leaves via null when the parent is not listed in the task", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-a",
            agents: [agentRow({ agentId: "orphan", parentId: "stopped" })],
          }),
        ],
      }),
    );
    expect(groups[0].agents[0].via).toBeNull();
  });

  it("names the immediate parent for a grandchild rather than indenting it", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-a",
            agents: [
              agentRow({ agentId: "root", title: "impl" }),
              agentRow({ agentId: "mid", title: "reviewer", parentId: "root" }),
              agentRow({ agentId: "leaf", title: "docs", parentId: "mid" }),
            ],
          }),
        ],
      }),
    );
    expect(groups[0].agents.map((entry) => entry.via)).toEqual([
      null,
      "impl",
      "reviewer",
    ]);
  });
});
