import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import {
  DEFAULT_HOME_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { ROW_CLASS } from "@/components/home-focus/home-focus-row-style";

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

// The REAL `trackSettingChanged`, spied rather than replaced, so a call still
// has to survive the runtime allowlist that `sanitizeAnalyticsProperties`
// gates - a setting id that only exists in the type drops silently otherwise.
vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    trackSettingChanged: vi.fn(actual.trackSettingChanged),
  };
});

async function expectSettingIdAccepted(setting: string): Promise<void> {
  const { AnalyticsEvent, sanitizeAnalyticsProperties } =
    await import("@/lib/analytics");
  expect(
    sanitizeAnalyticsProperties(AnalyticsEvent.SettingChanged, {
      source: "direct_ui",
      section: "layout",
      setting,
    }),
  ).toEqual({ source: "direct_ui", section: "layout", setting });
}

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
    chatTitle: "Chat title",
    label: "dev server",
    kind: "managed-command",
    itemKind: null,
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

/** The element a row's tooltip is anchored to: `FocusStopButton` wraps its
 * button in a span, because a disabled button fires no pointer events of its
 * own. */
function tooltipTriggerOf(control: HTMLElement): HTMLElement {
  const trigger = control.parentElement;
  if (trigger === null) throw new Error("control has no tooltip trigger");
  return trigger;
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
  useLayoutStore.setState({ home: DEFAULT_HOME_LAYOUT });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ home: DEFAULT_HOME_LAYOUT });
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
  it("calls openPrompt with the exact row from the row body", () => {
    const row = promptRow({});
    modelMock.value = model({ prompts: [row], badgeCount: 1 });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-prompt-open-body"));
    expect(actionsMock.openPrompt).toHaveBeenCalledTimes(1);
    expect(actionsMock.openPrompt).toHaveBeenNthCalledWith(1, row);
  });
});

describe("<HomeFocusView /> open actions", () => {
  it("opens the task from the task row's body", () => {
    modelMock.value = model({ tasks: [taskRow({ epicId: "epic-open" })] });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-open-body"));
    expect(actionsMock.openTask).toHaveBeenCalledTimes(1);
    expect(actionsMock.openTask).toHaveBeenNthCalledWith(1, "epic-open");
  });

  it("opens the owning chat from a background row's body", () => {
    const row = backgroundRow({
      epicId: "epic-background",
      chatId: "chat-background",
    });
    modelMock.value = model({ background: [row] });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-background-open-body"));
    expect(actionsMock.openBackground).toHaveBeenCalledTimes(1);
    expect(actionsMock.openBackground).toHaveBeenNthCalledWith(1, row);
    // The chat is the target, so the row never falls back to its task.
    expect(actionsMock.openTask).not.toHaveBeenCalled();
  });
});

// The duplicate trailing control is gone from every row shape in both views:
// the row body already spans the card and opens the same thing, so the second
// control was one extra tab stop per row saying a verb the row had offered.
describe("<HomeFocusView /> has no trailing Open button", () => {
  it.each(["focus", "tasks"] as const)(
    "renders no Open control anywhere in the %s view",
    (view) => {
      useLayoutStore.setState({ home: { view, density: "comfortable" } });
      modelMock.value = model({
        prompts: [promptRow({ epicId: "epic-1" })],
        tasks: [taskRow({ epicId: "epic-1" })],
        background: [backgroundRow({ epicId: "epic-1" })],
        badgeCount: 1,
      });
      render(<HomeFocusView />);

      expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
      expect(screen.queryByText("Open")).toBeNull();
      for (const testId of [
        "home-focus-prompt-open",
        "home-focus-task-open",
        "home-focus-background-open",
      ]) {
        expect(screen.queryByTestId(testId)).toBeNull();
      }
    },
  );
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

// The Tasks view's group row is the first row in this family with THREE
// controls and the first with one BEFORE the body button. jsdom has no layout
// and no hit testing, so nothing here can prove the twisty is clickable - what
// it pins is the structure that decides whether it is: the three are mutually
// non-descendant, they come out in reading order, and the
// leading control carries the `z-10` that lifts it over the body's stretched
// overlay (bare `relative` ties on paint order and loses, because the overlay
// belongs to a LATER sibling).
describe("<HomeFocusView /> task group row structure", () => {
  function renderGroupRow(): HTMLElement {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({ epicId: "epic-1", agents: [agentRow({}), agentRow({})] }),
      ],
    });
    render(<HomeFocusView />);
    return screen.getByTestId("home-focus-task-group-row");
  }

  it.each([
    ["home-focus-task-group-open-body", "home-focus-task-group-disclosure"],
    ["home-focus-task-group-open-body", "home-focus-task-stop-all"],
  ])(
    "keeps %s's sibling control a sibling, not a descendant",
    (body, control) => {
      renderGroupRow();
      const bodyEl = screen.getByTestId(body);
      const controlEl = screen.getByTestId(control);
      expect(bodyEl.tagName).toBe("BUTTON");
      expect(bodyEl.contains(controlEl)).toBe(false);
      expect(controlEl.contains(bodyEl)).toBe(false);
    },
  );

  it("orders the row's focusable controls disclosure, body, then Stop", () => {
    const row = renderGroupRow();
    const focusables = Array.from(row.querySelectorAll("button"));
    expect(focusables.map((el) => el.getAttribute("data-testid"))).toEqual([
      "home-focus-task-group-disclosure",
      "home-focus-task-group-open-body",
      "home-focus-task-stop-all",
    ]);
  });

  it("lifts the leading disclosure over the body's stretched overlay with z-10", () => {
    renderGroupRow();
    const classes = screen
      .getByTestId("home-focus-task-group-disclosure")
      .className.split(" ");
    expect(classes).toContain("relative");
    expect(classes).toContain("z-10");
  });
});

