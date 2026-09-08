import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { HomeFocusView } from "@/components/home-focus/home-focus-view";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusModel,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

const modelMock = vi.hoisted(() => ({ value: null as FocusModel | null }));
vi.mock("@/hooks/home-focus/use-focus-model", () => ({
  useFocusModel: () => modelMock.value,
}));

const actionsMock = vi.hoisted(() => ({
  openPrompt: vi.fn(),
  openAgent: vi.fn(),
  openTask: vi.fn(),
  openBackground: vi.fn(),
  stopAgent: vi.fn(),
  stopManagedCommand: vi.fn(),
  stopping: new Set<string>(),
}));
vi.mock("@/hooks/home-focus/use-focus-actions", () => ({
  useFocusActions: () => actionsMock,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
}));

const tabNavigationMock = vi.hoisted(() => ({ navigateToTabIntent: vi.fn() }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: tabNavigationMock.navigateToTabIntent,
}));

const localHostMock = vi.hoisted(() => ({
  value: null as HostDirectoryEntry | null,
}));
vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => localHostMock.value,
}));

const hostDirectoryEntryMock = vi.hoisted(() => ({
  value: null as HostDirectoryEntry | null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hostDirectoryEntryMock.value,
}));

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function activationRow(
  overrides: Partial<MergedNotificationRow>,
): MergedNotificationRow {
  const feedId = overrides.feedId ?? nextId("activation");
  return {
    feedId,
    source: "host",
    sourceId: feedId,
    createdAt: Date.now(),
    readAt: null,
    title: "Approve: run bun test",
    body: "The agent wants to run a command.",
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
    ...overrides,
  };
}

function promptRow(overrides: Partial<FocusPromptRow>): FocusPromptRow {
  const key = overrides.key ?? nextId("prompt");
  return {
    key,
    kind: "approval",
    epicId: "epic-1",
    chatId: "chat-1",
    taskTitle: "Task title",
    title: "Approve: run bun test",
    body: "The agent wants to run a command.",
    createdAt: Date.now(),
    originHostId: null,
    activation: activationRow({ feedId: key }),
    ...overrides,
  };
}

// `title` defaults to `null` on purpose: that is what a cold epic reports, and
// a fixture defaulting to the literal string "agent" would make the row's
// `?? "agent"` fallback untestable by accident.
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
    taskTitle: "Task title",
    mountedHere: true,
    agents: [agentRow({})],
    needsYou: false,
    stoppable: true,
    ...overrides,
  };
}

function backgroundRow(
  overrides: Partial<FocusBackgroundRow>,
): FocusBackgroundRow {
  const key = overrides.key ?? nextId("background");
  return {
    key,
    epicId: "epic-1",
    chatId: "chat-1",
    taskTitle: "Task title",
    label: "dev server",
    kind: "managed-command",
    startedAtMs: Date.now(),
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

function hostEntry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: overrides.hostId ?? nextId("host"),
    label: "Host",
    kind: "local",
    websocketUrl: null,
    version: null,
    transportDialability: "dialable",
    ...overrides,
  };
}

beforeEach(() => {
  actionsMock.openPrompt.mockReset();
  actionsMock.openAgent.mockReset();
  actionsMock.openTask.mockReset();
  actionsMock.openBackground.mockReset();
  actionsMock.stopAgent.mockReset();
  actionsMock.stopManagedCommand.mockReset();
  actionsMock.stopping.clear();
  navigateMock.mockReset();
  tabNavigationMock.navigateToTabIntent.mockReset();
  localHostMock.value = null;
  hostDirectoryEntryMock.value = null;
  modelMock.value = null;
});

afterEach(() => {
  cleanup();
});

