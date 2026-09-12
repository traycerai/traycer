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
  FocusBrowserRow,
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
  openBrowser: vi.fn(),
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

/** The fleet this page sees, and which of it is active. A single unnamed host
 * is the default, which is the ungrouped page most cases here expect. */
const fleetMock = vi.hoisted(() => ({
  activeHostId: null as string | null,
  entries: [] as Array<{ hostId: string; label: string }>,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => fleetMock.activeHostId,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: fleetMock.entries }),
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
    browserTabTitle: null,
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
    hostUnattributed: false,
    stoppable: true,
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
    hostId: "host-local",
    label: "dev server",
    kind: "managed-command",
    itemKind: null,
    startedAtMs: Date.now(),
    stoppable: true,
    ...overrides,
  };
}

function browserRow(overrides: Partial<FocusBrowserRow>): FocusBrowserRow {
  const tabId = overrides.tabId ?? nextId("tab");
  return {
    key: overrides.key ?? `host-local\u001fsession-1\u001f${tabId}`,
    epicId: "epic-1",
    taskTitle: "Storefront",
    hostId: "host-local",
    sessionId: "session-1",
    tabId,
    title: "Checkout",
    urlHost: "shop.example.com",
    url: "https://shop.example.com/checkout",
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
  actionsMock.openBrowser.mockReset();
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
  fleetMock.activeHostId = null;
  fleetMock.entries = [];
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ home: DEFAULT_HOME_LAYOUT });
});

/** Every task group row on the page, in document order. */
function taskGroups(): HTMLElement[] {
  return screen.queryAllByTestId("home-focus-task-group");
}

/**
 * Opens every task row that has anything under it.
 *
 * The page starts fully COLLAPSED - there is no count-based expand-all any
 * more - so a test about what hangs under a task has to get there first. The
 * disclosure suites below deliberately do not call this: the closed state is
 * what they are asserting.
 */
function openEveryTask(): void {
  for (const twisty of screen.queryAllByTestId(
    "home-focus-task-group-disclosure",
  )) {
    if (twisty.hasAttribute("disabled")) continue;
    if (twisty.getAttribute("aria-expanded") === "true") continue;
    fireEvent.click(twisty);
  }
}

function taskGroup(epicId: string): HTMLElement {
  const found = taskGroups().find(
    (element) => element.getAttribute("data-epic-id") === epicId,
  );
  if (found === undefined) throw new Error(`no group for ${epicId}`);
  return found;
}

/** One chat row's `<li>`, which owns both the row itself and its level-2 list. */
function chatRow(group: HTMLElement, agentId: string): HTMLElement {
  const found = within(group)
    .queryAllByTestId("home-focus-task-group-chat")
    .find((element) => element.getAttribute("data-agent-id") === agentId);
  if (found === undefined) throw new Error(`no chat row for ${agentId}`);
  return found;
}

function sectionOf(name: "needs-you" | "running"): HTMLElement {
  return screen.getByTestId(`home-focus-section-${name}`);
}

function headingOf(name: "needs-you" | "running"): string {
  return screen.getByTestId(`home-focus-section-${name}-heading`).textContent;
}

describe("<HomeFocusView /> section presence", () => {
  it("splits the tasks into Needs you and Running", () => {
    modelMock.value = model({
      tasks: [
        taskRow({ epicId: "epic-waiting", needsYou: true }),
        taskRow({ epicId: "epic-busy" }),
      ],
    });
    render(<HomeFocusView />);

    expect(
      within(sectionOf("needs-you"))
        .getAllByTestId("home-focus-task-group")
        .map((element) => element.getAttribute("data-epic-id")),
    ).toEqual(["epic-waiting"]);
    expect(
      within(sectionOf("running"))
        .getAllByTestId("home-focus-task-group")
        .map((element) => element.getAttribute("data-epic-id")),
    ).toEqual(["epic-busy"]);
  });

  // The page used to carry a flat prompt list above a task list that named the
  // same task again, so a task waiting on an approval appeared twice.
  it("draws no flat prompt list, and puts the waiting task in Needs you once", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1" })],
      prompts: [promptRow({ epicId: "epic-1" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-section-prompts")).toBeNull();
    expect(taskGroups()).toHaveLength(1);
    expect(screen.queryByTestId("home-focus-section-running")).toBeNull();
    expect(headingOf("needs-you")).toBe("Needs you · 1");
  });

  it("omits a section with nothing in it", () => {
    modelMock.value = model({ tasks: [taskRow({})] });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-section-needs-you")).toBeNull();
    expect(screen.getByTestId("home-focus-section-running")).toBeDefined();
  });

  it("renders only the empty state when there is nothing at all", () => {
    modelMock.value = model({});
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-empty")).toBeDefined();
    expect(taskGroups()).toHaveLength(0);
    expect(screen.queryByTestId("home-focus-summary")).toBeNull();
  });

  // The flat list is gone, so "the model has prompts" no longer implies "the
  // page has rows": a prompt reaches the page through the task it names.
  it("is not empty when a prompt names no task at all", () => {
    modelMock.value = model({
      prompts: [promptRow({ epicId: null, taskTitle: null })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
    expect(screen.getAllByTestId("home-focus-prompt-row")).toHaveLength(1);
  });
});

describe("<HomeFocusView /> section headings", () => {
  it("names each heading by count alone", () => {
    modelMock.value = model({
      tasks: [
        taskRow({ epicId: "epic-a", needsYou: true }),
        taskRow({ epicId: "epic-b" }),
        taskRow({ epicId: "epic-c" }),
      ],
    });
    render(<HomeFocusView />);

    expect(headingOf("needs-you")).toBe("Needs you · 1");
    expect(headingOf("running")).toBe("Running · 2");
  });

  it("keeps every caption out of the heading and on its own line", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-a" })],
    });
    render(<HomeFocusView />);

    expect(headingOf("running")).toBe("Running · 1");
    expect(
      screen
        .getAllByTestId("home-focus-section-running-caption")
        .map((element) => element.textContent),
    ).toEqual(["Background shown for tasks open in this window"]);
  });

  // Two independent limits bind this section - how far the notification feed
  // reaches, and how far the window-local background plane does - so they get
  // a line each rather than being run together.
  it("states the feed's reach under Needs you when notifications are local", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-a", needsYou: true })],
      coverage: {
        activity: "live",
        degradedHostIds: [],
        notifications: "local",
        backgroundIsMountedOnly: true,
        browsersAreMountedOnly: true,
      },
    });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-section-needs-you-caption")
        .map((element) => element.textContent),
    ).toEqual([
      "this host only",
      "Background shown for tasks open in this window",
    ]);
  });

  it("omits the feed caption when the notifications are the cloud feed", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-a", needsYou: true })],
    });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-section-needs-you-caption")
        .map((element) => element.textContent),
    ).toEqual(["Background shown for tasks open in this window"]);
  });
});

describe("<HomeFocusView /> summary line", () => {
  it("reads the two sections it draws, counting their top-level rows", () => {
    modelMock.value = model({
      tasks: [
        taskRow({ epicId: "epic-a", needsYou: true }),
        taskRow({ epicId: "epic-b" }),
        taskRow({ epicId: "epic-c" }),
      ],
    });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-summary-segment")
        .map((element) => element.textContent),
    ).toEqual(["1 need you", "2 running"]);
  });

  it("omits a segment whose count is zero", () => {
    modelMock.value = model({ tasks: [taskRow({ epicId: "epic-a" })] });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-summary-segment")
        .map((element) => element.getAttribute("data-segment")),
    ).toEqual(["running"]);
  });

  it("points each segment at a section that is actually mounted", () => {
    modelMock.value = model({
      tasks: [
        taskRow({ epicId: "epic-a", needsYou: true }),
        taskRow({ epicId: "epic-b" }),
      ],
    });
    render(<HomeFocusView />);

    for (const segment of screen.getAllByTestId("home-focus-summary-segment")) {
      const target = segment.getAttribute("data-target");
      expect(target).not.toBeNull();
      expect(document.getElementById(target ?? "")).not.toBeNull();
    }
  });

  it("counts an unplaced prompt in the Needs you segment", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-a", needsYou: true })],
      prompts: [promptRow({ epicId: null, taskTitle: null })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-summary-segment")
        .map((element) => element.textContent),
    ).toEqual(["2 need you"]);
    expect(headingOf("needs-you")).toBe("Needs you · 2");
  });
});

