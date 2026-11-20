/**
 * A bot's Activity page, the reporting controls of a watched task: the held
 * check-in, pause and stop, and ending reporting from the keyboard. Same real
 * page, stores and boundaries as `bot-activity-page.test.tsx`.
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  BOT_ID,
  REPORT_METHODS,
  focusMenuItem,
  focusReturns,
  mount,
  openEndReportingByKeyboard,
  openReportingMenu,
  periodic,
  row,
  installPageCaseLifecycle,
} from "@/components/bots/__tests__/bot-activity-page-support";

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

/** Whether the spinner's braille glyph is drawn inside `element`. */
const showsSpinner = (element: HTMLElement): boolean =>
  /[\u2800-\u28FF]/.test(element.textContent);

describe("<BotActivityPage /> a held check-in or pause", () => {
  it.each([
    ["Check in now", "bot.task.runNow", "runNow"],
    ["Pause reports", "bot.task.setPaused", "setPaused"],
  ] as const)(
    "after %s the menu closes and the unchanged Reporting actions trigger shows the spinner until the answer arrives, with one dispatch",
    async (item, method, key) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      mocks[key].hold = true;
      mount([periodic("t-every", {})], { boundHere: true });
      const trigger = within(row("t-every")).getByRole("button", {
        name: "Reporting actions",
      });
      expect(showsSpinner(trigger)).toBe(false);

      await openReportingMenu(user, "t-every");
      await user.click(screen.getByRole("menuitem", { name: item }));

      expect(screen.queryByRole("menu")).toBeNull();
      expect(
        within(row("t-every")).getByRole("button", {
          name: "Reporting actions",
        }),
      ).toBe(trigger);
      expect(showsSpinner(trigger)).toBe(true);
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(mocks.actions.map((action) => action.method)).toEqual([method]);

      act(() => mocks[key].settle?.());

      expect(showsSpinner(trigger)).toBe(false);
      expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
      expect(mocks.actions).toHaveLength(1);
    },
  );

  it.each([
    ["Check in now", "bot.task.runNow", "runNow"],
    ["Pause reports", "bot.task.setPaused", "setPaused"],
  ] as const)(
    "chosen with the keyboard, %s keeps focus on the same busy, aria-disabled trigger, ignores another activation, and still holds focus after the answer",
    async (item, method, key) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      mocks[key].hold = true;
      mount([periodic("t-every", {})], { boundHere: true });
      const trigger = within(row("t-every")).getByRole("button", {
        name: "Reporting actions",
      });
      trigger.focus();
      await user.keyboard("{Enter}");
      const target = screen.getByRole("menuitem", { name: item });
      for (
        let step = 0;
        step < 6 && document.activeElement !== target;
        step += 1
      )
        await user.keyboard("{ArrowDown}");
      if (document.activeElement !== target)
        throw new Error(`arrow keys never reached ${item}`);

      const returned = focusReturns(trigger);
      await user.keyboard("{Enter}");
      await returned;

      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-label")).toBe("Reporting actions");
      expect(trigger.getAttribute("aria-busy")).toBe("true");
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.hasAttribute("disabled")).toBe(false);
      expect(mocks.actions.map((action) => action.method)).toEqual([method]);

      await user.keyboard("{Enter}");

      expect(screen.queryByRole("menu")).toBeNull();
      expect(mocks.actions).toHaveLength(1);

      act(() => mocks[key].settle?.());

      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-busy")).toBe("false");
      expect(mocks.actions).toHaveLength(1);
    },
    5_000,
  );

  it.each([
    ["Check in now", "bot.task.runNow", "runNow"],
    ["Pause reports", "bot.task.setPaused", "setPaused"],
  ] as const)(
    "while %s is held, Space and a pointer click on the busy trigger neither reopen the menu nor dispatch again, and focus stays",
    async (item, method, key) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      mocks[key].hold = true;
      mount([periodic("t-every", {})], { boundHere: true });
      const trigger = within(row("t-every")).getByRole("button", {
        name: "Reporting actions",
      });
      await focusMenuItem(user, item);
      const returned = focusReturns(trigger);
      await user.keyboard("{Enter}");
      await returned;

      await user.keyboard(" ");

      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await user.click(trigger);

      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger.getAttribute("aria-busy")).toBe("true");
      expect(mocks.actions.map((action) => action.method)).toEqual([method]);

      act(() => mocks[key].settle?.());

      expect(trigger.getAttribute("aria-busy")).toBe("false");
      expect(mocks.actions).toHaveLength(1);
    },
    5_000,
  );

  it.each([
    ["Check in now", "bot.task.runNow", "runNow"],
    ["Pause reports", "bot.task.setPaused", "setPaused"],
  ] as const)(
    "when the held %s fails, focus stays on the same trigger, it stops being busy, and the menu opens again and can send it once more",
    async (item, method, key) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      mocks[key].hold = true;
      mount([periodic("t-every", {})], { boundHere: true });
      const trigger = within(row("t-every")).getByRole("button", {
        name: "Reporting actions",
      });
      await focusMenuItem(user, item);
      const returned = focusReturns(trigger);
      await user.keyboard("{Enter}");
      await returned;
      expect(trigger.getAttribute("aria-busy")).toBe("true");

      act(() => mocks[key].fail?.());

      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-busy")).toBe("false");
      expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
      expect(mocks.actions).toHaveLength(1);

      await user.keyboard("{Enter}");
      const again = screen.getByRole("menuitem", { name: item });
      expect(again.getAttribute("aria-disabled")).not.toBe("true");
      await user.click(again);

      expect(mocks.actions.map((action) => action.method)).toEqual([
        method,
        method,
      ]);
    },
    5_000,
  );
});