describe("<HomeFocusView /> section presence", () => {
  it("renders all three sections when every list is populated", () => {
    modelMock.value = model({
      prompts: [promptRow({})],
      tasks: [taskRow({})],
      background: [backgroundRow({})],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-section-prompts")).toBeDefined();
    expect(screen.getByTestId("home-focus-section-tasks")).toBeDefined();
    expect(screen.getByTestId("home-focus-section-background")).toBeDefined();
    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
  });

  it("omits the prompts section when there are no prompts, keeping the others", () => {
    modelMock.value = model({
      prompts: [],
      tasks: [taskRow({})],
      background: [backgroundRow({})],
      badgeCount: 0,
    });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-section-prompts")).toBeNull();
    expect(screen.getByTestId("home-focus-section-tasks")).toBeDefined();
    expect(screen.getByTestId("home-focus-section-background")).toBeDefined();
  });

  it("renders only the empty state when all three lists are empty", () => {
    modelMock.value = model({});
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-empty")).toBeDefined();
    expect(screen.queryByTestId("home-focus-section-prompts")).toBeNull();
    expect(screen.queryByTestId("home-focus-section-tasks")).toBeNull();
    expect(screen.queryByTestId("home-focus-section-background")).toBeNull();
  });
});

describe("<HomeFocusView /> section headers", () => {
  it("reads 'Needs you · 2' for two prompts", () => {
    modelMock.value = model({
      prompts: [promptRow({}), promptRow({})],
      badgeCount: 2,
    });
    render(<HomeFocusView />);
    const heading = within(
      screen.getByTestId("home-focus-section-prompts"),
    ).getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Needs you · 2");
  });

  it("reads 'Running · 3 tasks' for three tasks", () => {
    modelMock.value = model({
      tasks: [taskRow({}), taskRow({}), taskRow({})],
    });
    render(<HomeFocusView />);
    const heading = within(
      screen.getByTestId("home-focus-section-tasks"),
    ).getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Running · 3 tasks");
  });

  it("reads 'Running · 1 task' (singular) for one task", () => {
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);
    const heading = within(
      screen.getByTestId("home-focus-section-tasks"),
    ).getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Running · 1 task");
    expect(heading.textContent).not.toContain("1 tasks");
  });

  it("reads 'Background · 2' with the fixed caption", () => {
    modelMock.value = model({
      background: [backgroundRow({}), backgroundRow({})],
    });
    render(<HomeFocusView />);
    const heading = within(
      screen.getByTestId("home-focus-section-background"),
    ).getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Background · 2");
    expect(
      screen.getByTestId("home-focus-section-background-caption").textContent,
    ).toBe("Only tasks open in this window");
  });
});

describe("<HomeFocusView /> row ordering", () => {
  it("renders prompt rows in the model's array order", () => {
    modelMock.value = model({
      prompts: [
        promptRow({ title: "First prompt" }),
        promptRow({ title: "Second prompt" }),
        promptRow({ title: "Third prompt" }),
      ],
      badgeCount: 3,
    });
    render(<HomeFocusView />);
    const rows = screen.getAllByTestId("home-focus-prompt-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("First prompt"),
      expect.stringContaining("Second prompt"),
      expect.stringContaining("Third prompt"),
    ]);
  });

  it("renders task rows in the model's array order", () => {
    modelMock.value = model({
      tasks: [
        taskRow({ taskTitle: "Alpha task" }),
        taskRow({ taskTitle: "Beta task" }),
        taskRow({ taskTitle: "Gamma task" }),
      ],
    });
    render(<HomeFocusView />);
    const rows = screen.getAllByTestId("home-focus-task-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Alpha task"),
      expect.stringContaining("Beta task"),
      expect.stringContaining("Gamma task"),
    ]);
  });
});

describe("<HomeFocusView /> prompt row actions", () => {
  it("calls openPrompt with the exact row from the body button and the explicit Open button", () => {
    const row = promptRow({});
    modelMock.value = model({ prompts: [row], badgeCount: 1 });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-prompt-open-body"));
    expect(actionsMock.openPrompt).toHaveBeenCalledTimes(1);
    expect(actionsMock.openPrompt).toHaveBeenNthCalledWith(1, row);

    fireEvent.click(screen.getByTestId("home-focus-prompt-open"));
    expect(actionsMock.openPrompt).toHaveBeenCalledTimes(2);
    expect(actionsMock.openPrompt).toHaveBeenNthCalledWith(2, row);
  });
});