describe("<HomeFocusView /> row structure", () => {
  it.each([
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

    const timeNode = screen.getByTestId("home-focus-row-status-duration");
    expect(timeNode.textContent).toBe("· just now");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const timeNodeAfter = screen.getByTestId("home-focus-row-status-duration");
    expect(timeNodeAfter).toBe(timeNode);
    expect(timeNodeAfter.textContent).toBe("· 1m");
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
    const status = screen.getByTestId("home-focus-row-status");
    expect(status.getAttribute("data-state")).toBe("running");
    expect(status.textContent).toBe("running· 41m");
    // A DOM sibling of the body button, in its own track. It is still UNDER
    // that button's stretched overlay, and deliberately so - clicking the
    // status opens the row, like clicking anywhere else that is not a control.
    expect(
      screen.getByTestId("home-focus-background-open-body").contains(status),
    ).toBe(false);
  });

  it("shows a stop button when stoppable and calls stopManagedCommand with the row", () => {
    const row = backgroundRow({ stoppable: true });
    modelMock.value = model({ background: [row] });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-background-stop"));
    expect(actionsMock.stopManagedCommand).toHaveBeenCalledWith(row);
  });

  it("renders a disabled stop naming the unreachable host when a managed command's host is unknown", () => {
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

  // The shape `buildFocusBackground` actually produces: EVERY background item
  // is `stoppable: false`, because its stop is a `chat.subscribe` action on a
  // warm session rather than a unary RPC - which says nothing about which
  // machine it runs on. A single-host install has no other device to blame.
  it("sends a background item's disabled stop to the chat rather than to another device", async () => {
    const user = userEvent.setup();
    modelMock.value = model({
      background: [
        backgroundRow({
          kind: "background-item",
          label: "bun run dev",
          startedAtMs: null,
          stoppable: false,
        }),
      ],
    });
    render(<HomeFocusView />);

    const stop = screen.getByTestId("home-focus-background-stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    // The accessible name, which is the only place a reader who cannot hover a
    // disabled button hears the reason at all.
    expect(stop.getAttribute("aria-label")).toBe(
      "Stop bun run dev. Stop this from the chat",
    );

    // And the same sentence in the tooltip, for everyone else.
    await user.hover(tooltipTriggerOf(stop));
    expect(await screen.findByText("Stop this from the chat")).toBeTruthy();
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
    expect(screen.queryByTestId("home-focus-row-status-duration")).toBeNull();
  });

  it("reads 'just started' under a minute rather than 'running now'", () => {
    modelMock.value = model({
      background: [backgroundRow({ startedAtMs: Date.now() - 5_000 })],
    });
    render(<HomeFocusView />);
    expect(
      screen.getByTestId("home-focus-row-status-duration").textContent,
    ).toBe("· just now");
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

describe("<HomeFocusView /> view control", () => {
  it("renders Focus pressed on an untouched install and leaves the page as it was", () => {
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);

    const group = screen.getByRole("group", { name: "Home view" });
    expect(
      within(group)
        .getByRole("button", { name: "Focus" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("home-focus-section-tasks")).toBeDefined();
    expect(screen.queryByTestId("home-focus-section-task-groups")).toBeNull();
  });

  it("switches to Tasks, persists the choice and tracks layout.home.view", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);

    const group = screen.getByRole("group", { name: "Home view" });
    fireEvent.click(within(group).getByRole("button", { name: "Tasks" }));

    expect(useLayoutStore.getState().home.view).toBe("tasks");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.home.view",
    );
    await expectSettingIdAccepted("layout.home.view");
    expect(screen.getByTestId("home-focus-section-task-groups")).toBeDefined();
  });

  it("opens straight into the persisted view on a later mount", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);

    expect(
      screen.getByTestId("home-focus-view").getAttribute("data-view"),
    ).toBe("tasks");
    expect(screen.getByTestId("home-focus-section-task-groups")).toBeDefined();
    expect(screen.queryByTestId("home-focus-section-tasks")).toBeNull();
  });

  it("neither writes nor tracks when the already-showing view is clicked again", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);

    const group = screen.getByRole("group", { name: "Home view" });
    fireEvent.click(within(group).getByRole("button", { name: "Focus" }));

    expect(useLayoutStore.getState().home.view).toBe("focus");
    expect(trackSettingChanged).not.toHaveBeenCalled();
  });
});

describe("<HomeFocusView /> Tasks view", () => {
  it("leads with the same Needs you section, rendering the identical rows", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    const prompt = promptRow({ epicId: "epic-1", title: "Approve me" });
    modelMock.value = model({
      prompts: [prompt],
      tasks: [taskRow({ epicId: "epic-1" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    const sections = screen
      .getByTestId("home-focus-view")
      .querySelectorAll("[data-testid^='home-focus-section-']");
    expect(sections[0].getAttribute("data-testid")).toBe(
      "home-focus-section-prompts",
    );
    // The same row component with the same activation, not a copy of it.
    fireEvent.click(screen.getByTestId("home-focus-prompt-open-body"));
    expect(actionsMock.openPrompt).toHaveBeenCalledWith(prompt);
  });

  it("never nests or duplicates a Needs-you row under its task", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      prompts: [
        promptRow({ epicId: "epic-1" }),
        promptRow({ epicId: "epic-1" }),
      ],
      tasks: [taskRow({ epicId: "epic-1", needsYou: true })],
      badgeCount: 2,
    });
    render(<HomeFocusView />);

    expect(screen.getAllByTestId("home-focus-prompt-row")).toHaveLength(2);
    // The task says how many are waiting; it does not offer them again.
    expect(screen.getByTestId("home-focus-task-group-needs").textContent).toBe(
      "2 need you",
    );
    expect(screen.getByTestId("home-focus-task-attention")).toBeDefined();
    expect(
      within(screen.getByTestId("home-focus-task-group-body")).queryAllByTestId(
        "home-focus-prompt-row",
      ),
    ).toHaveLength(0);
  });

  it("omits the needs-you badge for a task with no loaded prompt row", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({ tasks: [taskRow({ epicId: "epic-1" })] });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-task-group-needs")).toBeNull();
  });

  it("counts active agents and background jobs in the row's badges", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "a" }), agentRow({ agentId: "b" })],
        }),
      ],
      background: [
        backgroundRow({ epicId: "epic-1", key: "job-1" }),
        backgroundRow({ epicId: "epic-other", key: "job-2" }),
      ],
    });
    render(<HomeFocusView />);

    // Scoped to this task's own row: the job in `epic-other` is now a group of
    // its own further down, and it carries a bg badge too.
    const row = screen.getAllByTestId("home-focus-task-group-row")[0];
    expect(
      within(row).getByTestId("home-focus-task-group-active").textContent,
    ).toBe("2 active");
    expect(
      within(row).getByTestId("home-focus-task-group-jobs").textContent,
    ).toBe("1 bg");
  });

  // The badge claims what this window can SEE, and a mounted epic whose chats
  // were never opened can see nothing - so the row says nothing rather than
  // "0 bg", which would be false.
  it("omits the bg badge for a mounted task with no warm chat in this window", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1", mountedHere: true })],
      background: [backgroundRow({ epicId: "epic-elsewhere" })],
    });
    render(<HomeFocusView />);

    // The elsewhere job is its own group, so the assertion is scoped to the
    // mounted task's row rather than to the page.
    const row = screen.getAllByTestId("home-focus-task-group-row")[0];
    expect(row.textContent).toContain("Task title");
    expect(within(row).queryByTestId("home-focus-task-group-jobs")).toBeNull();
    expect(screen.queryByText("0 bg")).toBeNull();
  });

  // The window-local limit Focus states once in its Background caption is
  // still stated in the view that carries every `N bg` badge - but bounding
  // the BACKGROUND rather than the task list, which is not window-local.
  it("captions the Tasks section with the limit that binds its background", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);
    expect(
      screen.getByTestId("home-focus-section-task-groups-caption").textContent,
    ).toBe("Background shown for tasks open in this window");
  });

  it("leaves Focus's own Background caption unchanged", () => {
    modelMock.value = model({ background: [backgroundRow({})] });
    render(<HomeFocusView />);
    expect(
      screen.getByTestId("home-focus-section-background-caption").textContent,
    ).toBe("Only tasks open in this window");
  });

  it("keeps Stop all on the task row, reaching the roots once", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-tree",
          agents: [
            agentRow({ agentId: "root", title: "impl" }),
            agentRow({ agentId: "child", title: "reviewer", parentId: "root" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    fireEvent.click(screen.getByTestId("home-focus-stop-all-confirm"));
    expect(actionsMock.stopAgent).toHaveBeenCalledTimes(1);
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-tree",
      agentId: "root",
      hostId: null,
      cascade: true,
    });
  });
});

