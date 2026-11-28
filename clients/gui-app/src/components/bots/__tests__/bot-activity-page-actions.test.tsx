/**
 * A bot's Activity page: the words and badges on a row, the row's actions, the
 * notification subscriptions it lists, the agents of a task and an inspected
 * task that ends. Same real page, stores and boundaries as
 * `bot-activity-page.test.tsx`.
 */
import { type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  BotNotificationSubscription,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { postThread } from "@/components/bots/__tests__/bot-turn-test-support";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  BOT_ID,
  HOST_ID,
  Harness,
  NOW,
  type WarmAgent,
  endedRowFor,
  mount,
  openReportingMenu,
  periodic,
  row,
  task,
  warmTask,
  working,
  installPageCaseLifecycle,
} from "@/components/bots/__tests__/bot-activity-page-support";
import {
  waiting,
  taskUnread,
  agentUnread,
  glyphKind,
  sidebarRollupKind,
  expandRow,
} from "@/components/bots/__tests__/bot-activity-page-listing-support";

vi.mock("@tanstack/react-router", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).routerMock(),
);
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock("@/hooks/host/use-tab-host-client", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).tabHostClientMock(),
);
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).taskContextsMock(),
);
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostSupportsMethodMock(
    await importOriginal<
      typeof import("@/hooks/host/use-host-supports-method")
    >(),
  ),
);
vi.mock("@/hooks/bots/use-bot-activity", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).botActivityMock(),
);
vi.mock("@/hooks/agent/use-host-reachability", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostReachabilityMock(),
);
vi.mock("@/hooks/bots/use-bot-task-action-mutations", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).taskActionMutationsMock(),
);
vi.mock("@/components/epic-canvas/sidebar/use-chat-row-open-ref", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).chatRowOpenRefMock(),
);
vi.mock("@/hooks/notifications/use-notification-host", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).notificationHostMock(),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostClientForHostIdMock(),
);
vi.mock("@/hooks/host/use-host-queries", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostQueriesMock(),
);

installPageCaseLifecycle();