describe("<HomeFocusView /> open actions", () => {
  it("opens the task from the task row's body and its Open button", () => {
    modelMock.value = model({ tasks: [taskRow({ epicId: "epic-open" })] });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-open-body"));
    fireEvent.click(screen.getByTestId("home-focus-task-open"));
    expect(actionsMock.openTask).toHaveBeenCalledTimes(2);
    expect(actionsMock.openTask).toHaveBeenNthCalledWith(1, "epic-open");
    expect(actionsMock.openTask).toHaveBeenNthCalledWith(2, "epic-open");
  });

  it("opens the owning chat from a background row's body and Open button", () => {
    const row = backgroundRow({
      epicId: "epic-background",
      chatId: "chat-background",
    });
    modelMock.value = model({ background: [row] });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-background-open-body"));
    fireEvent.click(screen.getByTestId("home-focus-background-open"));
    expect(actionsMock.openBackground).toHaveBeenCalledTimes(2);
    expect(actionsMock.openBackground).toHaveBeenNthCalledWith(1, row);
    expect(actionsMock.openBackground).toHaveBeenNthCalledWith(2, row);
    // The chat is the target, so the row never falls back to its task.
    expect(actionsMock.openTask).not.toHaveBeenCalled();
  });
});

describe("<HomeFocusView /> task row stop controls", () => {
  it("stops a single agent directly, cascading, with no confirmation dialog", () => {
    const row = taskRow({
      epicId: "epic-solo",
      agents: [agentRow({ agentId: "agent-solo" })],
    });
    modelMock.value = model({ tasks: [row] });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-task-stop-all")).toBeNull();
    fireEvent.click(screen.getByTestId("home-focus-task-stop"));

    expect(actionsMock.stopAgent).toHaveBeenCalledTimes(1);
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-solo",
      agentId: "agent-solo",
      hostId: null,
      cascade: true,
    });
    expect(screen.queryByTestId("home-focus-stop-all-dialog")).toBeNull();
  });

  it("stops only the ROOT once when the task lists a parent and its children", () => {
    const agents = [
      agentRow({
        agentId: "root",
        title: "impl",
        parentId: null,
        hostId: "host-tree",
      }),
      agentRow({ agentId: "child-a", title: "reviewer", parentId: "root" }),
      agentRow({ agentId: "child-b", title: "docs", parentId: "root" }),
    ];
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-tree", agents })],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    // The dialog still names everything that goes down, not just the root.
    const dialog = screen.getByTestId("home-focus-stop-all-dialog");
    for (const agent of agents) {
      expect(within(dialog).getByText(agent.title ?? "agent")).toBeDefined();
    }

    fireEvent.click(screen.getByTestId("home-focus-stop-all-confirm"));
    expect(actionsMock.stopAgent).toHaveBeenCalledTimes(1);
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-tree",
      agentId: "root",
      hostId: "host-tree",
      cascade: true,
    });
  });

  it("stops each independent root once when a parent is not itself listed", () => {
    const agents = [
      agentRow({ agentId: "root-a", title: "impl", parentId: null }),
      // Parented by an agent that is not running, so it is a root here.
      agentRow({ agentId: "root-b", title: "docs", parentId: "not-listed" }),
      agentRow({ agentId: "child", title: "reviewer", parentId: "root-a" }),
    ];
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-forest", agents })],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    fireEvent.click(screen.getByTestId("home-focus-stop-all-confirm"));

    expect(actionsMock.stopAgent).toHaveBeenCalledTimes(2);
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-forest",
      agentId: "root-a",
      hostId: null,
      cascade: true,
    });
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-forest",
      agentId: "root-b",
      hostId: null,
      cascade: true,
    });
  });

  it("stopping several agents goes through a confirmation dialog listing every agent", () => {
    const agents = [
      agentRow({ agentId: "agent-a", title: "impl" }),
      agentRow({ agentId: "agent-b", title: "reviewer" }),
      agentRow({ agentId: "agent-c", title: "docs" }),
    ];
    const row = taskRow({ epicId: "epic-multi", agents });
    modelMock.value = model({ tasks: [row] });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-task-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));

    const dialog = screen.getByTestId("home-focus-stop-all-dialog");
    expect(dialog).toBeDefined();
    for (const agent of agents) {
      expect(within(dialog).getByText(agent.title ?? "agent")).toBeDefined();
    }

    fireEvent.click(screen.getByTestId("home-focus-stop-all-confirm"));
    expect(actionsMock.stopAgent).toHaveBeenCalledTimes(3);
    for (const agent of agents) {
      expect(actionsMock.stopAgent).toHaveBeenCalledWith({
        epicId: "epic-multi",
        agentId: agent.agentId,
        hostId: agent.hostId,
        cascade: true,
      });
    }
  });

  it("cancelling the stop-all dialog closes it and calls nothing", () => {
    const agents = [
      agentRow({ agentId: "agent-a", title: "impl" }),
      agentRow({ agentId: "agent-b", title: "reviewer" }),
    ];
    const row = taskRow({ epicId: "epic-multi", agents });
    modelMock.value = model({ tasks: [row] });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    expect(screen.getByTestId("home-focus-stop-all-dialog")).toBeDefined();

    fireEvent.click(screen.getByTestId("home-focus-stop-all-cancel"));
    expect(screen.queryByTestId("home-focus-stop-all-dialog")).toBeNull();
    expect(actionsMock.stopAgent).not.toHaveBeenCalled();
  });
});