describe("<HomeFocusView /> Tasks view nesting", () => {
  it("renders agents then jobs as a real nested list, flat at one depth", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "root", title: "impl", tier: "turn" }),
            agentRow({
              agentId: "child",
              title: "reviewer",
              tier: "turn",
              parentId: "root",
            }),
          ],
        }),
      ],
      background: [
        backgroundRow({ epicId: "epic-1", label: "dev server", key: "job-1" }),
      ],
    });
    render(<HomeFocusView />);

    const body = screen.getByTestId("home-focus-task-group-body");
    expect(body.tagName).toBe("UL");
    const agents = within(body).getAllByTestId("home-focus-task-group-agent");
    expect(agents).toHaveLength(2);
    expect(agents[0].textContent).toContain("impl");
    expect(agents[0].textContent).toContain("turn");
    expect(agents[1].textContent).toContain("via impl");
    // One depth: the child is a sibling of its parent, not nested under it.
    expect(agents[0].contains(agents[1])).toBe(false);
    const jobs = within(body).getAllByTestId("home-focus-task-group-job");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].textContent).toContain("dev server");
  });

  // The disclosure and the row body are two verbs, not the duplicate the Open
  // button was: one reveals what the task holds, the other opens the task.
  it("opens the task from the row body without touching the disclosure", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-open", agents: [agentRow({})] })],
    });
    render(<HomeFocusView />);

    const disclosure = screen.getByTestId("home-focus-task-group-disclosure");
    const expandedBefore = disclosure.getAttribute("aria-expanded");
    fireEvent.click(screen.getByTestId("home-focus-task-group-open-body"));

    expect(actionsMock.openTask).toHaveBeenCalledWith("epic-open");
    expect(disclosure.getAttribute("aria-expanded")).toBe(expandedBefore);
  });

  it("toggles the disclosure without opening the task", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-open", agents: [agentRow({})] })],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-group-disclosure"));
    expect(actionsMock.openTask).not.toHaveBeenCalled();
  });

  it("opens a cold task from its summary row", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          mountedHere: false,
          agents: [agentRow({ surface: null })],
        }),
      ],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-group-open-body"));
    expect(actionsMock.openTask).toHaveBeenCalledWith("epic-cold");
  });

  it("opens the agent and the job from their own rows", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    const job = backgroundRow({ epicId: "epic-1", key: "job-1" });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "agent-x", title: "impl" })],
        }),
      ],
      background: [job],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-group-agent-body"));
    expect(actionsMock.openAgent).toHaveBeenCalledWith("epic-1", "agent-x");
    fireEvent.click(screen.getByTestId("home-focus-task-group-job-body"));
    expect(actionsMock.openBackground).toHaveBeenCalledWith(job);
  });

  it("gives a cold task one summary row and no disclosure", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          mountedHere: false,
          agents: [agentRow({ surface: null }), agentRow({ surface: null })],
        }),
      ],
    });
    render(<HomeFocusView />);

    // The twisty is kept in the row for ALIGNMENT only - disabled, so it is
    // neither focusable nor clickable, and `invisible`, so it is not drawn.
    // There is nothing to reveal: a cold task names no agents, and this one
    // has no warm chat either.
    const disclosure = screen.getByTestId("home-focus-task-group-disclosure");
    expect(disclosure.hasAttribute("disabled")).toBe(true);
    expect(disclosure.className).toContain("invisible");
    fireEvent.click(disclosure);
    expect(screen.queryByTestId("home-focus-task-group-body")).toBeNull();

    const cold = screen.getByTestId("home-focus-cold-agents");
    expect(cold.textContent).toContain("2 agents");
    expect(cold.textContent).toContain("not open in this window");
    // No "0 bg" and no badges at all: this window cannot see a cold task's
    // background, and it has no names to count.
    expect(screen.queryByTestId("home-focus-task-group-jobs")).toBeNull();
    expect(screen.queryByTestId("home-focus-task-group-active")).toBeNull();
  });

  // "Mounted here" is a live Y.Doc projection; jobs come from warm chat
  // SESSIONS. An unmounted epic with a warm chat has work to reveal even
  // though it still names no agents - and dropping it was the hole the cold
  // branch had while the two sets were treated as one.
  it("still reveals a cold task's jobs, and never invents agent rows for it", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          mountedHere: false,
          agents: [agentRow({ surface: null })],
        }),
      ],
      background: [
        backgroundRow({ epicId: "epic-cold", label: "bun run dev" }),
      ],
    });
    render(<HomeFocusView />);

    const disclosure = screen.getByTestId("home-focus-task-group-disclosure");
    expect(disclosure.hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("home-focus-task-group-jobs").textContent).toBe(
      "1 bg",
    );

    const body = screen.getByTestId("home-focus-task-group-body");
    expect(
      within(body).getAllByTestId("home-focus-task-group-job"),
    ).toHaveLength(1);
    expect(
      within(body).queryAllByTestId("home-focus-task-group-agent"),
    ).toHaveLength(0);
    expect(screen.getByTestId("home-focus-cold-agents")).toBeDefined();
  });
});