describe("<BotActivityPage /> badges and words", () => {
  it("rule 5: a periodic task wears its reporting cadence in words and its next check-in on the second line", () => {
    mount([periodic("t-every", {})], { boundHere: true });

    const badge = within(row("t-every")).getByTestId("bot-activity-every");
    expect(badge.textContent).toBe("Reports every 2 hours");
    expect(
      within(row("t-every")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("next check-in");
  });

  it("rule 5: a task a surface waits on wears Needs you and says what it asks", () => {
    mount(
      [
        task("t-waiting", {
          inputNeeded: [waiting("a-1", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(
      within(row("t-waiting")).getByTestId("bot-activity-needs-you")
        .textContent,
    ).toBe("Needs you");
    expect(
      within(row("t-waiting")).getByTestId("bot-activity-task-line")
        .textContent,
    ).toContain("waiting on you: approve Merge the release PR");
  });

  it("rule 5: an on-completion task wears no cadence badge and the page says neither Automation nor One-off task", () => {
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-once", {})], { boundHere: true });

    expect(
      within(row("t-once")).queryByTestId("bot-activity-every"),
    ).toBeNull();
    expect(
      within(row("t-once")).queryByTestId("bot-activity-needs-you"),
    ).toBeNull();
    const text = screen.getByTestId("bot-activity-page").textContent;
    expect(text).not.toMatch(/every/i);
    expect(text).not.toContain("Automation");
    expect(text).not.toContain("One-off task");
  });

  it("rule 4: a cold task whose reporting host is unreachable says its agents are offline there", () => {
    mocks.state.unreachable.add("host-agents");
    mount(
      [
        task("t-waiting", {
          inputNeeded: [waiting("a-1", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(
      within(row("t-waiting")).getByTestId("bot-activity-task-offline")
        .textContent,
    ).toBe("agents on Studio Mac, offline");
  });

  it("a cold scheduled task no surface waits on says its status is unknown, without naming a host", () => {
    mocks.state.unreachable.add("host-agents");
    mount([periodic("t-every", {})], { boundHere: true });

    const text = row("t-every").textContent;
    expect(text).toContain("Status unknown");
    expect(text).not.toContain("offline");
    expect(text).not.toContain("Studio Mac");
    expect(
      within(row("t-every")).queryByTestId("bot-activity-task-offline"),
    ).toBeNull();
  });
});

describe("<BotActivityPage /> actions", () => {
  it("rule 7: a periodic task keeps Check in now, Pause reports and End reporting in its overflow, bound here; no other row has them", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set([
      "bot.task.runNow",
      "bot.task.setPaused",
      "bot.task.stop",
    ]);
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([periodic("t-every", {}), task("t-once", {})], { boundHere: true });

    expect(
      within(row("t-once")).queryByRole("button", {
        name: "Reporting actions",
      }),
    ).toBeNull();
    await openReportingMenu(user, "t-every");
    expect(screen.getByRole("menuitem", { name: "Check in now" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Pause reports" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "End reporting…" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("menuitem", { name: "Check in now" }));
    expect(mocks.actions).toEqual([
      {
        method: "bot.task.runNow",
        variables: { botId: BOT_ID, taskId: "t-every" },
      },
    ]);
  });

  it("rule 7: a click on a row's summary opens that task, and no row has a menu", async () => {
    const user = userEvent.setup();
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([periodic("t-every", {}), task("t-once", {})], { boundHere: true });

    expect(screen.queryByRole("button", { name: "Task actions" })).toBeNull();
    expect(screen.queryByText("Open the brief")).toBeNull();
    for (const taskId of ["t-every", "t-once"]) {
      mocks.navigateToTabIntent.mockClear();
      await user.click(
        within(row(taskId)).getByTestId("bot-activity-task-open"),
      );
      expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
      expect(mocks.navigateToTabIntent.mock.calls[0][1]).toMatchObject({
        kind: "open-epic",
        epicId: taskId,
        // A list of the bot's tasks is a manual open: no way back to Tracy.
        tracyOrigin: null,
      });
    }
  });

  it("rule 7: Enter and Space on the focused summary open the task", async () => {
    const user = userEvent.setup();
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-once", {})], { boundHere: true });

    const open = within(row("t-once")).getByTestId("bot-activity-task-open");
    open.focus();
    await user.keyboard("{Enter}");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(2);
    for (const call of mocks.navigateToTabIntent.mock.calls) {
      expect(call[1]).toMatchObject({ kind: "open-epic", epicId: "t-once" });
    }
  });

  it("rule 7: the chevron and the overflow with its End confirmation do not open the task", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set([
      "bot.task.runNow",
      "bot.task.setPaused",
      "bot.task.stop",
    ]);
    warmTask("t-every", [
      { id: "a-root", parentId: null, title: "Lead", archivedAt: null },
    ]);
    mount([periodic("t-every", {})], { boundHere: true });

    await user.click(
      within(row("t-every")).getByTestId("bot-activity-task-chevron"),
    );
    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "Check in now" }));
    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "Pause reports" }));
    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "End reporting…" }));
    await user.click(screen.getByRole("button", { name: "End reporting" }));

    expect(mocks.actions.map((action) => action.method)).toEqual([
      "bot.task.runNow",
      "bot.task.setPaused",
      "bot.task.stop",
    ]);
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });
});

describe("<BotActivityPage /> watching notifications", () => {
  it("keeps every transcript action distinguishable when a thread has no name or two threads share one", async () => {
    const user = userEvent.setup();
    const base = postThread();
    if (base.anchor === null) throw new Error("thread fixture has no anchor");
    const anchor = base.anchor;
    const thread = (id: string, excerpt: string | null) => ({
      ...base,
      threadId: `thread-${id}`,
      sessionChatId: `chat-${id}`,
      anchor: { ...anchor, excerpt },
    });
    const threads = [
      thread("unnamed", null),
      thread("first", "Release plan"),
      thread("second", "Release plan"),
    ];
    const subscribed = (target: BotNotificationSubscription["target"]) => ({
      target,
      attentionOnly: false,
      everySeconds: null,
      since: null,
      digests: null,
    });
    render(
      <Harness
        tasks={[]}
        threads={threads}
        boundHere
        notificationSubscriptions={[
          subscribed({ kind: "trunk" }),
          ...threads.map((item) =>
            subscribed({ kind: "thread", threadId: item.threadId }),
          ),
        ]}
      />,
    );

    const actions = screen.getAllByRole("button", { name: /^Open transcript/ });
    const names = actions.map((action) => action.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(4);
    expect(names).toContain("Open transcript: Channel");
    expect(
      names.filter((name) => name?.startsWith("Open transcript: Thread ")),
    ).toHaveLength(1);
    expect(
      names.filter((name) => name?.startsWith("Open transcript: Release plan")),
    ).toHaveLength(2);

    for (const action of actions) await user.click(action);

    expect(
      mocks.openSession.mock.calls.map(([session]) => session.chatId).sort(),
    ).toEqual(["bot-trunk", "chat-first", "chat-second", "chat-unnamed"]);
  });

  it("keeps names unique when a third thread is titled exactly like the suffix generated for two duplicates", async () => {
    const user = userEvent.setup();
    const base = postThread();
    if (base.anchor === null) throw new Error("thread fixture has no anchor");
    const anchor = base.anchor;
    const thread = (id: string, excerpt: string) => ({
      ...base,
      threadId: `thread-${id}`,
      sessionChatId: `chat-${id}`,
      anchor: { ...anchor, excerpt },
    });
    const threads = [
      thread("first", "Release plan"),
      thread("second", "Release plan"),
      thread("lookalike", "Release plan (2)"),
    ];
    const subscribed = (target: BotNotificationSubscription["target"]) => ({
      target,
      attentionOnly: false,
      everySeconds: null,
      since: null,
      digests: null,
    });
    render(
      <Harness
        tasks={[]}
        threads={threads}
        boundHere
        notificationSubscriptions={[
          subscribed({ kind: "trunk" }),
          ...threads.map((item) =>
            subscribed({ kind: "thread", threadId: item.threadId }),
          ),
        ]}
      />,
    );

    const actions = screen.getAllByRole("button", { name: /^Open transcript/ });
    const names = actions.map((action) => action.getAttribute("aria-label"));
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);

    for (const action of actions) await user.click(action);

    expect(
      mocks.openSession.mock.calls.map(([session]) => session.chatId).sort(),
    ).toEqual(["bot-trunk", "chat-first", "chat-lookalike", "chat-second"]);
  });

  it("tells an equal-filter trunk and two named threads apart: each action is named for its destination and opens it, picked by name and never by position", async () => {
    const user = userEvent.setup();
    const base = postThread();
    if (base.anchor === null) throw new Error("thread fixture has no anchor");
    const anchor = base.anchor;
    const release = {
      ...base,
      threadId: "thread-release",
      sessionChatId: "chat-release",
      anchor: { ...anchor, excerpt: "Release plan" },
    };
    const billing = {
      ...base,
      threadId: "thread-billing",
      sessionChatId: "chat-billing",
      anchor: { ...anchor, excerpt: "Billing question" },
    };
    const subscribed = (target: BotNotificationSubscription["target"]) => ({
      target,
      attentionOnly: false,
      everySeconds: null,
      since: null,
      digests: null,
    });
    render(
      <Harness
        tasks={[]}
        threads={[release, billing]}
        boundHere
        notificationSubscriptions={[
          subscribed({ kind: "thread", threadId: billing.threadId }),
          subscribed({ kind: "trunk" }),
          subscribed({ kind: "thread", threadId: release.threadId }),
        ]}
      />,
    );

    const region = screen.getByRole("region", {
      name: "Notification subscriptions",
    });
    expect(region.textContent).toContain("Channel");
    expect(region.textContent).toContain("Release plan");
    expect(region.textContent).toContain("Billing question");
    expect(
      screen.getAllByRole("button", { name: /^Open transcript/ }),
    ).toHaveLength(3);
    expect(
      screen.queryByRole("button", { name: "Open transcript" }),
    ).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Open transcript: Release plan" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open transcript: Channel" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open transcript: Billing question" }),
    );

    expect(mocks.openSession.mock.calls).toEqual([
      [
        {
          chatId: "chat-release",
          threadId: "thread-release",
          messageId: null,
          sendPostId: null,
        },
      ],
      [
        {
          chatId: "bot-trunk",
          threadId: null,
          messageId: null,
          sendPostId: null,
        },
      ],
      [
        {
          chatId: "chat-billing",
          threadId: "thread-billing",
          messageId: null,
          sendPostId: null,
        },
      ],
    ]);
  });

  it("opens the trunk's session, and a thread's own, from each subscription's Open transcript action", async () => {
    const user = userEvent.setup();
    const base = postThread();
    if (base.anchor === null) throw new Error("thread fixture has no anchor");
    const thread = {
      ...base,
      anchor: { ...base.anchor, excerpt: "Release plan" },
    };
    render(
      <Harness
        tasks={[]}
        threads={[thread]}
        boundHere
        notificationSubscriptions={[
          {
            target: { kind: "trunk" },
            attentionOnly: false,
            everySeconds: null,
            since: null,
            digests: null,
          },
          {
            target: { kind: "thread", threadId: thread.threadId },
            attentionOnly: true,
            everySeconds: null,
            since: null,
            digests: null,
          },
        ]}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: /^Open transcript: / }),
    ).toHaveLength(2);
    expect(mocks.openSession).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Open transcript: Channel" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open transcript: Release plan" }),
    );

    expect(mocks.openSession.mock.calls).toEqual([
      [
        {
          chatId: "bot-trunk",
          threadId: null,
          messageId: null,
          sendPostId: null,
        },
      ],
      [
        {
          chatId: thread.sessionChatId,
          threadId: thread.threadId,
          messageId: null,
          sendPostId: null,
        },
      ],
    ]);
  });

  it.each([
    [true, "Needs attention only"],
    [false, "All notifications"],
  ] as const)(
    "shows the actual setting (attention only: %s) with no target, cadence or session link, and calls nothing",
    (attentionOnly, setting) => {
      render(
        <Harness
          threads={[]}
          tasks={[]}
          boundHere
          notificationSubscriptions={[
            {
              target: { kind: "trunk" },
              attentionOnly,
              everySeconds: null,
              since: null,
              digests: null,
            },
          ]}
        />,
      );

      const region = screen.getByRole("region", {
        name: "Notification subscriptions",
      });
      expect(region.textContent).toContain("Watching notifications");
      expect(region.textContent).toContain(setting);
      expect(region.textContent).not.toContain("Trunk");
      expect(region.textContent).not.toContain("Each burst");
      expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
      expect(mocks.actions).toEqual([]);
    },
  );
});