describe("<HomeFocusView /> nesting inside a task", () => {
  it("puts a job under the chat running it, with no `in <chat>` context", () => {
    modelMock.value = model({
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
          chatTitle: "Greeting and Introduction",
          label: "10min heartbeat",
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const chat = chatRow(taskGroup("epic-1"), "chat-1");
    const job = within(chat).getByTestId("home-focus-task-group-job");
    expect(within(job).getByTestId("home-focus-row-name").textContent).toBe(
      "10min heartbeat",
    );
    // The row above says the chat, so the row does not have to.
    expect(within(job).queryByTestId("home-focus-row-context")).toBeNull();
    expect(job.parentElement).toBe(
      within(chat).getByTestId("home-focus-task-group-chat-body"),
    );
  });

  // The chat is the parent row rather than hidden. The rule this replaced
  // dropped it, so the job row had to name it, and the page read as a monitor
  // name followed by the conversation it was in.
  it("lists an idle chat that only hosts a job as the parent row", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({
              agentId: "chat-1",
              title: "Greeting and Introduction",
              tier: "background",
            }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1", chatId: "chat-1" })],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const chat = chatRow(taskGroup("epic-1"), "chat-1");
    const row = within(chat).getByTestId("home-focus-task-group-agent");
    expect(within(row).getByTestId("home-focus-row-name").textContent).toBe(
      "Greeting and Introduction",
    );
    expect(
      within(row)
        .getByTestId("home-focus-row-status")
        .getAttribute("data-state"),
    ).toBe("background");
    expect(
      within(chat).getAllByTestId("home-focus-task-group-job"),
    ).toHaveLength(1);
    // There is no Background section for it to appear in a second time.
    expect(screen.queryByTestId("home-focus-section-background")).toBeNull();
  });

  it("keeps a job whose chat is not a row here at task level, naming its chat", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      background: [
        backgroundRow({
          epicId: "epic-1",
          chatId: "chat-gone",
          chatTitle: "Old chat",
          label: "dev server",
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-1");
    const body = within(group).getByTestId("home-focus-task-group-body");
    const job = within(body).getByTestId("home-focus-task-group-job");
    expect(job.parentElement).toBe(body);
    expect(within(job).getByTestId("home-focus-row-context").textContent).toBe(
      "·in Old chat",
    );
  });

  it("puts a driven tab under its chat and an undriven one under the task", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "Reviewer" })],
        }),
      ],
      browsers: [
        browserRow({
          epicId: "epic-1",
          tabId: "driven",
          title: "Checkout",
          drivenByChatId: "chat-1",
          drivenByAgentName: "Reviewer",
        }),
        browserRow({ epicId: "epic-1", tabId: "loose", title: "Docs" }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-1");
    const chat = chatRow(group, "chat-1");
    expect(
      within(chat)
        .getAllByTestId("home-focus-task-group-browser")
        .map(
          (element) =>
            within(element).getByTestId("home-focus-row-name").textContent,
        ),
    ).toEqual(["Checkout"]);

    const body = within(group).getByTestId("home-focus-task-group-body");
    const loose = within(body)
      .getAllByTestId("home-focus-task-group-browser")
      .filter((element) => element.parentElement === body);
    expect(
      within(loose[0]).getByTestId("home-focus-row-name").textContent,
    ).toBe("Docs");
  });

  it("puts a prompt under the chat it was raised in", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      prompts: [promptRow({ epicId: "epic-1", chatId: "chat-1" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    openEveryTask();

    const chat = chatRow(taskGroup("epic-1"), "chat-1");
    const prompt = within(chat).getByTestId("home-focus-prompt-row");
    expect(within(prompt).getByTestId("home-focus-row-name").textContent).toBe(
      "Approve: run bun test — The agent wants to run a command.",
    );
    expect(
      within(prompt)
        .getByTestId("home-focus-row-status")
        .getAttribute("data-state"),
    ).toBe("needs-you");
    // The task is the row two levels up; repeating it is the concatenation
    // this design removes.
    expect(within(prompt).queryByTestId("home-focus-row-context")).toBeNull();
  });

  // A browser hand-off names a session and a tab and never a conversation.
  it("puts a browser prompt under the task, naming the tab it is about", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      prompts: [
        promptRow({
          epicId: "epic-1",
          chatId: null,
          kind: "browser",
          title: "Needs you in the browser",
          body: "",
          browserTabTitle: "Checkout",
        }),
      ],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-1");
    const body = within(group).getByTestId("home-focus-task-group-body");
    const prompt = within(body).getByTestId("home-focus-prompt-row");
    expect(prompt.parentElement).toBe(body);
    expect(
      within(prompt).getByTestId("home-focus-row-context").textContent,
    ).toBe("·Checkout");
    expect(
      within(chatRow(group, "chat-1")).queryByTestId("home-focus-prompt-row"),
    ).toBeNull();
  });

  it("opens the chat from a nested prompt's body", () => {
    const row = promptRow({ epicId: "epic-1", chatId: "chat-1" });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      prompts: [row],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    openEveryTask();

    fireEvent.click(screen.getByTestId("home-focus-prompt-open-body"));
    expect(actionsMock.openPrompt).toHaveBeenCalledWith(row);
  });

  it("opens the task, the chat and the job from their own rows", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1", chatId: "chat-1" })],
    });
    render(<HomeFocusView />);
    openEveryTask();

    fireEvent.click(screen.getByTestId("home-focus-task-group-open-body"));
    expect(actionsMock.openTask).toHaveBeenCalledWith("epic-1");

    fireEvent.click(screen.getByTestId("home-focus-task-group-agent-body"));
    expect(actionsMock.openAgent).toHaveBeenCalledWith("epic-1", "chat-1");

    fireEvent.click(screen.getByTestId("home-focus-task-group-job-body"));
    expect(actionsMock.openBackground).toHaveBeenCalledTimes(1);
  });

  it("names the agent that started a chat instead of indenting it again", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "root", title: "impl" }),
            agentRow({ agentId: "child", title: "reviewer", parentId: "root" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-1");
    const child = chatRow(group, "child");
    expect(
      within(child).getByTestId("home-focus-task-group-agent-via").textContent,
    ).toBe("via impl");
    // Still a sibling of its parent: the indent under a chat is its own work's.
    expect(child.parentElement).toBe(
      within(group).getByTestId("home-focus-task-group-body"),
    );
  });
});