describe("<HomeFocusView /> Tasks view disclosure", () => {
  function tasksView(count: number): void {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: Array.from({ length: count }, (_unused, index) =>
        taskRow({ epicId: `epic-${index}`, agents: [agentRow({})] }),
      ),
    });
  }

  it.each([1, 2, 3])("expands all %s tasks on first entry", (count) => {
    tasksView(count);
    render(<HomeFocusView />);
    const disclosures = screen.getAllByTestId(
      "home-focus-task-group-disclosure",
    );
    expect(disclosures).toHaveLength(count);
    for (const disclosure of disclosures) {
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    }
    expect(screen.getAllByTestId("home-focus-task-group-body")).toHaveLength(
      count,
    );
  });

  it("collapses all of them once there are more than three", () => {
    tasksView(4);
    render(<HomeFocusView />);
    for (const disclosure of screen.getAllByTestId(
      "home-focus-task-group-disclosure",
    )) {
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    }
    expect(screen.queryByTestId("home-focus-task-group-body")).toBeNull();
  });

  it("toggles one row without touching its neighbours", () => {
    tasksView(4);
    render(<HomeFocusView />);
    const disclosures = screen.getAllByTestId(
      "home-focus-task-group-disclosure",
    );

    fireEvent.click(disclosures[1]);
    expect(disclosures[1].getAttribute("aria-expanded")).toBe("true");
    expect(disclosures[0].getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByTestId("home-focus-task-group-body")).toHaveLength(1);

    fireEvent.click(disclosures[1]);
    expect(disclosures[1].getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("home-focus-task-group-body")).toBeNull();
  });

  it("points the disclosure at the body it controls", () => {
    tasksView(1);
    render(<HomeFocusView />);
    const disclosure = screen.getByTestId("home-focus-task-group-disclosure");
    expect(screen.getByTestId("home-focus-task-group-body").id).toBe(
      disclosure.getAttribute("aria-controls"),
    );
  });

  // Session-lived and self-pruning: the row is keyed by epic id, so a task
  // leaving the model takes its disclosure with it rather than leaving an
  // entry a later task with the same id would inherit.
  it("drops a task's disclosure when the task leaves the model", () => {
    tasksView(4);
    const { rerender } = render(<HomeFocusView />);
    const expanded = screen.getAllByTestId(
      "home-focus-task-group-disclosure",
    )[0];
    fireEvent.click(expanded);
    expect(
      screen
        .getAllByTestId("home-focus-task-group-disclosure")[0]
        .getAttribute("aria-expanded"),
    ).toBe("true");

    modelMock.value = model({
      tasks: Array.from({ length: 3 }, (_unused, index) =>
        taskRow({ epicId: `epic-${index + 1}`, agents: [agentRow({})] }),
      ),
    });
    rerender(<HomeFocusView />);

    modelMock.value = model({
      tasks: Array.from({ length: 4 }, (_unused, index) =>
        taskRow({ epicId: `epic-${index}`, agents: [agentRow({})] }),
      ),
    });
    rerender(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-task-group-disclosure")[0]
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});

// `isEmpty` is a property of the RENDERED VIEW, not of the model. Tasks draws
// prompts and groups and has no Background section, so a model-level check
// would suppress the empty state and then render both sections as `null`: a
// page with a segmented control and nothing under it.
describe("<HomeFocusView /> Tasks view emptiness", () => {
  it("groups a background-only epic rather than leaving the page blank", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [],
      background: [
        backgroundRow({
          epicId: "epic-idle",
          taskTitle: "Idle task",
          label: "bun run dev",
        }),
      ],
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
    const row = screen.getByTestId("home-focus-task-group-row");
    expect(row.textContent).toContain("Idle task");
    // Nothing is running in it, so there is no agent count to claim and
    // nothing to stop - only the work this window can actually see.
    expect(screen.getByTestId("home-focus-task-group-jobs").textContent).toBe(
      "1 bg",
    );
    expect(screen.queryByTestId("home-focus-task-group-active")).toBeNull();
    expect(screen.queryByTestId("home-focus-task-stop")).toBeNull();
    expect(screen.queryByTestId("home-focus-task-stop-all")).toBeNull();
    expect(
      screen.getByTestId("home-focus-task-group-job-body").textContent,
    ).toContain("bun run dev");
  });

  it("opens a background-only group's task from its row body", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [],
      background: [backgroundRow({ epicId: "epic-idle" })],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-group-open-body"));
    expect(actionsMock.openTask).toHaveBeenCalledWith("epic-idle");
  });

  it("lists a task group and a background-only group together", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-running", taskTitle: "Running task" })],
      background: [
        backgroundRow({ epicId: "epic-idle", taskTitle: "Idle task" }),
      ],
    });
    render(<HomeFocusView />);

    const rows = screen.getAllByTestId("home-focus-task-group-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Running task");
    expect(rows[1].textContent).toContain("Idle task");
    const heading = within(
      screen.getByTestId("home-focus-section-task-groups"),
    ).getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Tasks · 2 tasks");
  });

  it("shows the empty state when the view itself has nothing, not when the model does", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({ tasks: [], background: [], prompts: [] });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-empty")).toBeDefined();
    expect(screen.queryByTestId("home-focus-section-task-groups")).toBeNull();
  });

  it("is not empty when only prompts remain, in either view", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      prompts: [promptRow({ epicId: null })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
    expect(screen.getByTestId("home-focus-section-prompts")).toBeDefined();
    // An ungrouped prompt mints no task group.
    expect(screen.queryByTestId("home-focus-section-task-groups")).toBeNull();
  });

  it("keeps Focus's own emptiness rule: background alone still draws the Background section", () => {
    modelMock.value = model({ tasks: [], background: [backgroundRow({})] });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
    expect(screen.getByTestId("home-focus-section-background")).toBeDefined();
  });

  // Focus does not compute the grouping at all, so its emptiness has to be a
  // property of the MODEL. This is the case that would fail if it ever started
  // reading a `groups` array that is empty by construction under Focus: the
  // model has content, no task row, and nothing the Focus page can derive from
  // a grouping it never asked for.
  it("does not read the grouping to decide whether Focus is empty", () => {
    modelMock.value = model({
      tasks: [],
      background: [
        backgroundRow({ epicId: "epic-idle", label: "bun run dev" }),
      ],
    });
    const { rerender } = render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
    expect(
      screen.getByTestId("home-focus-background-row").textContent,
    ).toContain("bun run dev");
    // The same model under Tasks reaches the grouping and finds the same work,
    // so neither view calls this account empty.
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    rerender(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
    expect(screen.getByTestId("home-focus-task-group-row")).toBeDefined();
  });
});

describe("<HomeFocusView /> density", () => {
  it("is byte-identical to the comfortable row today when comfortable", () => {
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);
    const row = screen.getByTestId("home-focus-task-row");
    expect(row.getAttribute("data-density")).toBe("comfortable");
    // Byte identity, which is the actual claim: `homeRowClass("comfortable")`
    // returns `ROW_CLASS` itself rather than running it through `cn()`.
    expect(row.className).toBe(ROW_CLASS);
  });

  it("tightens the desktop row under compact", () => {
    useLayoutStore.setState({ home: { view: "focus", density: "compact" } });
    modelMock.value = model({
      prompts: [promptRow({})],
      tasks: [taskRow({})],
      background: [backgroundRow({})],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    for (const testId of [
      "home-focus-prompt-row",
      "home-focus-task-row",
      "home-focus-background-row",
    ]) {
      const row = screen.getByTestId(testId);
      expect(row.getAttribute("data-density")).toBe("compact");
      expect(row.className).toContain("p-2");
      expect(row.className).toContain("gap-2");
      // The comfortable spacing is displaced, not merely appended after.
      expect(row.className.split(" ")).not.toContain("p-3");
      expect(row.className.split(" ")).not.toContain("gap-3");
    }
  });

  // Compact is a preference about a precise pointer. A phone keeps the hit
  // area H3 sized for a thumb, and the touch chrome that goes with it.
  it("restores the touch chrome under a coarse pointer", () => {
    useLayoutStore.setState({ home: { view: "focus", density: "compact" } });
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);

    const classes = screen
      .getByTestId("home-focus-task-row")
      .className.split(" ");
    expect(classes).toContain("pointer-coarse:p-3");
    expect(classes).toContain("pointer-coarse:gap-3");
    expect(classes).toContain("pointer-coarse:touch-chrome");
    expect(classes).toContain("active:press-scrim");
  });

  it("applies to the Tasks view's nested rows too", () => {
    useLayoutStore.setState({ home: { view: "tasks", density: "compact" } });
    modelMock.value = model({
      tasks: [
        taskRow({ epicId: "epic-1", agents: [agentRow({ title: "impl" })] }),
      ],
      background: [backgroundRow({ epicId: "epic-1" })],
    });
    render(<HomeFocusView />);

    for (const testId of [
      "home-focus-task-group-row",
      "home-focus-task-group-agent",
      "home-focus-task-group-job",
    ]) {
      const row = screen.getByTestId(testId);
      expect(row.getAttribute("data-density")).toBe("compact");
      expect(row.className.split(" ")).toContain("p-2");
      expect(row.className.split(" ")).toContain("pointer-coarse:p-3");
    }
  });
});