describe("<HomeFocusView /> task row agent presentation", () => {
  it("shows cold-agent summary with no chips when the task is not mounted here", () => {
    const row = taskRow({
      mountedHere: false,
      agents: [agentRow({}), agentRow({})],
    });
    modelMock.value = model({ tasks: [row] });
    render(<HomeFocusView />);

    const cold = screen.getByTestId("home-focus-cold-agents");
    expect(cold.textContent).toContain("2 agents");
    expect(cold.textContent).toContain("not open in this window");
    expect(screen.queryByTestId("home-focus-agent-chip")).toBeNull();
  });

  it("shows one chip per agent when mounted, and clicking a chip opens the agent", () => {
    const agents = [
      agentRow({ agentId: "agent-x", title: "impl", tier: "turn" }),
      agentRow({ agentId: "agent-y", title: "reviewer", tier: "background" }),
    ];
    const row = taskRow({
      epicId: "epic-mounted",
      mountedHere: true,
      agents,
    });
    modelMock.value = model({ tasks: [row] });
    render(<HomeFocusView />);

    const chips = screen.getAllByTestId("home-focus-agent-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain("impl");
    expect(chips[0].textContent).toContain("turn");
    expect(chips[1].textContent).toContain("reviewer");
    expect(chips[1].textContent).toContain("background");

    fireEvent.click(chips[0]);
    expect(actionsMock.openAgent).toHaveBeenCalledWith(
      "epic-mounted",
      "agent-x",
    );
  });

  it("falls back to 'agent' for a chip whose title is null", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          mountedHere: true,
          agents: [agentRow({ agentId: "agent-nameless", title: null })],
        }),
      ],
    });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-agent-chip").textContent).toContain(
      "agent",
    );
  });
});