describe("<HomeFocusView /> stop controls", () => {
  it("stops one chat's agent from the chat row, cascading, on its own host", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "impl", hostId: "host-a" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    fireEvent.click(screen.getByTestId("home-focus-agent-stop"));
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-1",
      agentId: "chat-1",
      hostId: "host-a",
      cascade: true,
    });
  });

  // The conversation is not what is running - the monitor beneath
  // it is, and that row carries its own Stop.
  it("gives an idle chat that only hosts jobs no Stop of its own", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "Host", tier: "background" }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1", chatId: "chat-1" })],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const chat = chatRow(taskGroup("epic-1"), "chat-1");
    const row = within(chat).getByTestId("home-focus-task-group-agent");
    expect(within(row).queryByTestId("home-focus-agent-stop")).toBeNull();
    // The track is still reserved, or the status column above it moves.
    expect(within(row).getByTestId("home-focus-row-actions")).toBeDefined();
    expect(
      within(chat).getAllByTestId("home-focus-background-stop"),
    ).toHaveLength(1);
  });

  // A background-tier chat with NO job row here is a run this window has no
  // durable row for - hiding its stop would leave no way to end it.
  it("keeps the Stop on a background-tier chat with no job beneath it", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "Host", tier: "background" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    expect(screen.getByTestId("home-focus-agent-stop")).toBeDefined();
  });

  it("disables a chat's Stop with a reason when it cannot be routed", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "impl", stoppable: false }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const stop = screen.getByTestId("home-focus-agent-stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(stop.getAttribute("aria-label")).toContain("Runs on another device");
    expect(tooltipTriggerOf(stop)).toBeDefined();
  });

  it("disables a chat's Stop while that stop is in flight", () => {
    actionsMock.stopping.add("chat-1");
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    expect(
      screen.getByTestId("home-focus-agent-stop").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("stops a job from its own row", () => {
    const job = backgroundRow({ epicId: "epic-1", chatId: "chat-1" });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      background: [job],
    });
    render(<HomeFocusView />);
    openEveryTask();

    fireEvent.click(screen.getByTestId("home-focus-background-stop"));
    expect(actionsMock.stopManagedCommand).toHaveBeenCalledWith(job);
  });

  // A background item's stop is a warm-session action, so it exists in the
  // job's own chat and nowhere else - including here.
  it("sends a background item's disabled stop to the chat rather than another device", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      background: [
        backgroundRow({
          epicId: "epic-1",
          chatId: "chat-1",
          kind: "background-item",
          itemKind: "monitor",
          stoppable: false,
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const stop = screen.getByTestId("home-focus-background-stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(stop.getAttribute("aria-label")).toContain(
      "Stop this from the chat",
    );
  });

  it("stops a single-agent task directly from the task row", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "only", title: "impl", hostId: "host-a" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-stop"));
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-1",
      agentId: "only",
      hostId: "host-a",
      cascade: true,
    });
  });

  it("stops only the roots once, behind a confirmation that lists every agent", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "root", title: "impl" }),
            agentRow({ agentId: "child", title: "reviewer", parentId: "root" }),
            agentRow({ agentId: "other", title: "docs" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    expect(
      within(screen.getByTestId("home-focus-stop-all-list")).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(3);

    fireEvent.click(screen.getByTestId("home-focus-stop-all-confirm"));
    expect(
      actionsMock.stopAgent.mock.calls.map(
        (call: ReadonlyArray<{ agentId: string }>) => call[0].agentId,
      ),
    ).toEqual(["root", "other"]);
  });

  it("cancels the stop-all dialog without calling anything", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "a", title: "impl" }),
            agentRow({ agentId: "b", title: "docs" }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    fireEvent.click(screen.getByTestId("home-focus-stop-all-cancel"));
    expect(screen.queryByTestId("home-focus-stop-all-dialog")).toBeNull();
    expect(actionsMock.stopAgent).not.toHaveBeenCalled();
  });

  it("leaves no stop on a browser row, and still reserves the track", () => {
    modelMock.value = model({
      browsers: [browserRow({ epicId: "epic-1" })],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const browser = screen.getByTestId("home-focus-task-group-browser");
    expect(
      within(browser).getByTestId("home-focus-row-actions").textContent,
    ).toBe("");
  });
});

describe("<HomeFocusView /> task row badges", () => {
  it("counts prompts, mid-turn agents, jobs and pages over the whole subtree", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "impl", tier: "turn" }),
            agentRow({ agentId: "chat-2", title: "host", tier: "background" }),
          ],
        }),
      ],
      prompts: [promptRow({ epicId: "epic-1", chatId: "chat-1" })],
      background: [
        backgroundRow({ key: "j1", epicId: "epic-1", chatId: "chat-2" }),
        backgroundRow({ key: "j2", epicId: "epic-1", chatId: "chat-unknown" }),
      ],
      browsers: [browserRow({ epicId: "epic-1", tabId: "t1" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    const group = taskGroup("epic-1");
    expect(
      within(group).getByTestId("home-focus-task-group-needs").textContent,
    ).toBe("1 need you");
    expect(
      within(group).getByTestId("home-focus-task-group-active").textContent,
    ).toBe("1 active");
    // One job under a chat and one at task level: the badge counts both.
    expect(
      within(group).getByTestId("home-focus-task-group-jobs").textContent,
    ).toBe("2 bg");
    expect(
      within(group).getByTestId("home-focus-task-group-browsers").textContent,
    ).toBe("1 browser");
  });

  it("omits the needs-you badge for a task whose indicator alone says so", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1", needsYou: true })],
    });
    render(<HomeFocusView />);

    const group = taskGroup("epic-1");
    expect(
      within(group).queryByTestId("home-focus-task-group-needs"),
    ).toBeNull();
    expect(
      within(group).getByTestId("home-focus-task-attention"),
    ).toBeDefined();
  });

  it("omits the active badge for a task that is here on its jobs alone", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "host", tier: "background" }),
          ],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1", chatId: "chat-1" })],
    });
    render(<HomeFocusView />);

    const group = taskGroup("epic-1");
    expect(
      within(group).queryByTestId("home-focus-task-group-active"),
    ).toBeNull();
    expect(
      within(group).getByTestId("home-focus-task-group-jobs").textContent,
    ).toBe("1 bg");
  });

  // `mountedHere` is the wider question, and a "0 bg" read off it would claim
  // a task has nothing running when the truth is this window cannot tell.
  it("omits the bg badge for a mounted task with no warm chat in this window", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1", mountedHere: true })],
      background: [backgroundRow({ epicId: "epic-other" })],
    });
    render(<HomeFocusView />);

    expect(
      within(taskGroup("epic-1")).queryByTestId("home-focus-task-group-jobs"),
    ).toBeNull();
  });

  it("omits the browsers badge at zero", () => {
    modelMock.value = model({ tasks: [taskRow({ epicId: "epic-1" })] });
    render(<HomeFocusView />);

    expect(
      within(taskGroup("epic-1")).queryByTestId(
        "home-focus-task-group-browsers",
      ),
    ).toBeNull();
  });
});