describe("<BotActivityPage /> ending reporting from the keyboard", () => {
  it.each([
    ["Cancel", "{Enter}"],
    ["Escape", "{Escape}"],
  ] as const)(
    "closing the confirmation with %s returns focus to the Reporting actions trigger and makes no call",
    async (way, key) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      mount([periodic("t-every", {})], { boundHere: true });

      const trigger = await openEndReportingByKeyboard(user);
      if (way === "Cancel")
        screen.getByRole("button", { name: "Cancel" }).focus();
      const returned = focusReturns(trigger);
      await user.keyboard(key);
      await returned;

      expect(screen.queryByText("End reporting?")).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.isConnected).toBe(true);
      expect(trigger.getAttribute("aria-label")).toBe("Reporting actions");
      expect(mocks.actions).toEqual([]);
    },
  );

  it("confirming sends one stop, keeps the confirmation open and its button disabled while the answer is held, then closes it on success with focus back on the trigger", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mocks.stop.hold = true;
    mount([periodic("t-every", {})], { boundHere: true });

    const trigger = await openEndReportingByKeyboard(user);
    const confirm = screen.getByRole("button", { name: "End reporting" });
    await user.click(confirm);
    await user.click(confirm);

    expect(mocks.actions).toEqual([
      {
        method: "bot.task.stop",
        variables: { botId: BOT_ID, taskId: "t-every" },
      },
    ]);
    expect(screen.getByText("End reporting?")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /^End reporting/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    const returned = focusReturns(trigger);
    act(() => mocks.stop.settle?.("success"));
    await returned;

    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mocks.actions).toHaveLength(1);
  });

  it("a refused stop leaves the confirmation open with End reporting usable again, and a retry sends the stop again", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mocks.stop.hold = true;
    mount([periodic("t-every", {})], { boundHere: true });

    await openEndReportingByKeyboard(user);
    await user.click(screen.getByRole("button", { name: "End reporting" }));
    act(() => mocks.stop.settle?.("failure"));

    expect(screen.getByText("End reporting?")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "End reporting" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    await user.click(retry);

    expect(mocks.actions.map((action) => action.method)).toEqual([
      "bot.task.stop",
      "bot.task.stop",
    ]);
  });
});