describe("<BotActivityPage /> the task's agents", () => {
  it.each(["local", "cloud"] as const)(
    "rule 4: a warm task folds its agents under a chevron, in tree order, each with its own state (%s feed)",
    async (feedMode) => {
      mocks.state.feedMode = feedMode;
      const user = userEvent.setup();
      warmTask("t-warm", [
        {
          id: "a-root",
          parentId: null,
          title: "Release lead",
          archivedAt: null,
        },
        {
          id: "a-child",
          parentId: "a-root",
          title: "Changelog",
          archivedAt: null,
        },
        { id: "a-idle", parentId: null, title: "Spare", archivedAt: null },
      ]);
      working({ "t-warm": { working: ["a-root"], turn: ["a-root"] } });
      agentUnread("a-child", { unreadDone: true });
      mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });

      expect(screen.queryByTestId("bot-activity-task-agents")).toBeNull();
      await user.click(
        within(row("t-warm")).getByTestId("bot-activity-task-chevron"),
      );

      const agents = within(
        within(row("t-warm")).getByTestId("bot-activity-task-agents"),
      ).getAllByTestId("bot-activity-agent");
      expect(
        agents.map((el) => [
          el.getAttribute("data-agent-id"),
          el.getAttribute("data-kind"),
        ]),
      ).toEqual([
        ["a-root", sidebarRollupKind([{ state: {}, tier: "turn" }])],
        [
          "a-child",
          sidebarRollupKind([{ state: { unreadDone: true }, tier: undefined }]),
        ],
        ["a-idle", "idle"],
      ]);
      expect(agents.map((el) => el.getAttribute("data-kind"))).toEqual([
        "running",
        "done",
        "idle",
      ]);
    },
  );

  it.each(["local", "cloud"] as const)(
    "rule 4: an archived agent stays folded away unless it is working or holds something unread (%s feed)",
    async (feedMode) => {
      mocks.state.feedMode = feedMode;
      const user = userEvent.setup();
      warmTask("t-warm", [
        { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
        { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
        { id: "a-unseen", parentId: null, title: "Unseen", archivedAt: 5 },
      ]);
      working({ "t-warm": { working: ["a-live"], turn: ["a-live"] } });
      agentUnread("a-unseen", { unreadDone: true });
      mount([task("t-warm", {})], { boundHere: true });

      await user.click(
        within(row("t-warm")).getByTestId("bot-activity-task-chevron"),
      );

      expect(
        screen
          .getAllByTestId("bot-activity-agent")
          .map((el) => el.getAttribute("data-agent-id")),
      ).toEqual(["a-live", "a-unseen"]);
    },
  );

  it("rule 4: a cold task, whose agents this window cannot name, has no chevron", () => {
    working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-cold", {})], { boundHere: true });

    expect(
      within(row("t-cold")).queryByTestId("bot-activity-task-chevron"),
    ).toBeNull();
  });
});