describe("<HomeFocusView /> a cold task", () => {
  function coldTask(overrides: Partial<FocusModel>): void {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          taskTitle: "Docs sweep",
          mountedHere: false,
          agents: [
            agentRow({ agentId: "a", title: null, surface: null }),
            agentRow({ agentId: "b", title: null, surface: null }),
          ],
        }),
      ],
      ...overrides,
    });
  }

  // The defect this suite was rewritten for: a cold task drew one flat line
  // with an `invisible` twisty, so the only way to get a chevron was to open
  // the task once and mount it.
  it("carries an enabled twisty, collapsed, with its agents hidden behind it", () => {
    coldTask({});
    render(<HomeFocusView />);

    const group = taskGroup("epic-cold");
    const twisty = within(group).getByTestId(
      "home-focus-task-group-disclosure",
    );
    expect(twisty.className).not.toContain("invisible");
    expect(twisty.hasAttribute("disabled")).toBe(false);
    expect(twisty.getAttribute("aria-expanded")).toBe("false");
    expect(
      within(group).queryAllByTestId("home-focus-task-group-chat"),
    ).toHaveLength(0);
  });

  it("reveals one chat row per agent, under a borrowed name and its own tier", () => {
    coldTask({});
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-cold");
    expect(
      within(group)
        .getAllByTestId("home-focus-task-group-chat")
        .map((element) => element.getAttribute("data-agent-id")),
    ).toEqual(["a", "b"]);
    const row = chatRow(group, "a");
    // No title and no surface is what the activity plane reports for a cold
    // agent, so the row says what it is rather than what it is called.
    expect(within(row).getByTestId("home-focus-row-name").textContent).toBe(
      "Agent",
    );
    const status = within(row).getByTestId("home-focus-row-status");
    expect(status.getAttribute("data-state")).toBe("turn");
    expect(status.textContent).toBe("turn");
    // The neutral placeholder, not an absent glyph and not a borrowed one: a
    // name with nothing in the icon column reads as broken, and a
    // `MessageSquare` would claim a surface nobody here established.
    expect(
      within(row)
        .getByTestId("home-focus-agent-glyph")
        .getAttribute("data-surface"),
    ).toBe("unknown");
  });

  // Said once, on the row the reader actually meets, because the task is
  // collapsed by default and a caveat behind a click is a caveat nobody sees.
  it("keeps `not open in this window` on the summary and off the chat rows", () => {
    coldTask({});
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-cold");
    expect(
      within(group).getByTestId("home-focus-cold-agents").textContent,
    ).toContain("2 agents");
    expect(
      within(chatRow(group, "a")).queryByTestId("home-focus-cold-agents"),
    ).toBeNull();
    expect(screen.getAllByText(/not open in this window/)).toHaveLength(1);
  });

  it("opens the chat by id from a cold chat row", () => {
    coldTask({});
    render(<HomeFocusView />);
    openEveryTask();

    fireEvent.click(
      within(chatRow(taskGroup("epic-cold"), "b")).getByTestId(
        "home-focus-task-group-agent-body",
      ),
    );
    expect(actionsMock.openAgent).toHaveBeenCalledWith("epic-cold", "b");
    expect(actionsMock.openTask).not.toHaveBeenCalled();
  });

  it("stops one cold agent from its own row, cascading, on its own host", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          taskTitle: "Docs sweep",
          mountedHere: false,
          agents: [
            agentRow({ agentId: "a", title: null, surface: null }),
            agentRow({
              agentId: "b",
              title: null,
              surface: null,
              hostId: "host-remote",
            }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    fireEvent.click(
      within(chatRow(taskGroup("epic-cold"), "b")).getByTestId(
        "home-focus-agent-stop",
      ),
    );
    expect(actionsMock.stopAgent).toHaveBeenCalledWith({
      epicId: "epic-cold",
      agentId: "b",
      hostId: "host-remote",
      cascade: true,
    });
  });

  it("disables a cold agent's Stop when it cannot be routed", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          mountedHere: false,
          stoppable: false,
          agents: [
            agentRow({ agentId: "a", title: null, surface: null }),
            agentRow({
              agentId: "b",
              title: null,
              surface: null,
              stoppable: false,
            }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const stop = within(chatRow(taskGroup("epic-cold"), "b")).getByTestId(
      "home-focus-agent-stop",
    );
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(stop.getAttribute("aria-label")).toContain("Runs on another device");
  });

  it("still reveals its jobs, and hangs one on the chat whose id it names", () => {
    coldTask({
      background: [
        backgroundRow({
          epicId: "epic-cold",
          chatId: "a",
          chatTitle: "Warm chat",
          label: "watch tests",
        }),
        backgroundRow({
          epicId: "epic-cold",
          chatId: "chat-gone",
          chatTitle: "Another chat",
          label: "watch docs",
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-cold");
    // The nested one needs no `in <chat>`: the row above it says so.
    const nested = within(chatRow(group, "a")).getByTestId(
      "home-focus-task-group-job",
    );
    expect(within(nested).getByTestId("home-focus-row-name").textContent).toBe(
      "watch tests",
    );
    expect(within(nested).queryByTestId("home-focus-row-context")).toBeNull();
    // The one whose chat is not a row here stays at task level and keeps it.
    const loose = within(group)
      .getAllByTestId("home-focus-task-group-job")
      .filter((element) => !chatRow(group, "a").contains(element));
    expect(loose).toHaveLength(1);
    expect(
      within(loose[0]).getByTestId("home-focus-row-context").textContent,
    ).toBe("·in Another chat");
  });

  it("shows the attention glyph and nests no prompt when only the indicator says so", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-cold",
          mountedHere: false,
          needsYou: true,
          agents: [agentRow({ title: null, surface: null })],
        }),
      ],
    });
    render(<HomeFocusView />);

    const group = taskGroup("epic-cold");
    expect(
      within(group).getByTestId("home-focus-task-attention"),
    ).toBeDefined();
    expect(within(group).queryByTestId("home-focus-prompt-row")).toBeNull();
    expect(
      within(sectionOf("needs-you")).getAllByTestId("home-focus-task-group"),
    ).toHaveLength(1);
  });

  it("opens from its summary row", () => {
    coldTask({});
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-task-group-open-body"));
    expect(actionsMock.openTask).toHaveBeenCalledWith("epic-cold");
  });
});

describe("<HomeFocusView /> unplaced prompts", () => {
  // The tab badge counts prompts, so a prompt no group can carry would leave a
  // badge over a page showing nothing.
  it("lists a prompt that names no task under Needs you, after the tasks", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-a", needsYou: true })],
      prompts: [promptRow({ epicId: null, taskTitle: null })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    const section = sectionOf("needs-you");
    expect(
      within(section).getAllByTestId("home-focus-task-group"),
    ).toHaveLength(1);
    expect(
      within(section).getAllByTestId("home-focus-prompt-row"),
    ).toHaveLength(1);
  });

  it("gives such a prompt its task name back when it has one", () => {
    // An epic with a pending prompt and no running agent, warm chat or page:
    // nothing mints a group for it, and the row still has to say where it is.
    modelMock.value = model({
      tasks: [],
      prompts: [promptRow({ epicId: "epic-gone", taskTitle: "Payments" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-row-context").textContent).toBe(
      "·in Payments",
    );
  });
});

describe("<HomeFocusView /> disclosure", () => {
  function tasks(count: number): ReadonlyArray<FocusTaskRow> {
    return Array.from({ length: count }, (_unused, index) =>
      taskRow({
        epicId: `epic-${String(index)}`,
        agents: [agentRow({ agentId: `chat-${String(index)}`, title: "impl" })],
      }),
    );
  }

  function expandedFlags(): ReadonlyArray<string | null> {
    return screen
      .getAllByTestId("home-focus-task-group-disclosure")
      .map((element) => element.getAttribute("aria-expanded"));
  }

  // Replaces the old count-based default outright. A page whose rows open
  // themselves below some threshold reads one way on a quiet morning and
  // another way beside four other tasks, and the user asked for neither.
  it("starts a lone task collapsed", () => {
    modelMock.value = model({ tasks: tasks(1) });
    render(<HomeFocusView />);

    expect(expandedFlags()).toEqual(["false"]);
  });

  it("starts two tasks collapsed", () => {
    modelMock.value = model({ tasks: tasks(2) });
    render(<HomeFocusView />);

    expect(expandedFlags()).toEqual(["false", "false"]);
  });

  it("starts five tasks collapsed too", () => {
    modelMock.value = model({ tasks: tasks(5) });
    render(<HomeFocusView />);

    expect(expandedFlags()).toEqual([
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
  });

  // Both sections, since the default is per row rather than per page and a
  // section split cannot change it.
  it("starts collapsed in Needs you as well as Running", () => {
    modelMock.value = model({
      tasks: [
        ...tasks(2).map((task) => ({ ...task, needsYou: true })),
        ...tasks(2).map((task) => ({
          ...task,
          epicId: `${task.epicId}-running`,
        })),
      ],
    });
    render(<HomeFocusView />);

    expect(expandedFlags()).toEqual(["false", "false", "false", "false"]);
  });

  it("toggles one row without touching its neighbours, and without opening the task", () => {
    modelMock.value = model({ tasks: tasks(2) });
    render(<HomeFocusView />);

    const twisties = screen.getAllByTestId("home-focus-task-group-disclosure");
    fireEvent.click(twisties[0]);
    expect(twisties[0].getAttribute("aria-expanded")).toBe("true");
    expect(twisties[1].getAttribute("aria-expanded")).toBe("false");
    expect(actionsMock.openTask).not.toHaveBeenCalled();
  });

  it("closes a row the user opened when they press it again", () => {
    modelMock.value = model({ tasks: tasks(1) });
    render(<HomeFocusView />);

    const twisty = screen.getByTestId("home-focus-task-group-disclosure");
    fireEvent.click(twisty);
    expect(screen.getByTestId("home-focus-task-group-body")).toBeDefined();
    fireEvent.click(twisty);
    expect(twisty.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("home-focus-task-group-body")).toBeNull();
  });

  it("points the disclosure at the body it controls", () => {
    modelMock.value = model({ tasks: tasks(1) });
    render(<HomeFocusView />);
    openEveryTask();

    const twisty = screen.getByTestId("home-focus-task-group-disclosure");
    const body = screen.getByTestId("home-focus-task-group-body");
    expect(twisty.getAttribute("aria-controls")).toBe(body.getAttribute("id"));
  });

  // The one row shape with nothing underneath: a task the indicator flags as
  // waiting, whose agents this window can neither name nor list.
  it("hides the twisty for a task with no child row at all", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-bare",
          needsYou: true,
          mountedHere: false,
          agents: [],
        }),
      ],
    });
    render(<HomeFocusView />);

    const twisty = screen.getByTestId("home-focus-task-group-disclosure");
    expect(twisty.className).toContain("invisible");
    expect(twisty.hasAttribute("disabled")).toBe(true);
  });

  // `ROW_BODY_CLASS` stretches an overlay across the whole row, and the twisty
  // comes BEFORE the body button in tree order - `relative` alone would tie on
  // paint order and lose every click.
  it("lifts the leading disclosure over the body's stretched overlay", () => {
    modelMock.value = model({ tasks: tasks(1) });
    render(<HomeFocusView />);

    expect(
      screen.getByTestId("home-focus-task-group-disclosure").className,
    ).toContain("z-10");
  });
});

