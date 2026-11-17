/**
 * A bot's Activity page, the reporting controls of a watched task when the bot
 * ends the task under them, and when the real negotiated manifest decides
 * whether they are there. Same real page, stores and boundaries as
 * `bot-activity-page.test.tsx`.
 */
import { type ReactNode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  Harness,
  REPORT_METHODS,
  endedRowFor,
  focusMenuItem,
  focusReturns,
  openEndReportingByKeyboard,
  periodic,
  row,
  task,
  installPageCaseLifecycle,
} from "@/components/bots/__tests__/bot-activity-page-support";

import {
  offer,
  mountReal,
  openButton,
  trigger,
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

describe("<BotActivityPage /> a task whose reporting ends while its confirmation closes", () => {
  const endedByBot = (): BotTaskEntry =>
    task("t-every", {
      cadence: { kind: "none" },
      state: "ended",
      endedReason: "by-bot",
      inputNeeded: [],
    });

  it.each([
    ["the stop answers first, then the snapshot ends the task", true],
    ["the snapshot ends the task first, then the stop answers", false],
  ] as const)(
    "the same Reporting actions trigger stays mounted and holds focus when %s",
    async (_order, stopAnswersFirst) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      mocks.stop.hold = true;
      const view = render(
        <Harness
          threads={[]}
          tasks={[periodic("t-every", {})]}
          boundHere
          notificationSubscriptions={null}
        />,
      );
      const trigger = await openEndReportingByKeyboard(user);
      await user.click(screen.getByRole("button", { name: "End reporting" }));
      const endTask = (): void =>
        view.rerender(
          <Harness
            threads={[]}
            tasks={[endedByBot()]}
            boundHere
            notificationSubscriptions={null}
          />,
        );
      const answerStop = async (): Promise<void> => {
        const back = focusReturns(trigger);
        act(() => mocks.stop.settle?.("success"));
        await back;
      };

      if (stopAnswersFirst) {
        await answerStop();
        endTask();
      } else {
        endTask();
        await answerStop();
      }

      expect(trigger.isConnected).toBe(true);
      expect(document.activeElement).toBe(trigger);
      expect(
        within(endedRowFor("t-every")).getByRole("button", {
          name: "Reporting actions",
        }),
      ).toBe(trigger);
      expect(mocks.actions).toHaveLength(1);
    },
    5_000,
  );
});

describe("<BotActivityPage /> a task the bot ends while its confirmation is open", () => {
  const tracking = (): BotTaskEntry => periodic("t-every", {});
  const endedByBot = (): BotTaskEntry =>
    task("t-every", {
      cadence: { kind: "none" },
      state: "ended",
      endedReason: "by-bot",
      inputNeeded: [],
    });
  const harness = (tasks: ReadonlyArray<BotTaskEntry>): ReactNode => (
    <Harness
      threads={[]}
      tasks={tasks}
      boundHere
      notificationSubscriptions={null}
    />
  );

  it("closes the confirmation, returns focus to the same Reporting actions trigger and sends no stop; a later tracking snapshot does not bring it back", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    const view = render(harness([tracking()]));
    const trigger = await openEndReportingByKeyboard(user);

    const returned = focusReturns(trigger);
    view.rerender(harness([endedByBot()]));
    await returned;

    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(
      within(endedRowFor("t-every")).getByRole("button", {
        name: "Reporting actions",
      }),
    ).toBe(trigger);
    expect(mocks.actions).toEqual([]);

    view.rerender(harness([tracking()]));

    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(mocks.actions).toEqual([]);
  }, 5_000);

  it("opens a fresh confirmation after the task tracks again, and Cancel on it still sends nothing", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    const view = render(harness([tracking()]));
    const first = await openEndReportingByKeyboard(user);
    const returned = focusReturns(first);
    view.rerender(harness([endedByBot()]));
    await returned;
    view.rerender(harness([tracking()]));

    await openEndReportingByKeyboard(user);
    expect(screen.getAllByText("End reporting?")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(mocks.actions).toEqual([]);
  }, 5_000);
});