describe("<BotActivityPage /> an inspected task that ends", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-one", parentId: null, title: "Release agent", archivedAt: null },
  ];

  it("stays expanded with its agents, moves to the ended group with its reason, and navigates nowhere", async () => {
    mocks.state.taskTitles = { "t-open": "Inspected task" };
    warmTask("t-open", AGENTS);
    const view = render(
      <Harness
        threads={[]}
        tasks={[
          task("t-open", {
            cadence: { kind: "every", seconds: 7_200 },
            inputNeeded: [],
          }),
        ]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    await expandRow("t-open");
    expect(within(row("t-open")).getByText("Release agent")).toBeTruthy();
    mocks.navigateToTabIntent.mockClear();

    view.rerender(
      <Harness
        threads={[]}
        tasks={[
          task("t-open", {
            cadence: { kind: "none" },
            state: "ended",
            endedReason: "by-bot",
            inputNeeded: [],
          }),
        ]}
        boundHere
        notificationSubscriptions={null}
      />,
    );

    const ended = endedRowFor("t-open");
    expect(
      within(ended).getByRole("button", { name: "Hide agents" }),
    ).toBeTruthy();
    expect(within(ended).getByText("Release agent")).toBeTruthy();
    expect(
      within(ended).getByTestId("bot-activity-ended-reason").textContent,
    ).toBe("Reporting ended");
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  const PAGE = 20;
  const endedTask = (taskId: string): BotTaskEntry =>
    task(taskId, {
      cadence: { kind: "none" },
      state: "ended",
      endedReason: "completed",
      inputNeeded: [],
    });
  const endedIds = (): ReadonlyArray<string | null> =>
    screen
      .queryAllByTestId("bot-activity-ended-task")
      .map((el) => el.getAttribute("data-task-id"));
  const harness = (tasks: ReadonlyArray<BotTaskEntry>): ReactNode => (
    <Harness
      threads={[]}
      tasks={tasks}
      boundHere
      notificationSubscriptions={null}
    />
  );

  it("keeps an ended task with a pending indicator alone visible beyond the first page, and pages it again once it is addressed", () => {
    const tasks = Array.from({ length: PAGE + 5 }, (_value, index) =>
      endedTask(`t-e-${index}`),
    );
    mocks.state.epicFlags = { "t-e-0": { pendingApproval: true } };
    const view = render(harness(tasks));

    // The oldest task is last in reverse server order, past the first page.
    expect(endedIds()).toHaveLength(PAGE + 1);
    expect(endedIds()).toContain("t-e-0");
    expect(screen.getByRole("button", { name: "Show older" })).toBeTruthy();

    mocks.state.epicFlags = {};
    mocks.forgetAnswers();
    view.rerender(harness([...tasks]));

    expect(endedIds()).toHaveLength(PAGE);
    expect(endedIds()).not.toContain("t-e-0");
    expect(screen.getByRole("button", { name: "Show older" })).toBeTruthy();
  });

  it("keeps an ended task with an unread failure visible beyond the first page until it is seen", () => {
    const tasks = Array.from({ length: PAGE + 5 }, (_value, index) =>
      endedTask(`t-e-${index}`),
    );
    taskUnread("t-e-0", { unreadFailure: true });
    const view = render(harness(tasks));

    expect(endedIds()).toHaveLength(PAGE + 1);
    expect(endedIds()).toContain("t-e-0");

    mocks.state.epicFlags = {};
    mocks.forgetAnswers();
    view.rerender(harness([...tasks]));

    expect(endedIds()).toHaveLength(PAGE);
    expect(endedIds()).not.toContain("t-e-0");
  });

  it("shows an ended task whose agent still works with its reason and no running glyph or words, while a tracking task with a working agent still shows running", () => {
    warmTask("t-live", [
      { id: "a-live", parentId: null, title: "Live agent", archivedAt: null },
    ]);
    warmTask("t-ended", [
      { id: "a-late", parentId: null, title: "Late agent", archivedAt: null },
    ]);
    working({
      "t-live": { working: ["a-live"], turn: ["a-live"] },
      "t-ended": { working: ["a-late"], turn: ["a-late"] },
    });
    mount([task("t-live", { inputNeeded: [] }), endedTask("t-ended")], {
      boundHere: true,
    });

    expect(glyphKind("t-live")).toBe("running");
    const ended = endedRowFor("t-ended");
    const glyph = within(ended).getByTestId("bot-activity-task-glyph");
    expect(glyph.getAttribute("data-kind")).toBe("none");
    expect(glyph.getAttribute("aria-label")).toBeNull();
    expect(
      within(ended).getByTestId("bot-activity-ended-reason").textContent,
    ).toBe("Check-in completed");
    expect(ended.textContent).not.toMatch(
      /running|working|background|Status unknown/i,
    );
  });

  it("shows an ended periodic task with a future nextAt by its reason, with no next check-in or interval", () => {
    mount(
      [
        periodic("t-stopped", {
          state: "ended",
          endedReason: "by-bot",
          nextAt: NOW + 3_600_000,
        }),
      ],
      { boundHere: true },
    );

    const ended = screen
      .getAllByTestId("bot-activity-ended-task")
      .find((el) => el.getAttribute("data-task-id") === "t-stopped");
    if (ended === undefined) throw new Error("no ended row for t-stopped");
    expect(
      within(ended).getByTestId("bot-activity-ended-reason").textContent,
    ).toBe("Reporting ended");
    expect(within(ended).queryByTestId("bot-activity-every")).toBeNull();
    expect(ended.textContent).not.toMatch(/next check-in|every \d/i);
  });

  it("hides what an expanded ended task's agents wait on while the room is not fresh, and shows it again once it is", async () => {
    warmTask("t-open", [
      { id: "a-one", parentId: null, title: "Release agent", archivedAt: null },
    ]);
    const stale = (): BotTaskEntry =>
      task("t-open", {
        cadence: { kind: "none" },
        state: "ended",
        endedReason: "completed",
        inputNeeded: [waiting("a-one", NOW, "Merge the release PR")],
      });
    const view = render(harness([stale()]));
    await userEvent.setup().click(
      within(endedRowFor("t-open")).getByRole("button", {
        name: "Show agents",
      }),
    );
    expect(endedRowFor("t-open").textContent).toContain("Merge the release PR");

    // The bot's serving host drops: the waiting list the snapshot held is not current.
    mocks.state.unreachable.add(HOST_ID);
    view.rerender(harness([stale()]));

    const staleRow = endedRowFor("t-open");
    expect(within(staleRow).getByText("Release agent")).toBeTruthy();
    expect(
      within(staleRow).getByTestId("bot-activity-ended-reason").textContent,
    ).toBe("Check-in completed");
    expect(staleRow.textContent).not.toContain("Merge the release PR");
    expect(within(staleRow).queryByTestId("bot-activity-needs-you")).toBeNull();

    mocks.state.unreachable.delete(HOST_ID);
    view.rerender(harness([stale()]));
    expect(endedRowFor("t-open").textContent).toContain("Merge the release PR");
  });

  it("keeps an expanded task that ended behind a full page of newer ones visible with its agents, and lets it collapse", async () => {
    warmTask("t-open", [
      { id: "a-one", parentId: null, title: "Release agent", archivedAt: null },
    ]);
    const others = Array.from({ length: PAGE + 1 }, (_value, index) =>
      task(`t-other-${index}`, {
        cadence: { kind: "every", seconds: 7_200 },
        inputNeeded: [],
      }),
    );
    const open = task("t-open", {
      cadence: { kind: "every", seconds: 7_200 },
      inputNeeded: [],
    });
    const view = render(harness([open, ...others]));
    await expandRow("t-open");

    view.rerender(harness([endedTask("t-open"), ...others]));
    view.rerender(
      harness([
        endedTask("t-open"),
        ...others.map((other) => endedTask(other.taskId)),
      ]),
    );

    // Twenty-one tasks ended after it: it is past the first page, yet open.
    expect(endedIds()).toContain("t-open");
    expect(endedIds()).toHaveLength(PAGE + 1);
    const opened = endedRowFor("t-open");
    expect(within(opened).getByText("Release agent")).toBeTruthy();

    await userEvent
      .setup()
      .click(within(opened).getByRole("button", { name: "Hide agents" }));

    expect(screen.queryByText("Release agent")).toBeNull();
  });
});