describe("<HomeFocusView /> density", () => {
  it("renders the comfortable row class by default", () => {
    modelMock.value = model({ tasks: [taskRow({ epicId: "epic-1" })] });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-task-group-row").className).toBe(
      ROW_CLASS,
    );
  });

  it("tightens the desktop row under compact and restores it under a coarse pointer", () => {
    useLayoutStore.setState({ home: { density: "compact" } });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      background: [backgroundRow({ epicId: "epic-1", chatId: "chat-1" })],
    });
    render(<HomeFocusView />);
    openEveryTask();

    for (const testId of [
      "home-focus-task-group-row",
      "home-focus-task-group-agent",
      "home-focus-task-group-job",
    ]) {
      const row = screen.getByTestId(testId);
      expect(row.className).toContain("p-2");
      expect(row.className).toContain("pointer-coarse:p-3");
      expect(row.getAttribute("data-density")).toBe("compact");
    }
  });
});

describe("<HomeFocusView /> row vocabulary", () => {
  it("gives a chat, a terminal agent, a command and a background item their own glyphs", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "chat", surface: "chat" }),
            agentRow({
              agentId: "chat-2",
              title: "tui",
              surface: "terminal-agent",
            }),
          ],
        }),
      ],
      background: [
        backgroundRow({
          key: "cmd",
          epicId: "epic-1",
          chatId: "chat-1",
          kind: "managed-command",
          itemKind: null,
        }),
        backgroundRow({
          key: "item",
          epicId: "epic-1",
          chatId: "chat-2",
          kind: "background-item",
          itemKind: "monitor",
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    expect(
      screen
        .getAllByTestId("home-focus-agent-glyph")
        .map((element) => element.getAttribute("data-surface")),
    ).toEqual(["chat", "terminal-agent"]);
    expect(
      screen
        .getAllByTestId("home-focus-background-glyph")
        .map((element) => element.getAttribute("data-item-kind")),
    ).toEqual([null, "monitor"]);
  });

  it("draws no agent glyph when the surface is unknown", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", surface: null })],
        }),
      ],
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-agent-glyph")).toBeNull();
  });

  it("keeps the section headings text, with no glyph of their own", () => {
    modelMock.value = model({ tasks: [taskRow({ epicId: "epic-1" })] });
    render(<HomeFocusView />);

    expect(
      screen
        .getByTestId("home-focus-section-running-heading")
        .querySelector("svg"),
    ).toBeNull();
  });

  it("renders 'Untitled task' when the title is null", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1", taskTitle: null })],
    });
    render(<HomeFocusView />);

    expect(
      within(taskGroup("epic-1")).getAllByTestId("home-focus-row-name")[0]
        .textContent,
    ).toBe("Untitled task");
  });
});

describe("<HomeFocusView /> status column", () => {
  it("answers every row shape in the same column", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [
            agentRow({ agentId: "chat-1", title: "impl", tier: "turn" }),
            agentRow({ agentId: "chat-2", title: "host", tier: "background" }),
          ],
        }),
      ],
      background: [
        backgroundRow({
          epicId: "epic-1",
          chatId: "chat-2",
          startedAtMs: Date.now() - 5 * 60 * 1000,
        }),
      ],
      browsers: [
        browserRow({
          epicId: "epic-1",
          drivenByChatId: "chat-1",
          drivenByAgentName: "impl",
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const group = taskGroup("epic-1");
    expect(
      within(group)
        .getAllByTestId("home-focus-row-status")
        .map((element) => element.getAttribute("data-state")),
    ).toEqual(["turn", "turn", "live", "background", "running"]);
    expect(
      within(
        within(group).getAllByTestId("home-focus-task-group-job")[0],
      ).getByTestId("home-focus-row-status-duration").textContent,
    ).toBe("· 5m");
  });

  it("keeps `driven by` in the status cell of a tab nested under its driver", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "Reviewer" })],
        }),
      ],
      browsers: [
        browserRow({
          epicId: "epic-1",
          drivenByChatId: "chat-1",
          drivenByAgentName: "Reviewer",
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    expect(screen.getByTestId("home-focus-row-status-note").textContent).toBe(
      "· driven by Reviewer",
    );
  });

  it("gives a task with no agent of its own the waiting state", () => {
    modelMock.value = model({
      background: [backgroundRow({ epicId: "epic-idle", chatId: "chat-1" })],
    });
    render(<HomeFocusView />);

    expect(
      within(taskGroup("epic-idle"))
        .getAllByTestId("home-focus-row-status")[0]
        .getAttribute("data-state"),
    ).toBe("waiting");
  });

  it("shows an agent's word with no duration, since the plane has no start time", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const chat = chatRow(taskGroup("epic-1"), "chat-1");
    expect(
      within(chat).queryByTestId("home-focus-row-status-duration"),
    ).toBeNull();
  });
});

