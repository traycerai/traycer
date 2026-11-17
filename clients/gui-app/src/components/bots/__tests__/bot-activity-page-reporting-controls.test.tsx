/**
 * A bot's Activity page, the reporting controls of a watched task: what they
 * say and offer, and when they are offered at all. Same real page, stores and
 * boundaries as `bot-activity-page.test.tsx`.
 */
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  BOT_ID,
  NOW,
  REPORT_METHODS,
  endedRowFor,
  mount,
  openReportingMenu,
  periodic,
  row,
  task,
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

describe("<BotActivityPage /> watched-task reporting controls", () => {
  it("says how often a task reports, and that a paused one is paused, with no inline buttons", () => {
    mocks.state.supported = new Set(REPORT_METHODS);
    mount(
      [
        periodic("t-every", {}),
        periodic("t-paused", { pause: { byUserId: "user-ada", since: NOW } }),
      ],
      { boundHere: true },
    );

    expect(row("t-every").textContent).toContain("Reports every 2 hours");
    expect(row("t-paused").textContent).toContain("Reports paused");
    expect(row("t-paused").textContent).not.toContain("Reports every");
    for (const testId of [
      "bot-task-run-now",
      "bot-task-pause",
      "bot-task-stop",
    ])
      expect(screen.queryByTestId(testId)).toBeNull();
  });

  it("does not promise a next check-in for a paused task that still carries a schedule", () => {
    mount(
      [
        periodic("t-paused", {
          pause: { byUserId: "user-ada", since: NOW },
          nextAt: NOW + 3_600_000,
        }),
      ],
      { boundHere: true },
    );

    const text = row("t-paused").textContent;
    expect(text).toContain("Reports paused");
    expect(text).not.toContain("next check-in");
  });

  it("says the overflow menu changes reports only", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount([periodic("t-every", {})], { boundHere: true });

    await openReportingMenu(user, "t-every");

    expect(
      screen.getByText(
        "These controls change reports only. The task and its agents can keep working.",
      ),
    ).toBeTruthy();
    expect(mocks.actions).toEqual([]);
  });

  it("checks in now and pauses through the original mutations, and a paused task offers Resume reports", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount([periodic("t-every", {})], { boundHere: true });

    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "Check in now" }));
    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "Pause reports" }));

    expect(mocks.actions).toEqual([
      {
        method: "bot.task.runNow",
        variables: { botId: BOT_ID, taskId: "t-every" },
      },
      {
        method: "bot.task.setPaused",
        variables: { botId: BOT_ID, taskId: "t-every", paused: true },
      },
    ]);
  });

  it("resumes a paused task's reports", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount(
      [periodic("t-paused", { pause: { byUserId: "user-ada", since: NOW } })],
      { boundHere: true },
    );

    await openReportingMenu(user, "t-paused");
    expect(
      screen.queryByRole("menuitem", { name: "Pause reports" }),
    ).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Resume reports" }));

    expect(mocks.actions).toEqual([
      {
        method: "bot.task.setPaused",
        variables: { botId: BOT_ID, taskId: "t-paused", paused: false },
      },
    ]);
  });

  it("asks before ending reporting: Cancel makes no call, End reporting stops the task once", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount([periodic("t-every", {})], { boundHere: true });

    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "End reporting…" }));
    expect(screen.getByText("End reporting?")).toBeTruthy();
    expect(
      screen.getByText(
        "You can’t resume reports for this task. The task and its agents can keep working.",
      ),
    ).toBeTruthy();
    expect(mocks.actions).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("End reporting?")).toBeNull();
    expect(mocks.actions).toEqual([]);

    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "End reporting…" }));
    await user.click(screen.getByRole("button", { name: "End reporting" }));

    expect(mocks.actions).toEqual([
      {
        method: "bot.task.stop",
        variables: { botId: BOT_ID, taskId: "t-every" },
      },
    ]);
  });

  it("keeps who paused a task and since when, and a queued check-in, in the menu rather than the row", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount(
      [
        periodic("t-paused", {
          pause: { byUserId: "user-ada", since: NOW },
          runRequest: {
            byUserId: "user-ada",
            requestedAt: NOW,
            state: "requested",
          },
        }),
      ],
      { boundHere: true },
    );

    expect(row("t-paused").textContent).not.toContain("Paused by");
    expect(row("t-paused").textContent).not.toContain("Requested;");
    await openReportingMenu(user, "t-paused");

    expect(screen.getByText(/Paused by .+ since/)).toBeTruthy();
    expect(
      screen.getByText(/Requested; runs when the task next reports/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("menuitem", { name: "Check in now" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("keeps the host and method gates: another host's tab, or a host without the method, offers no control", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount([periodic("t-every", {})], { boundHere: false });
    expect(
      screen.queryByRole("button", { name: "Reporting actions" }),
    ).toBeNull();
    cleanup();

    mocks.state.supported = new Set(["bot.task.stop"]);
    mount([periodic("t-every", {})], { boundHere: true });
    await openReportingMenu(user, "t-every");
    expect(screen.queryByRole("menuitem", { name: "Check in now" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /reports$/ })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "End reporting…" }),
    ).toBeTruthy();
  });

  it("does not open the task from the overflow, its menu items or the confirmation", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount([periodic("t-every", {})], { boundHere: true });

    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "End reporting…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await openReportingMenu(user, "t-every");
    await user.click(screen.getByRole("menuitem", { name: "Check in now" }));

    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("says reporting ended for a stopped task, and its menu only explains that work may continue", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(REPORT_METHODS);
    mount(
      [
        task("t-over", {
          cadence: { kind: "none" },
          state: "ended",
          endedReason: "by-bot",
          inputNeeded: [],
        }),
      ],
      { boundHere: true },
    );

    expect(endedRowFor("t-over").textContent).toContain("Reporting ended");
    await user.click(
      within(endedRowFor("t-over")).getByRole("button", {
        name: "Reporting actions",
      }),
    );
    expect(
      screen.getByText(
        "Reporting has ended. The task and its agents can keep working.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