describe("<HomeFocusView /> row icon vocabulary", () => {
  it("gives a chat agent and a terminal agent different glyphs", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          agents: [
            agentRow({ agentId: "chat", title: "impl", surface: "chat" }),
            agentRow({
              agentId: "tui",
              title: "shell agent",
              surface: "terminal-agent",
            }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);

    const glyphs = screen.getAllByTestId("home-focus-agent-glyph");
    expect(glyphs.map((glyph) => glyph.getAttribute("data-surface"))).toEqual([
      "chat",
      "terminal-agent",
    ]);
    expect(new Set(glyphs.map((glyph) => glyph.innerHTML)).size).toBe(2);
  });

  // The `Terminal` glyph means "a shell" everywhere on this page, so a TUI
  // agent must not wear it - it wears the registry's `Bot`.
  it("does not draw a terminal agent with the managed command's glyph", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({
              agentId: "tui",
              title: "tui",
              surface: "terminal-agent",
            }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1", itemKind: null })],
    });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-agent-glyph").innerHTML).not.toBe(
      screen.getByTestId("home-focus-background-glyph").innerHTML,
    );
  });

  it("draws no agent glyph when the surface is unknown", () => {
    modelMock.value = model({
      tasks: [
        taskRow({ mountedHere: true, agents: [agentRow({ surface: null })] }),
      ],
    });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-agent-glyph")).toBeNull();
  });

  it("draws a background item with its own kind's glyph and a command with the shell's", () => {
    modelMock.value = model({
      background: [
        backgroundRow({ key: "cmd", kind: "managed-command", itemKind: null }),
        backgroundRow({
          key: "sub",
          kind: "background-item",
          itemKind: "subagent",
          startedAtMs: null,
        }),
        backgroundRow({
          key: "mon",
          kind: "background-item",
          itemKind: "monitor",
          startedAtMs: null,
        }),
      ],
    });
    render(<HomeFocusView />);

    const glyphs = screen.getAllByTestId("home-focus-background-glyph");
    expect(glyphs.map((glyph) => glyph.getAttribute("data-item-kind"))).toEqual(
      [null, "subagent", "monitor"],
    );
    expect(new Set(glyphs.map((glyph) => glyph.innerHTML)).size).toBe(3);
  });

  it("keeps the section headings text, with no glyph of their own", () => {
    modelMock.value = model({
      prompts: [promptRow({})],
      tasks: [taskRow({})],
      background: [backgroundRow({})],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    for (const heading of screen.getAllByRole("heading", { level: 2 })) {
      expect(heading.querySelector("svg")).toBeNull();
    }
  });
});

// One activity, one row - the rule the rest of this file defers to. It was a
// real report: one monitor listed twice, as `Running · Greeting and
// Introduction · background` and `Background · 10min heartbeat · running 5h`.
describe("<HomeFocusView /> no duplicate rows for one activity", () => {
  function idleChatHostingAMonitor(): FocusModel {
    return model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          taskTitle: "General Conversation History",
          agents: [
            agentRow({
              agentId: "chat-1",
              title: "Greeting and Introduction",
              tier: "background",
            }),
          ],
        }),
      ],
      background: [
        backgroundRow({
          epicId: "epic-1",
          chatId: "chat-1",
          taskTitle: "General Conversation History",
          chatTitle: "Greeting and Introduction",
          label: "10min heartbeat",
          itemKind: "monitor",
          kind: "background-item",
          startedAtMs: null,
        }),
      ],
    });
  }

  it("keeps a background-tier agent out of Running, leaving its job the only row", () => {
    modelMock.value = idleChatHostingAMonitor();
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-section-tasks")).toBeNull();
    expect(screen.queryByTestId("home-focus-task-row")).toBeNull();
    const rows = screen.getAllByTestId("home-focus-background-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("10min heartbeat");
  });

  // The asymmetry: de-duplicating against a Background row only makes sense
  // where that row exists. A cold task has none - neither section could show
  // it - so it keeps its Running row and says what little it honestly can.
  it("keeps a cold background-only task in Running, with no job row to replace it", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          taskTitle: "Archived conversation",
          mountedHere: false,
          agents: [
            agentRow({ tier: "background", surface: null }),
            agentRow({ tier: "background", surface: null }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-elsewhere" })],
    });
    render(<HomeFocusView />);

    const row = screen.getByTestId("home-focus-task-row");
    expect(row.textContent).toContain("Archived conversation");
    expect(
      within(row)
        .getByTestId("home-focus-row-status")
        .getAttribute("data-state"),
    ).toBe("background");
    // `ColdTaskAgents` keeps the count and the caveat in separate nodes, so
    // they are asserted separately rather than as one run-together string.
    const cold = screen.getByTestId("home-focus-cold-agents");
    expect(cold.textContent).toContain("2 agents");
    expect(cold.textContent).toContain("not open in this window");
    expect(
      screen.getByTestId("home-focus-section-tasks-heading").textContent,
    ).toBe("Running · 1 task");
  });

  it("drops a warm background-only task, whose jobs carry it in Background", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-warm",
          mountedHere: true,
          agents: [agentRow({ tier: "background" })],
        }),
      ],
      background: [
        backgroundRow({ epicId: "epic-warm", label: "10min heartbeat" }),
      ],
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-section-tasks")).toBeNull();
    expect(
      screen.getByTestId("home-focus-background-row").textContent,
    ).toContain("10min heartbeat");
  });

  it("counts Running by the tasks it actually draws", () => {
    modelMock.value = model({
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
    });
    render(<HomeFocusView />);

    expect(
      screen.getByTestId("home-focus-section-tasks-heading").textContent,
    ).toBe("Running · 1 task");
    expect(screen.getAllByTestId("home-focus-task-row")).toHaveLength(1);
  });

  it("drops a background-tier chip from a task that also has a mid-turn agent", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "busy", title: "impl", tier: "turn" }),
            agentRow({
              agentId: "idle",
              title: "shell host",
              tier: "background",
            }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1" })],
    });
    render(<HomeFocusView />);

    const chips = screen.getAllByTestId("home-focus-agent-chip");
    expect(chips.map((chip) => chip.getAttribute("data-agent-id"))).toEqual([
      "busy",
    ]);
  });

  // The exception, and it is the honest one: with no job row for this task,
  // hiding the agent would lose the work rather than de-duplicate it.
  it("keeps a background-tier agent when this window has no job row for its task", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "busy", title: "impl", tier: "turn" }),
            agentRow({
              agentId: "idle",
              title: "shell host",
              tier: "background",
            }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-elsewhere" })],
    });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-agent-chip")
        .map((chip) => chip.getAttribute("data-agent-id")),
    ).toEqual(["busy", "idle"]);
  });

  it("still cascades Stop all over the agents it does not draw", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "busy", title: "impl", tier: "turn" }),
            agentRow({
              agentId: "idle",
              title: "shell host",
              tier: "background",
            }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1" })],
    });
    render(<HomeFocusView />);

    // One chip is drawn, but the stop is the task's, not the chip's: two roots
    // go down, including the agent this view deliberately hides.
    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    fireEvent.click(screen.getByTestId("home-focus-stop-all-confirm"));
    expect(actionsMock.stopAgent).toHaveBeenCalledTimes(2);
    expect(actionsMock.stopAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "idle", cascade: true }),
    );
  });

  it("lists the mid-turn agents and the jobs as a task's children in Tasks view", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "busy", title: "impl", tier: "turn" }),
            agentRow({
              agentId: "idle",
              title: "shell host",
              tier: "background",
            }),
          ],
        }),
      ],
      background: [
        backgroundRow({ epicId: "epic-1", label: "10min heartbeat" }),
      ],
    });
    render(<HomeFocusView />);

    const body = screen.getByTestId("home-focus-task-group-body");
    expect(
      within(body)
        .getAllByTestId("home-focus-task-group-agent")
        .map((row) => row.getAttribute("data-agent-id")),
    ).toEqual(["busy"]);
    expect(
      within(body).getAllByTestId("home-focus-task-group-job"),
    ).toHaveLength(1);
    expect(screen.getByTestId("home-focus-task-group-active").textContent).toBe(
      "1 active",
    );
  });
});