describe("<HomeFocusView /> browsers", () => {
  it("opens the parked tile from a tab's row body", () => {
    const tab = browserRow({ epicId: "epic-1", tabId: "t1" });
    modelMock.value = model({ browsers: [tab] });
    render(<HomeFocusView />);
    openEveryTask();

    fireEvent.click(screen.getByTestId("home-focus-task-group-browser-body"));
    expect(actionsMock.openBrowser).toHaveBeenCalledWith(tab);
  });

  it("gives an epic whose only activity is a page a group of its own", () => {
    modelMock.value = model({
      browsers: [browserRow({ epicId: "epic-page", taskTitle: "Storefront" })],
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-empty")).toBeNull();
    expect(
      taskGroups().map((element) => element.getAttribute("data-epic-id")),
    ).toEqual(["epic-page"]);
  });

  it("reports the tab's own status word", () => {
    modelMock.value = model({
      browsers: [
        browserRow({ epicId: "epic-1", tabId: "a", status: "dormant" }),
        browserRow({ epicId: "epic-1", tabId: "b", status: "crashed" }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    expect(
      screen
        .getAllByTestId("home-focus-task-group-browser")
        .map((element) => element.getAttribute("data-status")),
    ).toEqual(["dormant", "crashed"]);
  });

  it("names the page and its site, and never the task it is already under", () => {
    modelMock.value = model({
      browsers: [
        browserRow({ epicId: "epic-1", title: "Checkout", taskTitle: "Shop" }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const browser = screen.getByTestId("home-focus-task-group-browser");
    expect(within(browser).getByTestId("home-focus-row-name").textContent).toBe(
      "Checkout",
    );
    expect(
      within(browser).getByTestId("home-focus-browser-url-host").textContent,
    ).toBe("shop.example.com");
    expect(within(browser).queryByTestId("home-focus-row-context")).toBeNull();
  });
});

describe("<HomeFocusView /> host grouping", () => {
  function twoHosts(): void {
    fleetMock.activeHostId = "host-local";
    fleetMock.entries = [
      { hostId: "host-local", label: "Laptop" },
      { hostId: "host-remote", label: "Remote Box" },
    ];
  }

  it("draws a subheading per machine, active first, with an `active` pill", () => {
    twoHosts();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-here",
          agents: [agentRow({ agentId: "a", hostId: "host-local" })],
        }),
        taskRow({
          epicId: "epic-there",
          agents: [agentRow({ agentId: "b", hostId: "host-remote" })],
        }),
      ],
    });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-section-running-group-label")
        .map((element) => element.textContent),
    ).toEqual(["Laptop · 1", "Remote Box · 1"]);
    expect(
      screen.getAllByTestId("home-focus-section-running-group-active"),
    ).toHaveLength(1);
  });

  it("draws a task worked from two hosts once under each, with a scoped Stop all", () => {
    twoHosts();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-shared",
          taskTitle: "Shared task",
          agents: [
            agentRow({ agentId: "a", title: "impl", hostId: "host-local" }),
            agentRow({
              agentId: "b",
              title: "reviewer",
              hostId: "host-remote",
            }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    expect(taskGroups()).toHaveLength(2);
    expect(
      screen
        .getAllByTestId("home-focus-task-stop")
        .map((element) => element.textContent),
    ).toEqual(["Stop", "Stop"]);
    // Each side holds one agent, so each row's stop is the single-agent form
    // and names only its own machine's work.
    expect(
      screen
        .getAllByTestId("home-focus-task-group-chat")
        .map((element) => element.getAttribute("data-agent-id")),
    ).toEqual(["a", "b"]);
  });

  it("groups inside each section separately", () => {
    twoHosts();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-waiting",
          needsYou: true,
          agents: [agentRow({ agentId: "a", hostId: "host-remote" })],
        }),
        taskRow({
          epicId: "epic-busy",
          agents: [agentRow({ agentId: "b", hostId: "host-local" })],
        }),
      ],
    });
    render(<HomeFocusView />);

    expect(
      screen
        .getAllByTestId("home-focus-section-needs-you-group-label")
        .map((element) => element.textContent),
    ).toEqual(["Remote Box · 1"]);
    expect(
      screen
        .getAllByTestId("home-focus-section-running-group-label")
        .map((element) => element.textContent),
    ).toEqual(["Laptop · 1"]);
  });

  it("puts the coverage notice under the host that earned it and stands the banner down", () => {
    twoHosts();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-here",
          agents: [agentRow({ agentId: "a", hostId: "host-local" })],
        }),
        taskRow({
          epicId: "epic-there",
          agents: [agentRow({ agentId: "b", hostId: "host-remote" })],
        }),
      ],
      coverage: {
        activity: "reconnecting",
        degradedHostIds: ["host-remote"],
        notifications: "cloud",
        backgroundIsMountedOnly: true,
        browsersAreMountedOnly: true,
      },
    });
    render(<HomeFocusView />);

    const notices = screen.getAllByTestId(
      "home-focus-section-running-group-notice",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toBe("Some activity may be missing");
    expect(screen.queryByTestId("home-focus-activity-notice")).toBeNull();
  });

  it("keeps the page-wide banner when nothing downstream can attribute the gap", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1" })],
      coverage: {
        activity: "disconnected",
        degradedHostIds: [],
        notifications: "cloud",
        backgroundIsMountedOnly: true,
        browsersAreMountedOnly: true,
      },
    });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-activity-notice")).toBeDefined();
  });

  it("says nothing at all while the activity plane has never answered", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1" })],
      coverage: {
        activity: "unknown",
        degradedHostIds: [],
        notifications: "cloud",
        backgroundIsMountedOnly: true,
        browsersAreMountedOnly: true,
      },
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-activity-notice")).toBeNull();
  });

  // The bucket is not a machine, so it never turns grouping on by itself - two
  // NAMED hosts do, and then the unattributed rows still get a group.
  it("files an agent nothing could attribute under Unknown host, last, unstoppable", () => {
    twoHosts();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-here",
          agents: [agentRow({ agentId: "a", hostId: "host-local" })],
        }),
        taskRow({
          epicId: "epic-there",
          agents: [agentRow({ agentId: "c", hostId: "host-remote" })],
        }),
        taskRow({
          epicId: "epic-nowhere",
          stoppable: false,
          agents: [
            agentRow({
              agentId: "b",
              title: "impl",
              hostId: null,
              hostUnattributed: true,
              stoppable: false,
            }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);
    openEveryTask();

    const labels = screen
      .getAllByTestId("home-focus-section-running-group-label")
      .map((element) => element.textContent);
    expect(labels[labels.length - 1]).toBe("Unknown host · 1");
    expect(
      within(taskGroup("epic-nowhere"))
        .getByTestId("home-focus-agent-stop")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps host names out of the visible summary and in its tooltip", () => {
    twoHosts();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-here",
          agents: [agentRow({ agentId: "a", hostId: "host-local" })],
        }),
        taskRow({
          epicId: "epic-there",
          agents: [agentRow({ agentId: "b", hostId: "host-remote" })],
        }),
      ],
    });
    render(<HomeFocusView />);

    const segment = screen.getByTestId("home-focus-summary-segment");
    expect(segment.textContent).toBe("2 running");
    expect(segment.getAttribute("data-hosts")).toBe("Laptop 1 · Remote Box 1");
  });
});