describe("<HomeFocusView /> task row stop availability", () => {
  it("disables Stop with a reason when the task is not stoppable", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          stoppable: false,
          agents: [agentRow({ agentId: "agent-remote" })],
        }),
      ],
    });
    render(<HomeFocusView />);

    const stop = screen.getByTestId("home-focus-task-stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    fireEvent.click(stop);
    expect(actionsMock.stopAgent).not.toHaveBeenCalled();
    // The reason rides the accessible name, not only the hover tooltip.
    expect(stop.getAttribute("aria-label")).toContain("Runs on another device");
  });

  it("disables Stop while that agent's stop is in flight", () => {
    actionsMock.stopping.add("agent-busy");
    modelMock.value = model({
      tasks: [taskRow({ agents: [agentRow({ agentId: "agent-busy" })] })],
    });
    render(<HomeFocusView />);

    const stop = screen.getByTestId("home-focus-task-stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    fireEvent.click(stop);
    expect(actionsMock.stopAgent).not.toHaveBeenCalled();
  });

  it("disables Stop all while a root it would call is in flight", () => {
    actionsMock.stopping.add("root");
    modelMock.value = model({
      tasks: [
        taskRow({
          agents: [
            agentRow({ agentId: "root", parentId: null }),
            agentRow({ agentId: "other-root", parentId: null }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);

    const stopAll = screen.getByTestId("home-focus-task-stop-all");
    expect(stopAll.hasAttribute("disabled")).toBe(true);
    fireEvent.click(stopAll);
    expect(screen.queryByTestId("home-focus-stop-all-dialog")).toBeNull();
  });

  it("leaves Stop all enabled when only a DESCENDANT it never calls is in flight", () => {
    actionsMock.stopping.add("child");
    modelMock.value = model({
      tasks: [
        taskRow({
          agents: [
            agentRow({ agentId: "root", parentId: null }),
            agentRow({ agentId: "child", parentId: "root" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    expect(
      screen.getByTestId("home-focus-task-stop-all").hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("<HomeFocusView /> row structure", () => {
  it.each([
    ["home-focus-prompt-open-body", "home-focus-prompt-open"],
    ["home-focus-task-open-body", "home-focus-task-stop"],
    ["home-focus-background-open-body", "home-focus-background-stop"],
  ])(
    "keeps %s's trailing control a sibling, not a descendant",
    (body, control) => {
      modelMock.value = model({
        prompts: [promptRow({})],
        tasks: [taskRow({})],
        background: [backgroundRow({})],
        badgeCount: 1,
      });
      render(<HomeFocusView />);

      const bodyEl = screen.getByTestId(body);
      expect(bodyEl.tagName).toBe("BUTTON");
      expect(bodyEl.contains(screen.getByTestId(control))).toBe(false);
    },
  );
});

describe("<HomeFocusView /> prompt glyphs", () => {
  it.each([
    ["approval", "text-warning-foreground"],
    ["interview", "text-warning-foreground"],
    ["browser", "text-warning-foreground"],
  ] as const)("renders a glyph for a %s prompt", (kind, toneClass) => {
    modelMock.value = model({
      prompts: [promptRow({ kind })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    const glyph = screen.getByTestId("home-focus-prompt-glyph");
    expect(glyph.getAttribute("class")).toContain(toneClass);
  });

  it("gives approval and interview prompts different glyphs", () => {
    modelMock.value = model({
      prompts: [
        promptRow({ kind: "approval" }),
        promptRow({ kind: "interview" }),
        promptRow({ kind: "browser" }),
      ],
      badgeCount: 3,
    });
    render(<HomeFocusView />);
    const shapes = screen
      .getAllByTestId("home-focus-prompt-glyph")
      .map((glyph) => glyph.innerHTML);
    expect(new Set(shapes).size).toBe(3);
  });
});

describe("<HomeFocusView /> task attention", () => {
  it("renders the attention glyph when needsYou is true", () => {
    modelMock.value = model({ tasks: [taskRow({ needsYou: true })] });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-task-attention")).toBeDefined();
  });

  it("does not render the attention glyph when needsYou is false", () => {
    modelMock.value = model({ tasks: [taskRow({ needsYou: false })] });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-task-attention")).toBeNull();
  });
});

describe("<HomeFocusView /> empty state", () => {
  it("navigates to a new draft from 'Start a new task'", () => {
    modelMock.value = model({});
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-empty-new-task"));
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledWith(
      navigateMock,
      { kind: "new-draft", settings: null },
      undefined,
    );
  });

  it("navigates to history from 'Open History'", () => {
    modelMock.value = model({});
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-empty-history"));
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledWith(
      navigateMock,
      { kind: "history" },
      undefined,
    );
  });
});

describe("<HomeFocusView /> coverage notices", () => {
  it.each(["disconnected", "reconnecting"] as const)(
    "renders the activity notice when coverage.activity is %s",
    (activity) => {
      modelMock.value = model({
        tasks: [taskRow({})],
        coverage: {
          activity,
          notifications: "cloud",
          backgroundIsMountedOnly: true,
        },
      });
      render(<HomeFocusView />);
      const notice = screen.getByTestId("home-focus-activity-notice");
      expect(notice).toBeDefined();
      expect(notice.getAttribute("data-activity")).toBe(activity);
    },
  );

  it.each(["live", "unknown"] as const)(
    "does not render the activity notice when coverage.activity is %s",
    (activity) => {
      modelMock.value = model({
        tasks: [taskRow({})],
        coverage: {
          activity,
          notifications: "cloud",
          backgroundIsMountedOnly: true,
        },
      });
      render(<HomeFocusView />);
      expect(screen.queryByTestId("home-focus-activity-notice")).toBeNull();
    },
  );

  it("shows the 'this host only' caption in the Needs-you header when notifications are local", () => {
    modelMock.value = model({
      prompts: [promptRow({})],
      badgeCount: 1,
      coverage: {
        activity: "live",
        notifications: "local",
        backgroundIsMountedOnly: true,
      },
    });
    render(<HomeFocusView />);
    expect(
      screen.getByTestId("home-focus-section-prompts-caption").textContent,
    ).toBe("this host only");
  });

  it("omits the caption in the Needs-you header when notifications are cloud", () => {
    modelMock.value = model({
      prompts: [promptRow({})],
      badgeCount: 1,
      coverage: {
        activity: "live",
        notifications: "cloud",
        backgroundIsMountedOnly: true,
      },
    });
    render(<HomeFocusView />);
    expect(
      screen.queryByTestId("home-focus-section-prompts-caption"),
    ).toBeNull();
  });
});

describe("<HomeFocusView /> badge parity", () => {
  it("badgeCount equals the number of rendered prompt rows", () => {
    const prompts = [promptRow({}), promptRow({}), promptRow({})];
    modelMock.value = model({ prompts, badgeCount: prompts.length });
    render(<HomeFocusView />);
    expect(screen.getAllByTestId("home-focus-prompt-row")).toHaveLength(
      modelMock.value.badgeCount,
    );
  });
});

describe("<HomeFocusView /> relative time ticking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("repaints the same DOM node from 'Just now' to '1m ago' on the shared clock tick", () => {
    vi.useFakeTimers();
    const base = Date.now();
    const row = promptRow({ createdAt: base - 30_000 });
    modelMock.value = model({ prompts: [row], badgeCount: 1 });
    render(<HomeFocusView />);

    const timeNode = screen.getByTestId("home-focus-relative-time");
    expect(timeNode.textContent).toBe("Just now");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const timeNodeAfter = screen.getByTestId("home-focus-relative-time");
    expect(timeNodeAfter).toBe(timeNode);
    expect(timeNodeAfter.textContent).toBe("1m ago");
  });
});

describe("<HomeFocusView /> live model updates without remount", () => {
  it("reuses the same task row DOM node when the model updates in place", () => {
    const initialTask = taskRow({
      epicId: "epic-stable",
      agents: [agentRow({ agentId: "agent-1" })],
    });
    modelMock.value = model({ tasks: [initialTask] });
    const { rerender } = render(<HomeFocusView />);

    const rowBefore = screen.getByTestId("home-focus-task-row");

    const updatedTask = taskRow({
      epicId: "epic-stable",
      agents: [
        agentRow({ agentId: "agent-1" }),
        agentRow({ agentId: "agent-2" }),
      ],
    });
    modelMock.value = model({ tasks: [updatedTask] });
    rerender(<HomeFocusView />);

    const rowAfter = screen.getByTestId("home-focus-task-row");
    expect(rowAfter).toBe(rowBefore);
    expect(screen.getAllByTestId("home-focus-agent-chip")).toHaveLength(2);
  });
});

describe("<HomeFocusView /> background rows", () => {
  it("renders the label and elapsed running duration", () => {
    const startedAtMs = Date.now() - 41 * 60_000;
    modelMock.value = model({
      background: [backgroundRow({ label: "dev server", startedAtMs })],
    });
    render(<HomeFocusView />);
    expect(
      screen.getByTestId("home-focus-background-row").textContent,
    ).toContain("dev server");
    expect(screen.getByTestId("home-focus-running-duration").textContent).toBe(
      "running 41m",
    );
  });

  it("shows a stop button when stoppable and calls stopManagedCommand with the row", () => {
    const row = backgroundRow({ stoppable: true });
    modelMock.value = model({ background: [row] });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-background-stop"));
    expect(actionsMock.stopManagedCommand).toHaveBeenCalledWith(row);
  });

  it("renders a disabled stop with a reason when the job is not stoppable", () => {
    modelMock.value = model({
      background: [backgroundRow({ stoppable: false })],
    });
    render(<HomeFocusView />);

    const stop = screen.getByTestId("home-focus-background-stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    fireEvent.click(stop);
    expect(actionsMock.stopManagedCommand).not.toHaveBeenCalled();
    expect(stop.getAttribute("aria-label")).toContain("Runs on another device");
  });

  it("disables the stop while this job's stop is in flight", () => {
    const row = backgroundRow({ stoppable: true });
    actionsMock.stopping.add(row.key);
    modelMock.value = model({ background: [row] });
    render(<HomeFocusView />);

    const stop = screen.getByTestId("home-focus-background-stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    fireEvent.click(stop);
    expect(actionsMock.stopManagedCommand).not.toHaveBeenCalled();
  });

  it("renders no duration for a background item with no start time", () => {
    modelMock.value = model({
      background: [
        backgroundRow({ kind: "background-item", startedAtMs: null }),
      ],
    });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-running-duration")).toBeNull();
  });

  it("reads 'just started' under a minute rather than 'running now'", () => {
    modelMock.value = model({
      background: [backgroundRow({ startedAtMs: Date.now() - 5_000 })],
    });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-running-duration").textContent).toBe(
      "just started",
    );
  });
});

describe("<HomeFocusView /> untitled task", () => {
  it("renders 'Untitled task' when taskTitle is null", () => {
    modelMock.value = model({ tasks: [taskRow({ taskTitle: null })] });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-task-row").textContent).toContain(
      "Untitled task",
    );
  });
});

describe("<HomeFocusView /> origin host chip", () => {
  it("shows the origin host's label when it differs from the local host", () => {
    localHostMock.value = hostEntry({ hostId: "host-local" });
    hostDirectoryEntryMock.value = hostEntry({
      hostId: "host-remote",
      label: "Remote Box",
    });
    const row = promptRow({ originHostId: "host-remote" });
    modelMock.value = model({ prompts: [row], badgeCount: 1 });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-origin-host").textContent).toBe(
      "Remote Box",
    );
  });

  it("hides the chip when the origin host is the local host", () => {
    localHostMock.value = hostEntry({ hostId: "host-local" });
    hostDirectoryEntryMock.value = hostEntry({ hostId: "host-local" });
    const row = promptRow({ originHostId: "host-local" });
    modelMock.value = model({ prompts: [row], badgeCount: 1 });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-origin-host")).toBeNull();
  });

  it("hides the chip on a build with no local host, even with an origin host", () => {
    localHostMock.value = null;
    hostDirectoryEntryMock.value = hostEntry({
      hostId: "host-remote",
      label: "Remote Box",
    });
    const row = promptRow({ originHostId: "host-remote" });
    modelMock.value = model({ prompts: [row], badgeCount: 1 });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-origin-host")).toBeNull();
  });

  it("falls back to 'another host' when the directory does not know the origin", () => {
    localHostMock.value = hostEntry({ hostId: "host-local" });
    hostDirectoryEntryMock.value = null;
    const row = promptRow({ originHostId: "host-unknown" });
    modelMock.value = model({ prompts: [row], badgeCount: 1 });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-origin-host").textContent).toBe(
      "another host",
    );
  });
});