describe("<HomeFocusView /> row grammar", () => {
  it("names the job, then its chat, then its task - never one run-together string", () => {
    modelMock.value = model({
      background: [
        backgroundRow({
          label: "10min heartbeat",
          chatTitle: "Greeting and Introduction",
          taskTitle: "General Conversation History",
        }),
      ],
    });
    render(<HomeFocusView />);

    const name = screen.getByTestId("home-focus-row-name");
    const context = screen.getByTestId("home-focus-row-context");
    expect(name.textContent).toBe("10min heartbeat");
    expect(name.className).toContain("text-foreground");
    expect(context.textContent).toBe(
      "·in Greeting and Introduction·General Conversation History",
    );
    expect(context.className).toContain("text-muted-foreground");
    // Separate nodes, so the two names can never be read as one.
    expect(name.contains(context)).toBe(false);
  });

  it("leads a prompt row with the prompt, and puts its task in the context", () => {
    modelMock.value = model({
      prompts: [
        promptRow({
          title: "Approve: run bun test",
          body: "",
          taskTitle: "Ship the parser",
        }),
      ],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-row-name").textContent).toBe(
      "Approve: run bun test",
    );
    expect(screen.getByTestId("home-focus-row-context").textContent).toBe(
      "·in Ship the parser",
    );
  });

  it("drops the context entirely rather than naming a task it cannot name", () => {
    modelMock.value = model({
      prompts: [promptRow({ taskTitle: null })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-row-context")).toBeNull();
  });

  it("omits the `in <task>` part on a task's child rows", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          taskTitle: "General Conversation History",
          agents: [agentRow({ agentId: "busy", title: "impl", tier: "turn" })],
        }),
      ],
      background: [
        backgroundRow({
          epicId: "epic-1",
          label: "10min heartbeat",
          chatTitle: "Greeting and Introduction",
          taskTitle: "General Conversation History",
        }),
      ],
    });
    render(<HomeFocusView />);

    const body = screen.getByTestId("home-focus-task-group-body");
    const agent = within(body).getByTestId("home-focus-task-group-agent");
    expect(within(agent).queryByTestId("home-focus-row-context")).toBeNull();
    // The job keeps its CHAT, which the task row above does not name.
    const job = within(body).getByTestId("home-focus-task-group-job");
    expect(within(job).getByTestId("home-focus-row-context").textContent).toBe(
      "·in Greeting and Introduction",
    );
    expect(
      within(job).getByTestId("home-focus-row-context").textContent,
    ).not.toContain("General Conversation History");
  });
});

describe("<HomeFocusView /> status column", () => {
  it("reads `needs you` in the warning tone on a prompt row", () => {
    modelMock.value = model({ prompts: [promptRow({})], badgeCount: 1 });
    render(<HomeFocusView />);

    const status = screen.getByTestId("home-focus-row-status");
    expect(status.getAttribute("data-state")).toBe("needs-you");
    expect(status.textContent).toContain("needs you");
    expect(screen.getByTestId("home-focus-row-status-dot").className).toContain(
      "bg-warning-foreground",
    );
  });

  it.each([
    ["turn", "turn", "bg-primary"],
    ["background", "background", "border-muted-foreground"],
  ] as const)("reads a %s-tier agent as `%s`", (tier, word, dotClass) => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "a", title: "impl", tier })],
        }),
      ],
    });
    render(<HomeFocusView />);

    const row = screen.getByTestId("home-focus-task-group-agent");
    const status = within(row).getByTestId("home-focus-row-status");
    expect(status.textContent).toBe(word);
    expect(
      within(row).getByTestId("home-focus-row-status-dot").className,
    ).toContain(dotClass);
  });

  it("gives a task with no agent of its own the waiting state", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [],
      background: [backgroundRow({ epicId: "epic-idle" })],
    });
    render(<HomeFocusView />);

    const row = screen.getByTestId("home-focus-task-group-row");
    expect(
      within(row)
        .getByTestId("home-focus-row-status")
        .getAttribute("data-state"),
    ).toBe("waiting");
  });

  it("shows a state word with no duration where the model has no timestamp", () => {
    modelMock.value = model({
      background: [backgroundRow({ startedAtMs: null })],
    });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-row-status").textContent).toBe(
      "running",
    );
  });
});

