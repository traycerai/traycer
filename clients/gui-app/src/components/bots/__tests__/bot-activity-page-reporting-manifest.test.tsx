/**
 * A bot's Activity page, the reporting controls of a watched task when the real
 * negotiated manifest stops offering them and offers them again: where focus
 * goes, and what happens to an open menu, a confirmation and a sent stop. Same
 * real page, stores and boundaries as `bot-activity-page.test.tsx`.
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  REPORT_METHODS,
  type WarmAgent,
  completed,
  periodic,
  reachReportingSurface,
  row,
  task,
  warmTask,
  installPageCaseLifecycle,
} from "@/components/bots/__tests__/bot-activity-page-support";

import {
  offer,
  uiFor,
  ui,
  rowOf,
  mountReal,
  openButton,
  trigger,
  outside,
} from "@/components/bots/__tests__/bot-activity-page-manifest-support";

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

describe("<BotActivityPage /> reporting controls and the real negotiated manifest, with no parent rerender", () => {
  it.each([
    ["the trigger", () => trigger()],
    ["the row open button", () => openButton()],
  ] as const)(
    "keeps focus on the body after a direct blur from %s when the row then leaves the list",
    (_name, target) => {
      const view = mountReal();
      target().focus();
      target().blur();
      expect(document.activeElement).toBe(document.body);

      view.rerender(ui([]));

      expect(document.activeElement).toBe(document.body);
    },
  );

  it.each(
    [
      {
        name: "a non-every cadence",
        tasks: (): ReadonlyArray<BotTaskEntry> => [
          task("t-every", { inputNeeded: [] }),
        ],
        boundHere: true,
      },
      {
        name: "an unbound tab",
        tasks: (): ReadonlyArray<BotTaskEntry> => [periodic("t-every", {})],
        boundHere: false,
      },
      {
        name: "a task that ended but not by the bot",
        tasks: (): ReadonlyArray<BotTaskEntry> => [completed("t-every", {})],
        boundHere: true,
      },
      {
        name: "a row whose reporting trigger is present",
        tasks: (): ReadonlyArray<BotTaskEntry> => [periodic("t-every", {})],
        boundHere: true,
      },
    ].map((row) => ({
      ...row,
      how: "is removed",
      // Archiving an agent is not covered: through the task store alone the
      // archived agent's control stays in the page, so nothing was removed.
      after: (agents: ReadonlyArray<WarmAgent>): ReadonlyArray<WarmAgent> =>
        agents.slice(1),
    })),
  )(
    "moves focus from a focused agent of $name that $how, through the task store alone, to the row open button",
    async (scenario) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      const agents: ReadonlyArray<WarmAgent> = [
        { id: "a-one", parentId: null, title: "First", archivedAt: null },
        { id: "a-two", parentId: null, title: "Second", archivedAt: null },
      ];
      warmTask("t-every", agents);
      render(uiFor(scenario.tasks(), scenario.boundHere));
      await user.click(
        within(rowOf("t-every")).getByTestId("bot-activity-task-chevron"),
      );
      const found = rowOf("t-every").querySelector('[data-agent-id="a-one"]');
      const control =
        found instanceof HTMLButtonElement
          ? found
          : found?.querySelector("button");
      if (!(control instanceof HTMLButtonElement))
        throw new Error("the first agent has no button");
      control.focus();
      expect(document.activeElement).toBe(control);

      act(() => warmTask("t-every", scenario.after(agents)));

      expect(control.isConnected).toBe(false);
      expect(document.activeElement).toBe(
        within(rowOf("t-every")).getByTestId("bot-activity-task-open"),
      );
    },
    5_000,
  );

  it("keeps a sent stop's modal until it settles, then lands on the row open button, and a restore does not revive it", async () => {
    const user = userEvent.setup();
    mountReal();
    await reachReportingSurface(user, "stop in flight");

    offer([]);
    expect(screen.getByText("End reporting?")).toBeTruthy();
    act(() => mocks.stop.settle?.("success"));

    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(document.activeElement).toBe(openButton());
    offer(REPORT_METHODS);
    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(document.activeElement).toBe(openButton());
    expect(mocks.actions).toHaveLength(1);
  });

  it("closes an unsent confirmation when only stop is lost, sends nothing, and does not revive it when stop returns", async () => {
    const user = userEvent.setup();
    mountReal();
    await reachReportingSurface(user, "confirmation");

    offer(["bot.task.runNow", "bot.task.setPaused"]);

    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(mocks.actions).toHaveLength(0);
    offer(REPORT_METHODS);
    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mocks.actions).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps a sent stop pending when only stop is lost, closes it when it settles, and does not revive it when stop returns", async () => {
    const user = userEvent.setup();
    mountReal();
    await reachReportingSurface(user, "stop in flight");

    offer(["bot.task.runNow", "bot.task.setPaused"]);
    expect(screen.getByText("End reporting?")).toBeTruthy();
    act(() => mocks.stop.settle?.("success"));

    expect(screen.queryByText("End reporting?")).toBeNull();
    offer(REPORT_METHODS);
    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(mocks.actions).toHaveLength(1);
  });

  it("leaves focus on the body when the person has left the controls to a field and out of it, and the controls then go away by a lost manifest", () => {
    mountReal();
    trigger().focus();
    outside().focus();
    outside().blur();
    expect(document.activeElement).toBe(document.body);

    offer([]);

    expect(document.activeElement).toBe(document.body);
    offer(REPORT_METHODS);
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus on the body in the same case when the row leaves the list", () => {
    const view = mountReal();
    trigger().focus();
    outside().focus();
    outside().blur();
    expect(document.activeElement).toBe(document.body);

    view.rerender(ui([]));

    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus in the outside field when it holds the focus as the manifest is lost", () => {
    mountReal();
    trigger().focus();
    outside().focus();

    offer([]);

    expect(document.activeElement).toBe(outside());
  });

  it("moves focus from a focused agent that disappears to the row open button while the row and its trigger remain", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    const agents: ReadonlyArray<WarmAgent> = [
      { id: "a-one", parentId: null, title: "First", archivedAt: null },
      { id: "a-two", parentId: null, title: "Second", archivedAt: null },
    ];
    warmTask("t-every", agents);
    const view = render(ui([periodic("t-every", {})]));
    await user.click(
      within(row("t-every")).getByTestId("bot-activity-task-chevron"),
    );
    const agent = row("t-every").querySelector('[data-agent-id="a-one"]');
    const control =
      agent instanceof HTMLButtonElement
        ? agent
        : agent?.querySelector("button");
    if (!(control instanceof HTMLButtonElement))
      throw new Error("the first agent has no button");
    control.focus();
    expect(document.activeElement).toBe(control);

    act(() => warmTask("t-every", agents.slice(1)));
    view.rerender(ui([periodic("t-every", {})]));

    expect(control.isConnected).toBe(false);
    expect(trigger().isConnected).toBe(true);
    expect(document.activeElement).toBe(openButton());
  });
});
