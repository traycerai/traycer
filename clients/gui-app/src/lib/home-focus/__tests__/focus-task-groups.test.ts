import { describe, expect, it } from "vitest";
import {
  selectTaskGroupBody,
  selectTaskGroups,
  selectTaskSections,
  taskGroupCounts,
  unattributedPrompts,
  type FocusTaskGroupBody,
} from "@/lib/home-focus/focus-task-groups";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusBrowserRow,
  FocusModel,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

/**
 * The join Home codes against. Everything here is a pure call on a literal
 * model, because the selector's whole job is to be decidable without a store:
 * the counts it produces end up in badges, and a badge that disagrees with the
 * rows under it is the one defect this suite exists to catch.
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
    browserTabTitle: null,
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
    hostId: "host-local",
    label: "dev server",
    kind: "managed-command",
    itemKind: null,
    startedAtMs: null,
    stoppable: true,
    ...overrides,
  };
}

function browserRow(overrides: Partial<FocusBrowserRow>): FocusBrowserRow {
  const tabId = overrides.tabId ?? nextId("tab");
  return {
    key: nextId("browser"),
    epicId: "epic-1",
    taskTitle: "Task",
    hostId: "host-local",
    sessionId: "session-1",
    tabId,
    title: "Checkout",
    urlHost: "example.com",
    url: "https://example.com/checkout",
    status: "live",
    drivenByChatId: null,
    drivenByAgentName: null,
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
    expect(groups[0].prompts.length).toBe(1);
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
    expect(groups[0].prompts.length).toBe(2);
    expect(groups[1].prompts.length).toBe(1);
  });

  // The rule the badge depends on: `needsYou` is also true when the host's
  // indicator flags report a pending prompt the feed has not paged in, so a
  // count derived from it would claim rows the page above cannot show.
  it("reports zero for a task that needsYou with no loaded prompt row", () => {
    const groups = selectTaskGroups(
      model({ tasks: [taskRow({ epicId: "epic-a", needsYou: true })] }),
    );
    expect(groups[0].prompts.length).toBe(0);
    expect(groups[0].task?.needsYou).toBe(true);
  });

  it("groups no prompt whose epicId is null", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" })],
        prompts: [promptRow({ epicId: null }), promptRow({ epicId: "epic-a" })],
      }),
    );
    expect(groups[0].prompts.length).toBe(1);
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
    expect(groups[0].prompts.length).toBe(0);
    // The agents are on the group, unnamed, and the body draws them anyway -
    // see `selectTaskGroupBody nesting`.
    expect(groups[0].agents).toHaveLength(1);
    expect(groups[0].agents[0].title).toBeNull();
  });
});

// Browsers join the union, and the group carries them flat.
describe("selectTaskGroups and browsers", () => {
  it("attaches a task's tabs to its group", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-a" })],
        browsers: [browserRow({ epicId: "epic-a", tabId: "t1" })],
      }),
    );

    expect(groups[0]?.browsers.map((row) => row.tabId)).toEqual(["t1"]);
  });

  it("groups an epic whose only activity is a browser", () => {
    const groups = selectTaskGroups(
      model({ browsers: [browserRow({ epicId: "epic-browser-only" })] }),
    );

    // There is no Browsers section, so an intersection would drop the row
    // silently.
    expect(groups.map((group) => group.epicId)).toEqual(["epic-browser-only"]);
    expect(groups[0]?.task).toBeNull();
    expect(groups[0]?.backgroundVisible).toBe(false);
  });

  it("lists a browser-only epic after the background-only ones", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [taskRow({ epicId: "epic-task" })],
        background: [backgroundRow({ epicId: "epic-job" })],
        browsers: [browserRow({ epicId: "epic-page" })],
      }),
    );

    expect(groups.map((group) => group.epicId)).toEqual([
      "epic-task",
      "epic-job",
      "epic-page",
    ]);
  });

  it("does not list an epic twice when it has both a job and a browser", () => {
    const groups = selectTaskGroups(
      model({
        background: [backgroundRow({ epicId: "epic-both" })],
        browsers: [browserRow({ epicId: "epic-both" })],
      }),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.jobs).toHaveLength(1);
    expect(groups[0]?.browsers).toHaveLength(1);
  });

  // The agent set narrows after the group is built - the cold-task rule and
  // the host split - so nothing here may claim which chat a tab hangs under.
  it("carries plain rows, with no parent resolved before the chats settle", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-a",
            agents: [agentRow({ agentId: "chat-1", title: "Reviewer" })],
          }),
        ],
        browsers: [browserRow({ epicId: "epic-a", drivenByChatId: "chat-1" })],
      }),
    );

    expect(groups[0]?.browsers[0]).not.toHaveProperty("via");
    expect(groups[0]?.agents[0]).not.toHaveProperty("via");
  });
});

describe("unattributedPrompts", () => {
  // The page has no flat prompt list any more, so a prompt that names no task
  // has no group to reach. It is still counted by the tab badge, so losing it
  // would leave a badge over a page showing nothing.
  it("returns the prompts that name no epic, in model order", () => {
    const orphan = promptRow({ epicId: null, key: "orphan" });
    const placed = promptRow({ epicId: "epic-a", key: "placed" });

    expect(
      unattributedPrompts(model({ prompts: [orphan, placed] })).map(
        (row) => row.key,
      ),
    ).toEqual(["orphan"]);
  });
});

describe("selectTaskSections", () => {
  it("files a task with a loaded prompt under Needs you and nowhere else", () => {
    const sections = selectTaskSections(
      selectTaskGroups(
        model({
          tasks: [taskRow({ epicId: "epic-a" }), taskRow({ epicId: "epic-b" })],
          prompts: [promptRow({ epicId: "epic-a" })],
        }),
      ),
    );

    expect(sections.needsYou.map((group) => group.epicId)).toEqual(["epic-a"]);
    expect(sections.running.map((group) => group.epicId)).toEqual(["epic-b"]);
  });

  // The cold case: the host's indicator says a prompt is pending, the feed has
  // not paged its row in. Reading only the rows would file the task under
  // Running and tell the user nothing wants them.
  it("files a task whose indicator says needsYou with no loaded row", () => {
    const sections = selectTaskSections(
      selectTaskGroups(
        model({ tasks: [taskRow({ epicId: "epic-a", needsYou: true })] }),
      ),
    );

    expect(sections.needsYou.map((group) => group.epicId)).toEqual(["epic-a"]);
    expect(sections.running).toEqual([]);
  });

  it("keeps the model's order inside each section", () => {
    const sections = selectTaskSections(
      selectTaskGroups(
        model({
          tasks: [
            taskRow({ epicId: "epic-a", needsYou: true }),
            taskRow({ epicId: "epic-b" }),
            taskRow({ epicId: "epic-c", needsYou: true }),
            taskRow({ epicId: "epic-d" }),
          ],
        }),
      ),
    );

    expect(sections.needsYou.map((group) => group.epicId)).toEqual([
      "epic-a",
      "epic-c",
    ]);
    expect(sections.running.map((group) => group.epicId)).toEqual([
      "epic-b",
      "epic-d",
    ]);
  });

  it("files a background-only group under Running", () => {
    const sections = selectTaskSections(
      selectTaskGroups(
        model({ background: [backgroundRow({ epicId: "epic-idle" })] }),
      ),
    );

    expect(sections.running.map((group) => group.epicId)).toEqual([
      "epic-idle",
    ]);
    expect(sections.needsYou).toEqual([]);
  });
});

describe("selectTaskGroupBody nesting", () => {
  function bodyOf(overrides: Partial<FocusModel>): FocusTaskGroupBody {
    const groups = selectTaskGroups(model(overrides));
    return selectTaskGroupBody(groups[0]);
  }

  it("puts a job under the chat whose id it names, and not at task level", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          agents: [agentRow({ agentId: "chat-1", title: "Monitor host" })],
        }),
      ],
      background: [
        backgroundRow({
          epicId: "epic-a",
          chatId: "chat-1",
          label: "10min heartbeat",
        }),
      ],
    });

    expect(body.chats).toHaveLength(1);
    expect(body.chats[0].jobs.map((job) => job.label)).toEqual([
      "10min heartbeat",
    ]);
    expect(body.jobs).toEqual([]);
  });

  it("leaves a job whose chat is not a row here at task level", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          agents: [agentRow({ agentId: "chat-1" })],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-a", chatId: "chat-gone" })],
    });

    expect(body.chats[0].jobs).toEqual([]);
    expect(body.jobs).toHaveLength(1);
  });

  // The chat that only hosts a monitor IS the parent row. The old
  // rule hid it and listed the monitor beside the other agents, so the page
  // named the conversation twice - once as a row, once as `in <chat>`.
  it("keeps an idle chat that only hosts jobs as the parent row", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          agents: [
            agentRow({
              agentId: "chat-1",
              title: "Greeting",
              tier: "background",
            }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-a", chatId: "chat-1" })],
    });

    expect(body.chats.map((chat) => chat.agent.agentId)).toEqual(["chat-1"]);
    expect(body.chats[0].agent.tier).toBe("background");
    expect(body.chats[0].jobs).toHaveLength(1);
  });

  it("puts a driven tab under its chat and an undriven one at task level", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          agents: [agentRow({ agentId: "chat-1", title: "Reviewer" })],
        }),
      ],
      browsers: [
        browserRow({
          epicId: "epic-a",
          tabId: "driven",
          drivenByChatId: "chat-1",
        }),
        browserRow({ epicId: "epic-a", tabId: "loose", drivenByChatId: null }),
      ],
    });

    expect(body.chats[0].browsers.map((row) => row.tabId)).toEqual(["driven"]);
    expect(body.browsers.map((row) => row.tabId)).toEqual(["loose"]);
  });

  it("leaves a tab whose driver is not a row here at task level", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          agents: [agentRow({ agentId: "chat-1" })],
        }),
      ],
      browsers: [
        browserRow({
          epicId: "epic-a",
          drivenByChatId: "chat-elsewhere",
          // The model resolved a name - the chat IS open in this window - and
          // the tab still hangs off the task, because the row it would sit
          // under is not being drawn.
          drivenByAgentName: "Reviewer",
        }),
      ],
    });

    expect(body.chats[0].browsers).toEqual([]);
    expect(body.browsers).toHaveLength(1);
    // Attribution is a different question from placement, and survives.
    expect(body.browsers[0].drivenByAgentName).toBe("Reviewer");
  });

  it("puts a prompt under the chat it was raised in", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          agents: [agentRow({ agentId: "chat-1", title: "Impl" })],
        }),
      ],
      prompts: [promptRow({ epicId: "epic-a", chatId: "chat-1", key: "p1" })],
    });

    expect(body.chats[0].prompts.map((row) => row.key)).toEqual(["p1"]);
    expect(body.prompts).toEqual([]);
  });

  // A browser hand-off names a session and a tab and never a conversation, so
  // it has no chat to sit under and hangs off the task instead.
  it("puts a chatless prompt at task level", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          agents: [agentRow({ agentId: "chat-1" })],
        }),
      ],
      prompts: [
        promptRow({
          epicId: "epic-a",
          chatId: null,
          kind: "browser",
          key: "p1",
          browserTabTitle: "Checkout",
        }),
      ],
    });

    expect(body.chats[0].prompts).toEqual([]);
    expect(body.prompts.map((row) => row.key)).toEqual(["p1"]);
  });

  // The correction: a cold task's agents used to be dropped here, so the task
  // had no body, its twisty rendered invisible, and the only way to get a
  // chevron was to open the task once and mount it.
  it("keeps a cold task's agents as chats, under names borrowed from nothing", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          mountedHere: false,
          agents: [
            agentRow({ agentId: "chat-1", title: null, surface: null }),
            agentRow({ agentId: "chat-2", title: null, surface: null }),
          ],
        }),
      ],
    });

    expect(body.chats.map((chat) => chat.agent.agentId)).toEqual([
      "chat-1",
      "chat-2",
    ]);
    expect(body.chats.map((chat) => chat.agent.title)).toEqual([null, null]);
  });

  it("buckets a cold task's prompts and jobs under the chat id they name", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          mountedHere: false,
          agents: [agentRow({ agentId: "chat-1", title: null, surface: null })],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-a", chatId: "chat-1" })],
      prompts: [promptRow({ epicId: "epic-a", chatId: "chat-1", key: "p1" })],
    });

    expect(body.chats[0].jobs).toHaveLength(1);
    expect(body.chats[0].prompts.map((row) => row.key)).toEqual(["p1"]);
    expect(body.jobs).toEqual([]);
    expect(body.prompts).toEqual([]);
  });

  // The window-local planes are the only thing a cold task still cannot show,
  // and a row whose chat is not here keeps hanging off the task.
  it("leaves a cold task's job at task level when no agent id matches it", () => {
    const body = bodyOf({
      tasks: [
        taskRow({
          epicId: "epic-a",
          mountedHere: false,
          agents: [agentRow({ agentId: "chat-1", title: null, surface: null })],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-a", chatId: "chat-gone" })],
    });

    expect(body.chats[0].jobs).toEqual([]);
    expect(body.jobs).toHaveLength(1);
  });
});

describe("selectTaskGroupBody via labels", () => {
  function chatsOf(agents: ReadonlyArray<FocusAgentRow>) {
    const groups = selectTaskGroups(
      model({ tasks: [taskRow({ epicId: "epic-a", agents })] }),
    );
    return selectTaskGroupBody(groups[0]).chats;
  }

  it("names the parent for an agent another listed agent started", () => {
    const chats = chatsOf([
      agentRow({ agentId: "root", title: "impl", parentId: null }),
      agentRow({ agentId: "child", title: "reviewer", parentId: "root" }),
    ]);
    expect(chats.map((chat) => chat.via)).toEqual([null, "impl"]);
  });

  // The placeholder a nameless agent borrows is its SURFACE, and `via` reads
  // it out of the same helper the chat row's own name comes from.
  it("names an untitled parent by its surface", () => {
    const chats = chatsOf([
      agentRow({ agentId: "root", title: null, surface: "chat" }),
      agentRow({ agentId: "child", title: "docs", parentId: "root" }),
    ]);
    expect(chats[1].via).toBe("Chat");
  });

  it("falls back to 'Agent' for a parent with no surface either", () => {
    const chats = chatsOf([
      agentRow({ agentId: "root", title: null, surface: null }),
      agentRow({ agentId: "child", title: "docs", parentId: "root" }),
    ]);
    expect(chats[1].via).toBe("Agent");
  });

  // A parent that is not itself a row here is nothing to say "via" about - the
  // task IS what this chat hangs off.
  it("leaves via null when the parent is not listed in the task", () => {
    const chats = chatsOf([
      agentRow({ agentId: "orphan", parentId: "stopped" }),
    ]);
    expect(chats[0].via).toBeNull();
  });

  it("names the immediate parent for a grandchild rather than indenting it", () => {
    const chats = chatsOf([
      agentRow({ agentId: "root", title: "impl" }),
      agentRow({ agentId: "mid", title: "reviewer", parentId: "root" }),
      agentRow({ agentId: "leaf", title: "docs", parentId: "mid" }),
    ]);
    expect(chats.map((chat) => chat.via)).toEqual([null, "impl", "reviewer"]);
  });
});

describe("taskGroupCounts", () => {
  it("counts mid-turn agents as active and every job as bg", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-a",
            agents: [
              agentRow({ agentId: "chat-1", tier: "turn" }),
              agentRow({ agentId: "chat-2", tier: "background" }),
              agentRow({ agentId: "chat-3", tier: "turn" }),
            ],
          }),
        ],
        prompts: [promptRow({ epicId: "epic-a", chatId: "chat-1" })],
        background: [
          backgroundRow({ epicId: "epic-a", chatId: "chat-2", key: "j1" }),
          backgroundRow({ epicId: "epic-a", chatId: "chat-9", key: "j2" }),
        ],
        browsers: [browserRow({ epicId: "epic-a" })],
      }),
    );

    expect(taskGroupCounts(groups[0])).toEqual({
      needsYou: 1,
      active: 2,
      jobs: 2,
      browsers: 1,
    });
  });

  // The badge stands in for the WHOLE subtree, so a job nested under a chat
  // and a job at task level count the same. The body only redistributes rows
  // across levels; it never adds or drops one.
  it("counts the same rows the body spreads over three levels", () => {
    const groups = selectTaskGroups(
      model({
        tasks: [
          taskRow({
            epicId: "epic-a",
            agents: [agentRow({ agentId: "chat-1" })],
          }),
        ],
        background: [
          backgroundRow({ epicId: "epic-a", chatId: "chat-1", key: "nested" }),
          backgroundRow({ epicId: "epic-a", chatId: "chat-x", key: "loose" }),
        ],
      }),
    );
    const body = selectTaskGroupBody(groups[0]);

    expect(body.chats[0].jobs).toHaveLength(1);
    expect(body.jobs).toHaveLength(1);
    expect(taskGroupCounts(groups[0]).jobs).toBe(2);
  });
});