describe("<HomeFocusView /> section headings", () => {
  it("keeps the caption out of the heading and on its own line", () => {
    modelMock.value = model({
      background: [backgroundRow({})],
      coverage: {
        activity: "live",
        notifications: "cloud",
        backgroundIsMountedOnly: true,
      },
    });
    render(<HomeFocusView />);

    const heading = screen.getByTestId("home-focus-section-background-heading");
    const caption = screen.getByTestId("home-focus-section-background-caption");
    expect(heading.textContent).toBe("Background · 1");
    expect(heading.contains(caption)).toBe(false);
    expect(caption.tagName).toBe("P");
    // Its own line: the caption is not a flex sibling on the heading's
    // baseline row, which is how it rendered as one string.
    expect(heading.parentElement?.className).toContain("flex-col");
  });

  it("names every section's heading by count alone", () => {
    modelMock.value = model({
      prompts: [promptRow({}), promptRow({})],
      tasks: [taskRow({})],
      background: [backgroundRow({})],
      badgeCount: 2,
    });
    render(<HomeFocusView />);

    expect(
      screen.getByTestId("home-focus-section-prompts-heading").textContent,
    ).toBe("Needs you · 2");
    expect(
      screen.getByTestId("home-focus-section-tasks-heading").textContent,
    ).toBe("Running · 1 task");
    expect(
      screen.getByTestId("home-focus-section-background-heading").textContent,
    ).toBe("Background · 1");
  });
});

describe("<HomeFocusView /> summary line", () => {
  it("reports every non-zero count in one line", () => {
    modelMock.value = model({
      prompts: [promptRow({}), promptRow({})],
      tasks: [taskRow({ epicId: "epic-1" })],
      background: [backgroundRow({ epicId: "epic-1" })],
      badgeCount: 2,
    });
    render(<HomeFocusView />);

    const summary = screen.getByRole("group", { name: "Summary" });
    expect(
      within(summary)
        .getAllByTestId("home-focus-summary-segment")
        .map((segment) => segment.textContent),
    ).toEqual(["2 need you", "1 running", "1 background"]);
  });

  it("omits a segment whose count is zero", () => {
    modelMock.value = model({
      background: [backgroundRow({})],
    });
    render(<HomeFocusView />);
    expect(
      screen
        .getAllByTestId("home-focus-summary-segment")
        .map((segment) => segment.getAttribute("data-segment")),
    ).toEqual(["background"]);
  });

  it("counts running by the same rule the section draws", () => {
    modelMock.value = model({
      tasks: [
        // Warm and background-only, with its own job row below - so Background
        // carries it and Running does not.
        taskRow({
          epicId: "epic-idle",
          agents: [agentRow({ tier: "background" })],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-idle" })],
    });
    render(<HomeFocusView />);
    expect(
      screen
        .getAllByTestId("home-focus-summary-segment")
        .map((segment) => segment.getAttribute("data-segment")),
    ).toEqual(["background"]);
  });

  it("is replaced by the empty state when everything is zero", () => {
    modelMock.value = model({});
    render(<HomeFocusView />);
    expect(screen.queryByTestId("home-focus-summary")).toBeNull();
    expect(screen.getByTestId("home-focus-empty")).toBeDefined();
  });

  it("moves focus to the section a segment names", () => {
    modelMock.value = model({
      prompts: [promptRow({})],
      background: [backgroundRow({})],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    const background = screen
      .getAllByTestId("home-focus-summary-segment")
      .find((segment) => segment.getAttribute("data-segment") === "background");
    fireEvent.click(background ?? screen.getByTestId("home-focus-summary"));
    expect(document.activeElement).toBe(
      screen.getByTestId("home-focus-section-background"),
    );
  });
});

// Decisions 2 and 5 are about GEOMETRY, and jsdom has none - so what is pinned
// here is the structure that produces it: every row of a section reserves both
// right-hand tracks, whatever it has to put in them. Without that, `Stop all`
// is wider than `Stop` is wider than nothing, and the status column staircases
// down a section of mixed rows.
describe("<HomeFocusView /> shared status and action columns", () => {
  const STATUS_TRACK = ["w-32", "sm:w-36"];
  const ACTIONS_TRACK = ["w-24"];

  function expectTracks(scope: HTMLElement): void {
    const status = within(scope).getByTestId("home-focus-row-status");
    for (const cls of STATUS_TRACK) {
      expect(status.className.split(" ")).toContain(cls);
    }
    const actions = within(scope).getByTestId("home-focus-row-actions");
    for (const cls of ACTIONS_TRACK) {
      expect(actions.className.split(" ")).toContain(cls);
    }
  }

  it("gives every Focus row both tracks, across one-agent, multi-agent and no-action shapes", () => {
    modelMock.value = model({
      prompts: [promptRow({ epicId: "epic-1" })],
      tasks: [
        // One agent -> `Stop`.
        taskRow({ epicId: "epic-one", agents: [agentRow({ tier: "turn" })] }),
        // Several -> the wider `Stop all`.
        taskRow({
          epicId: "epic-many",
          agents: [
            agentRow({ agentId: "a", tier: "turn" }),
            agentRow({ agentId: "b", tier: "turn" }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-bg" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-task-stop")).toBeDefined();
    expect(screen.getByTestId("home-focus-task-stop-all")).toBeDefined();
    for (const testId of [
      "home-focus-prompt-row",
      "home-focus-background-row",
    ]) {
      expectTracks(screen.getByTestId(testId));
    }
    for (const row of screen.getAllByTestId("home-focus-task-row")) {
      expectTracks(row);
    }
  });

  it("reserves the action track on a row that has nothing to stop", () => {
    modelMock.value = model({ prompts: [promptRow({})], badgeCount: 1 });
    render(<HomeFocusView />);

    const actions = screen.getByTestId("home-focus-row-actions");
    expect(actions.textContent).toBe("");
    expect(actions.className.split(" ")).toContain("w-24");
  });

  it("gives the Tasks view's group rows and nested rows the same tracks", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "busy", title: "impl", tier: "turn" })],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1" })],
    });
    render(<HomeFocusView />);

    expectTracks(screen.getByTestId("home-focus-task-group-row"));
    expectTracks(screen.getByTestId("home-focus-task-group-agent"));
    expectTracks(screen.getByTestId("home-focus-task-group-job"));
  });

  it("reserves the action track on a group row with no task to stop", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [],
      background: [backgroundRow({ epicId: "epic-idle" })],
    });
    render(<HomeFocusView />);

    const row = screen.getByTestId("home-focus-task-group-row");
    expect(within(row).queryByTestId("home-focus-task-stop-all")).toBeNull();
    expectTracks(row);
  });

  // A sibling so it is not part of the open control's ACCESSIBLE NAME - the
  // row already announces enough. It stays inside the body's stretched hit
  // area, which is intended: everything that is not a control opens the row.
  it("keeps the status cell out of the body button's accessible name", () => {
    modelMock.value = model({ background: [backgroundRow({})] });
    render(<HomeFocusView />);

    const body = screen.getByTestId("home-focus-background-open-body");
    const status = screen.getByTestId("home-focus-row-status");
    expect(body.contains(status)).toBe(false);
    expect(body.textContent).not.toContain("running");
    // Unpositioned, so the body's overlay still covers it and a click there
    // opens the row rather than landing on inert text.
    expect(status.className.split(" ")).not.toContain("relative");
    expect(status.className.split(" ")).not.toContain("z-10");
  });

  // Left-aligned INSIDE the fixed track is what actually freezes the dot and
  // the word: right alignment pins only the cell's right edge, so a row
  // carrying `· 41m` would push its word left of a row carrying none.
  it("anchors the dot and word at the track's left edge, with the duration trailing", () => {
    modelMock.value = model({
      background: [
        backgroundRow({ key: "with", startedAtMs: Date.now() - 41 * 60_000 }),
        backgroundRow({ key: "without", startedAtMs: null }),
      ],
    });
    render(<HomeFocusView />);

    const cells = screen.getAllByTestId("home-focus-row-status");
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.className.split(" ")).toContain("justify-start");
      expect(cell.className.split(" ")).not.toContain("justify-end");
      // The dot leads, the word follows, the duration is last or absent.
      expect(cell.firstElementChild?.getAttribute("data-testid")).toBe(
        "home-focus-row-status-dot",
      );
    }
    expect(cells[0].textContent).toBe("running· 41m");
    expect(cells[1].textContent).toBe("running");
  });

  it("keeps the duration numerals tabular so a tick cannot rewidth it", () => {
    modelMock.value = model({ background: [backgroundRow({})] });
    render(<HomeFocusView />);
    expect(
      screen.getByTestId("home-focus-row-status").className.split(" "),
    ).toContain("tabular-nums");
  });
});