describe("<HomeFocusView /> origin host chip", () => {
  it("names the machine an unplaced prompt came from when it is not this one", () => {
    localHostMock.value = hostEntry({ hostId: "host-local" });
    hostDirectoryEntryMock.value = hostEntry({
      hostId: "host-remote",
      label: "Remote Box",
    });
    modelMock.value = model({
      prompts: [
        promptRow({
          epicId: null,
          taskTitle: null,
          originHostId: "host-remote",
        }),
      ],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-origin-host").textContent).toBe(
      "Remote Box",
    );
  });

  it("hides the chip when the prompt came from this machine", () => {
    localHostMock.value = hostEntry({ hostId: "host-local" });
    modelMock.value = model({
      prompts: [
        promptRow({
          epicId: null,
          taskTitle: null,
          originHostId: "host-local",
        }),
      ],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-origin-host")).toBeNull();
  });
});

describe("<HomeFocusView /> empty state", () => {
  it("navigates to a new draft from 'Start a new task'", () => {
    modelMock.value = model({});
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-empty-new-task"));
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("navigates to history from 'Open History'", () => {
    modelMock.value = model({});
    render(<HomeFocusView />);

    fireEvent.click(screen.getByTestId("home-focus-empty-history"));
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });
});

describe("<HomeFocusView /> live model updates", () => {
  it("reuses the same task row DOM node when the model updates in place", () => {
    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1", taskTitle: "Before" })],
    });
    const view = render(<HomeFocusView />);
    const before = screen.getByTestId("home-focus-task-group");

    modelMock.value = model({
      tasks: [taskRow({ epicId: "epic-1", taskTitle: "After" })],
    });
    view.rerender(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-task-group")).toBe(before);
    expect(
      within(before).getAllByTestId("home-focus-row-name")[0].textContent,
    ).toBe("After");
  });

  it("drops a task's disclosure state when the task leaves the model", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
    });
    const view = render(<HomeFocusView />);
    fireEvent.click(screen.getByTestId("home-focus-task-group-disclosure"));
    expect(
      screen
        .getByTestId("home-focus-task-group-disclosure")
        .getAttribute("aria-expanded"),
    ).toBe("true");

    modelMock.value = model({ tasks: [] });
    view.rerender(<HomeFocusView />);
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
    });
    view.rerender(<HomeFocusView />);

    // Back at the page's default, which is closed.
    expect(
      screen
        .getByTestId("home-focus-task-group-disclosure")
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});

describe("<HomeFocusView /> relative time ticking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("repaints the same DOM node from 'just now' to '1m' on the shared clock tick", () => {
    vi.useFakeTimers();
    const base = Date.now();
    modelMock.value = model({
      prompts: [
        promptRow({ epicId: null, taskTitle: null, createdAt: base - 30_000 }),
      ],
      badgeCount: 1,
    });
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

describe("<HomeFocusView /> has no trailing Open button", () => {
  // The row body already spans the card and opens the same thing, so a second
  // control was one extra tab stop per row announcing a verb the row had
  // already offered. Stop and Stop all stay.
  it("renders no Open control on any row shape", () => {
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
      prompts: [promptRow({ epicId: "epic-1", chatId: "chat-1" })],
      background: [backgroundRow({ epicId: "epic-1", chatId: "chat-1" })],
      browsers: [browserRow({ epicId: "epic-1", drivenByChatId: "chat-1" })],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(screen.queryByText("Open")).toBeNull();
  });

  // Three verbs on the task row, in the order a keyboard user meets them:
  // reveal, open, stop.
  it("orders the task row's focusable controls disclosure, body, then Stop", async () => {
    const user = userEvent.setup();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-1",
          agents: [agentRow({ agentId: "chat-1", title: "impl" })],
        }),
      ],
    });
    render(<HomeFocusView />);

    const row = screen.getByTestId("home-focus-task-group-row");
    await user.tab();
    await user.tab();
    expect(within(row).getByTestId("home-focus-task-group-disclosure")).toBe(
      document.activeElement,
    );
    await user.tab();
    expect(within(row).getByTestId("home-focus-task-group-open-body")).toBe(
      document.activeElement,
    );
    await user.tab();
    expect(within(row).getByTestId("home-focus-task-stop")).toBe(
      document.activeElement,
    );
  });
});

describe("<HomeFocusView /> coverage attribution for unplaced prompts", () => {
  function degradedRemote(): void {
    fleetMock.activeHostId = "host-local";
    fleetMock.entries = [
      { hostId: "host-local", label: "Laptop" },
      { hostId: "host-remote", label: "Remote Box" },
    ];
  }

  // The orphan-prompt tail has no subheading, so it can carry no notice. A
  // degraded host present ONLY as an orphan prompt therefore has nothing
  // saying the sentence in a better place, and the page-wide banner has to
  // stay - suppressing it drops the warning entirely.
  it("keeps the banner when a degraded host has only an unplaced prompt", () => {
    degradedRemote();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-here",
          agents: [agentRow({ agentId: "a", hostId: "host-local" })],
        }),
      ],
      prompts: [
        promptRow({
          epicId: null,
          taskTitle: null,
          originHostId: "host-remote",
        }),
      ],
      badgeCount: 1,
      coverage: {
        activity: "disconnected",
        degradedHostIds: ["host-remote"],
        notifications: "cloud",
        backgroundIsMountedOnly: true,
        browsersAreMountedOnly: true,
      },
    });
    render(<HomeFocusView />);

    expect(screen.getByTestId("home-focus-activity-notice")).toBeDefined();
    expect(
      screen.queryAllByTestId("home-focus-section-needs-you-group-notice"),
    ).toHaveLength(0);
  });

  it("still stands the banner down once that host has a group of its own", () => {
    degradedRemote();
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-here",
          agents: [agentRow({ agentId: "a", hostId: "host-local" })],
        }),
        taskRow({
          epicId: "epic-there",
          agents: [agentRow({ agentId: "b", hostId: "host-remote" })],
        }),
      ],
      prompts: [
        promptRow({
          epicId: null,
          taskTitle: null,
          originHostId: "host-remote",
        }),
      ],
      badgeCount: 1,
      coverage: {
        activity: "disconnected",
        degradedHostIds: ["host-remote"],
        notifications: "cloud",
        backgroundIsMountedOnly: true,
        browsersAreMountedOnly: true,
      },
    });
    render(<HomeFocusView />);

    expect(screen.queryByTestId("home-focus-activity-notice")).toBeNull();
    expect(
      screen.getAllByTestId("home-focus-section-running-group-notice"),
    ).toHaveLength(1);
  });

  // The chip is suppressed under a host heading because the heading already
  // says the machine. These rows deliberately have no heading.
  it("keeps the origin chip on an unplaced prompt while the page is grouped", () => {
    degradedRemote();
    localHostMock.value = hostEntry({ hostId: "host-local" });
    hostDirectoryEntryMock.value = hostEntry({
      hostId: "host-remote",
      label: "Remote Box",
    });
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-here",
          agents: [agentRow({ agentId: "a", hostId: "host-local" })],
        }),
        taskRow({
          epicId: "epic-there",
          needsYou: true,
          agents: [agentRow({ agentId: "b", hostId: "host-remote" })],
        }),
      ],
      prompts: [
        promptRow({
          epicId: null,
          taskTitle: null,
          originHostId: "host-remote",
        }),
      ],
      badgeCount: 1,
    });
    render(<HomeFocusView />);

    // Grouping is on - the headings are there - and the tail row still names
    // its machine, because no heading covers it.
    expect(
      screen.getAllByTestId("home-focus-section-needs-you-group-label").length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("home-focus-origin-host").textContent).toBe(
      "Remote Box",
    );
  });
});

/**
 * The suite that used to guard the expand-all latch, rewritten for the rule
 * that replaced it: nothing opens on its own, ever, and the only thing that
 * survives a model refresh is what the user opened by hand.
 *
 * The latch's own hazard is worth remembering even though the latch is gone.
 * This component renders from the app's first frame and the notification feed
 * can answer before the activity plane, so a page's first frame is routinely
 * task-less - a default read off the task COUNT had to wait for that frame and
 * then never re-decide. A default that is simply "closed" cannot be wrong on
 * any frame, which is the other half of why it replaced the latch.
 */