describe("<BotActivityPage /> a task the bot ends while its menu is open", () => {
  const tracking = (): BotTaskEntry => periodic("t-every", {});
  const endedByBot = (): BotTaskEntry =>
    task("t-every", {
      cadence: { kind: "none" },
      state: "ended",
      endedReason: "by-bot",
      inputNeeded: [],
    });
  const harness = (tasks: ReadonlyArray<BotTaskEntry>): ReactNode => (
    <Harness
      threads={[]}
      tasks={tasks}
      boundHere
      notificationSubscriptions={null}
    />
  );

  it("closes the menu, returns focus to the same Reporting actions trigger and sends nothing; a later tracking snapshot does not reopen it", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    const view = render(harness([tracking()]));
    const trigger = within(row("t-every")).getByRole("button", {
      name: "Reporting actions",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const item = screen.getByRole("menuitem", { name: "Check in now" });
    for (let step = 0; step < 6 && document.activeElement !== item; step += 1)
      await user.keyboard("{ArrowDown}");
    if (document.activeElement !== item)
      throw new Error("arrow keys never reached Check in now");

    const returned = focusReturns(trigger);
    view.rerender(harness([endedByBot()]));
    await returned;

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(
      within(endedRowFor("t-every")).getByRole("button", {
        name: "Reporting actions",
      }),
    ).toBe(trigger);
    expect(mocks.actions).toEqual([]);

    view.rerender(harness([tracking()]));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(mocks.actions).toEqual([]);
  }, 5_000);
});

describe("<BotActivityPage /> reporting controls and the real negotiated manifest, with no parent rerender", () => {
  it("moves focus from a focused trigger to the row open button when every method is lost, and a restore steals nothing", () => {
    mountReal();
    trigger().focus();

    offer([]);

    expect(document.activeElement).toBe(openButton());
    offer(REPORT_METHODS);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(openButton());
    expect(mocks.actions).toHaveLength(0);
  });

  it("closes an open menu with an item focused, lands on the row open button, and a restore does not reopen it", async () => {
    const user = userEvent.setup();
    mountReal();
    await focusMenuItem(user, "Check in now");

    offer([]);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(openButton());
    offer(REPORT_METHODS);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(openButton());
    expect(mocks.actions).toHaveLength(0);
  });

  it.each([
    ["Check in now", "bot.task.runNow"],
    ["Pause reports", "bot.task.setPaused"],
    ["End reporting…", "bot.task.stop"],
  ] as const)(
    "closes the menu and returns focus to the same trigger when only the focused %s action is lost, sends nothing, and a restore does not reopen it",
    async (item, lost) => {
      const user = userEvent.setup();
      mountReal();
      const reporting = trigger();
      await focusMenuItem(user, item);
      const refocused = new Promise<void>((resolve) => {
        reporting.addEventListener("focus", () => resolve(), { once: true });
      });

      offer(REPORT_METHODS.filter((method) => method !== lost));
      await refocused;

      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(reporting);
      expect(mocks.actions).toHaveLength(0);
      offer(REPORT_METHODS);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(reporting);
      expect(mocks.actions).toHaveLength(0);
    },
    5_000,
  );

  it.each([
    ["Check in now", "bot.task.runNow", "Pause reports"],
    ["Pause reports", "bot.task.setPaused", "Check in now"],
    ["End reporting…", "bot.task.stop", "Check in now"],
  ] as const)(
    "when only the %s action is lost while focus is on the %s item of the same menu, the menu stays open without it, focus stays on that item, nothing is sent, and a restore moves no focus",
    async (lostItem, lost, focusedItem) => {
      const user = userEvent.setup();
      mountReal();
      await focusMenuItem(user, focusedItem);
      const focused = screen.getByRole("menuitem", { name: focusedItem });

      offer(REPORT_METHODS.filter((method) => method !== lost));

      expect(screen.getByRole("menu")).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: lostItem })).toBeNull();
      expect(document.activeElement).toBe(focused);
      expect(mocks.actions).toHaveLength(0);
      offer(REPORT_METHODS);
      expect(document.activeElement).toBe(focused);
      expect(mocks.actions).toHaveLength(0);
    },
    5_000,
  );

  it("keeps focus on the body after a direct blur from the trigger when a lost manifest then removes the controls", () => {
    mountReal();
    trigger().focus();
    trigger().blur();
    expect(document.activeElement).toBe(document.body);

    offer([]);

    expect(document.activeElement).toBe(document.body);
    offer(REPORT_METHODS);
    expect(document.activeElement).toBe(document.body);
  });
});