describe("<HomeFocusView /> summary line per view", () => {
  it("folds running and background into one task count in Tasks view", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      prompts: [promptRow({ epicId: "epic-1" })],
      tasks: [
        taskRow({ epicId: "epic-1", agents: [agentRow({ tier: "turn" })] }),
      ],
      background: [backgroundRow({ epicId: "epic-other" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    const segments = screen.getAllByTestId("home-focus-summary-segment");
    expect(segments.map((segment) => segment.textContent)).toEqual([
      "1 need you",
      "2 tasks",
    ]);
    // Every segment names a section this view actually mounts.
    for (const segment of segments) {
      expect(
        document.getElementById(segment.getAttribute("data-target") ?? ""),
      ).not.toBeNull();
    }
  });

  it("singularises the task segment", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [
        taskRow({ epicId: "epic-1", agents: [agentRow({ tier: "turn" })] }),
      ],
    });
    render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-summary-segment").textContent).toBe(
      "1 task",
    );
  });

  // The blocking case: a background-only account in Tasks view had one summary
  // button and it pointed at a section Tasks never renders.
  it("moves focus to the Tasks section from a background-only model", () => {
    useLayoutStore.setState({
      home: { view: "tasks", density: "comfortable" },
    });
    modelMock.value = model({
      tasks: [],
      background: [backgroundRow({ epicId: "epic-idle" })],
    });
    render(<HomeFocusView />);

    const segment = screen.getByTestId("home-focus-summary-segment");
    expect(segment.textContent).toBe("1 task");
    fireEvent.click(segment);
    expect(document.activeElement).toBe(
      screen.getByTestId("home-focus-section-task-groups"),
    );
  });

  it("still names all three sections in Focus view, and each one exists", () => {
    modelMock.value = model({
      prompts: [promptRow({ epicId: "epic-1" })],
      tasks: [
        taskRow({ epicId: "epic-1", agents: [agentRow({ tier: "turn" })] }),
      ],
      background: [backgroundRow({ epicId: "epic-1" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    const segments = screen.getAllByTestId("home-focus-summary-segment");
    expect(
      segments.map((segment) => segment.getAttribute("data-segment")),
    ).toEqual(["need you", "running", "background"]);
    for (const segment of segments) {
      expect(
        document.getElementById(segment.getAttribute("data-target") ?? ""),
      ).not.toBeNull();
    }
  });
});

describe("<HomeFocusView /> duration hiding", () => {
  it("never hides the duration under Comfortable, at any width", () => {
    modelMock.value = model({ background: [backgroundRow({})] });
    render(<HomeFocusView />);

    const duration = screen.getByTestId("home-focus-row-status-duration");
    expect(duration.getAttribute("data-density")).toBe("comfortable");
    expect(duration.className).not.toContain("hidden");
  });

  // A container query on the section, not a viewport one: a narrow Home tile
  // in a wide window is the case `max-sm:` gets backwards.
  it("hides it under Compact on a narrow ROW rather than a narrow viewport", () => {
    useLayoutStore.setState({ home: { view: "focus", density: "compact" } });
    modelMock.value = model({ background: [backgroundRow({})] });
    render(<HomeFocusView />);

    const duration = screen.getByTestId("home-focus-row-status-duration");
    expect(duration.getAttribute("data-density")).toBe("compact");
    expect(duration.className.split(" ")).toContain("@max-sm:hidden");
    expect(duration.className).not.toContain("max-sm:hidden ");
    expect(
      screen.getByTestId("home-focus-section-background").className.split(" "),
    ).toContain("@container");
  });

  it("keeps the state word in both densities", () => {
    for (const density of ["comfortable", "compact"] as const) {
      useLayoutStore.setState({ home: { view: "focus", density } });
      modelMock.value = model({ background: [backgroundRow({})] });
      const view = render(<HomeFocusView />);
      expect(screen.getByTestId("home-focus-row-status").textContent).toContain(
        "running",
      );
      view.unmount();
    }
  });
});

describe("<HomeFocusView /> context keys", () => {
  // A chat and its task can be called the same thing and are still two
  // different objects, so the row keys them by ROLE and renders both.
  it("renders both context parts when the chat and the task share a title", () => {
    modelMock.value = model({
      background: [
        backgroundRow({
          label: "10min heartbeat",
          chatTitle: "General Conversation History",
          taskTitle: "General Conversation History",
        }),
      ],
    });
    render(<HomeFocusView />);

    const context = screen.getByTestId("home-focus-row-context");
    expect(
      Array.from(context.querySelectorAll("[data-role]")).map((part) =>
        part.getAttribute("data-role"),
      ),
    ).toEqual(["chat", "task"]);
    expect(context.textContent).toBe(
      "·in General Conversation History·General Conversation History",
    );
  });
});

describe("<HomeFocusView /> unlabelled row group", () => {
  it("renders the rows directly under the section, with no wrapper", () => {
    modelMock.value = model({ background: [backgroundRow({})] });
    render(<HomeFocusView />);

    const section = screen.getByTestId("home-focus-section-background");
    const list = section.querySelector("ul");
    expect(list).not.toBeNull();
    // The list is the section's own child, not nested in a group box.
    expect(list?.parentElement).toBe(section);
    expect(
      screen.queryByTestId("home-focus-section-background-group-label"),
    ).toBeNull();
  });
});