describe("<HomeFocusView /> no auto-expand", () => {
  function someTasks(count: number): ReadonlyArray<FocusTaskRow> {
    return Array.from({ length: count }, (_unused, index) =>
      taskRow({
        epicId: `epic-${String(index)}`,
        agents: [agentRow({ agentId: `chat-${String(index)}`, title: "impl" })],
      }),
    );
  }

  function expandedFlags(): ReadonlyArray<string | null> {
    return screen
      .getAllByTestId("home-focus-task-group-disclosure")
      .map((element) => element.getAttribute("aria-expanded"));
  }

  it("opens nothing when tasks arrive after an orphan-prompt-only first frame", () => {
    modelMock.value = model({
      prompts: [promptRow({ epicId: null, taskTitle: null })],
      badgeCount: 1,
    });
    const view = render(<HomeFocusView />);
    expect(screen.queryAllByTestId("home-focus-task-group")).toHaveLength(0);

    modelMock.value = model({
      prompts: [promptRow({ epicId: null, taskTitle: null })],
      tasks: someTasks(2),
      badgeCount: 1,
    });
    view.rerender(<HomeFocusView />);

    expect(expandedFlags()).toEqual(["false", "false"]);
  });

  it("opens nothing when tasks arrive after an empty first frame either", () => {
    modelMock.value = model({});
    const view = render(<HomeFocusView />);
    expect(screen.getByTestId("home-focus-empty")).toBeDefined();

    modelMock.value = model({ tasks: someTasks(2) });
    view.rerender(<HomeFocusView />);

    expect(expandedFlags()).toEqual(["false", "false"]);
  });

  // Two, then five: the count the old latch turned on, on both sides of it.
  it("leaves every task closed however few or many there are", () => {
    modelMock.value = model({ tasks: someTasks(2) });
    const view = render(<HomeFocusView />);
    expect(expandedFlags()).toEqual(["false", "false"]);

    modelMock.value = model({ tasks: someTasks(5) });
    view.rerender(<HomeFocusView />);
    expect(expandedFlags()).toEqual([
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
  });

  // The one thing a refresh must not undo: the live model repaints rows in
  // place, and a row the reader opened has to still be open afterwards.
  it("keeps a hand-opened row open across a model refresh that adds tasks", () => {
    modelMock.value = model({ tasks: someTasks(2) });
    const view = render(<HomeFocusView />);
    fireEvent.click(
      screen.getAllByTestId("home-focus-task-group-disclosure")[0],
    );
    expect(expandedFlags()).toEqual(["true", "false"]);

    modelMock.value = model({ tasks: someTasks(5) });
    view.rerender(<HomeFocusView />);

    expect(expandedFlags()).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(
      within(taskGroup("epic-0")).getAllByTestId("home-focus-task-group-chat"),
    ).toHaveLength(1);
  });
});

describe("<HomeFocusView /> disclosure across a section move", () => {
  function waitingTask(withPrompt: boolean): FocusModel {
    const tasks = [
      taskRow({
        epicId: "epic-moving",
        agents: [agentRow({ agentId: "chat-1", title: "impl" })],
      }),
      taskRow({
        epicId: "epic-a",
        agents: [agentRow({ agentId: "chat-a", title: "impl" })],
      }),
      taskRow({
        epicId: "epic-b",
        agents: [agentRow({ agentId: "chat-b", title: "impl" })],
      }),
      taskRow({
        epicId: "epic-c",
        agents: [agentRow({ agentId: "chat-c", title: "impl" })],
      }),
    ];
    return model({
      tasks,
      prompts: withPrompt
        ? [promptRow({ epicId: "epic-moving", chatId: "chat-1" })]
        : [],
      badgeCount: withPrompt ? 1 : 0,
    });
  }

  function disclosureOf(epicId: string): HTMLElement {
    return within(taskGroup(epicId)).getByTestId(
      "home-focus-task-group-disclosure",
    );
  }

  // Four tasks, so everything starts collapsed. Open the waiting one, then
  // answer its prompt: it moves from Needs you to Running, which is a
  // different subtree, and the row the user just opened must not close.
  it("keeps a row open when answering its prompt moves it to Running", () => {
    modelMock.value = waitingTask(true);
    const view = render(<HomeFocusView />);
    expect(
      within(sectionOf("needs-you")).getAllByTestId("home-focus-task-group"),
    ).toHaveLength(1);

    fireEvent.click(disclosureOf("epic-moving"));
    expect(disclosureOf("epic-moving").getAttribute("aria-expanded")).toBe(
      "true",
    );

    modelMock.value = waitingTask(false);
    view.rerender(<HomeFocusView />);

    expect(
      within(sectionOf("running"))
        .getAllByTestId("home-focus-task-group")
        .map((element) => element.getAttribute("data-epic-id")),
    ).toContain("epic-moving");
    expect(disclosureOf("epic-moving").getAttribute("aria-expanded")).toBe(
      "true",
    );
    // Its neighbours are untouched.
    expect(disclosureOf("epic-a").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a row open when a first prompt moves it to Needs you", () => {
    modelMock.value = waitingTask(false);
    const view = render(<HomeFocusView />);

    fireEvent.click(disclosureOf("epic-moving"));
    expect(disclosureOf("epic-moving").getAttribute("aria-expanded")).toBe(
      "true",
    );

    modelMock.value = waitingTask(true);
    view.rerender(<HomeFocusView />);

    expect(
      within(sectionOf("needs-you"))
        .getAllByTestId("home-focus-task-group")
        .map((element) => element.getAttribute("data-epic-id")),
    ).toEqual(["epic-moving"]);
    expect(disclosureOf("epic-moving").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("drops a task's choice once it leaves the model, and not before", () => {
    modelMock.value = waitingTask(false);
    const view = render(<HomeFocusView />);
    fireEvent.click(disclosureOf("epic-moving"));
    expect(disclosureOf("epic-moving").getAttribute("aria-expanded")).toBe(
      "true",
    );

    modelMock.value = model({
      tasks: waitingTask(false).tasks.filter(
        (task) => task.epicId !== "epic-moving",
      ),
    });
    view.rerender(<HomeFocusView />);
    modelMock.value = waitingTask(false);
    view.rerender(<HomeFocusView />);

    expect(disclosureOf("epic-moving").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  // Two machines' shares of one task are two rows the reader opens
  // independently, so they hold separate choices.
  it("opens each host's share of a split task on its own", () => {
    fleetMock.activeHostId = "host-local";
    fleetMock.entries = [
      { hostId: "host-local", label: "Laptop" },
      { hostId: "host-remote", label: "Remote Box" },
    ];
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-shared",
          agents: [
            agentRow({ agentId: "a", title: "impl", hostId: "host-local" }),
            agentRow({
              agentId: "b",
              title: "reviewer",
              hostId: "host-remote",
            }),
          ],
        }),
      ],
    });
    render(<HomeFocusView />);

    const twisties = screen.getAllByTestId("home-focus-task-group-disclosure");
    expect(twisties).toHaveLength(2);
    fireEvent.click(twisties[0]);
    expect(
      twisties.map((element) => element.getAttribute("aria-expanded")),
    ).toEqual(["true", "false"]);
  });
});

describe("<HomeFocusView /> a split task with a prompt on one host", () => {
  // The section is decided on the WHOLE task before the split, so both slices
  // stay in Needs you - and the prompt still nests only under the machine that
  // raised it, because the split files it there.
  it("lands once in Needs you and nests the prompt on that host alone", () => {
    fleetMock.activeHostId = "host-a";
    fleetMock.entries = [
      { hostId: "host-a", label: "Box A" },
      { hostId: "host-b", label: "Box B" },
    ];
    modelMock.value = model({
      tasks: [
        taskRow({
          epicId: "epic-shared",
          taskTitle: "Shared task",
          agents: [
            agentRow({ agentId: "chat-a", title: "impl", hostId: "host-a" }),
            agentRow({
              agentId: "chat-b",
              title: "reviewer",
              hostId: "host-b",
            }),
          ],
        }),
      ],
      prompts: [
        promptRow({
          epicId: "epic-shared",
          chatId: "chat-b",
          originHostId: "host-b",
        }),
      ],
      badgeCount: 1,
    });
    render(<HomeFocusView />);
    openEveryTask();

    // Both slices under Needs you, none under Running, and nothing left over.
    expect(screen.queryByTestId("home-focus-section-running")).toBeNull();
    const section = sectionOf("needs-you");
    expect(
      within(section).getAllByTestId("home-focus-task-group"),
    ).toHaveLength(2);
    expect(
      within(section)
        .getAllByTestId("home-focus-section-needs-you-group-label")
        .map((element) => element.textContent),
    ).toEqual(["Box A · 1", "Box B · 1"]);
    expect(headingOf("needs-you")).toBe("Needs you · 2");

    // The prompt is under B's reviewer chat, and A's slice carries neither the
    // row nor the badge.
    const groups = within(section).getAllByTestId("home-focus-task-group");
    expect(within(groups[0]).queryByTestId("home-focus-prompt-row")).toBeNull();
    expect(
      within(groups[0]).queryByTestId("home-focus-task-group-needs"),
    ).toBeNull();
    expect(
      within(chatRow(groups[1], "chat-b")).getAllByTestId(
        "home-focus-prompt-row",
      ),
    ).toHaveLength(1);
    expect(
      within(groups[1]).getByTestId("home-focus-task-group-needs").textContent,
    ).toBe("1 need you");
  });
});
