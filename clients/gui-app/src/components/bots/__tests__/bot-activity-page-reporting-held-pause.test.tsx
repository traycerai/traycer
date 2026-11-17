/**
 * A bot's Activity page, the reporting controls of a watched task while a
 * pause is held: the person moves on, and a held check-in or pause survives the
 * bot ending reporting. Same real page, stores and boundaries as
 * `bot-activity-page.test.tsx`.
 */
import { act, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  REPORT_METHODS,
  endedRowFor,
  focusMenuItem,
  focusReturns,
  installPageCaseLifecycle,
  row,
  task,
} from "@/components/bots/__tests__/bot-activity-page-support";

import {
  describeEachHeldRequest,
  tracking,
  page,
} from "@/components/bots/__tests__/bot-activity-page-surfaces-support";

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

describe("<BotActivityPage /> reporting controls that go away under a held pause", () => {
  describeEachHeldRequest(["pause in flight"]);

  it.each([
    ["Check in now", "runNow"],
    ["Pause reports", "setPaused"],
  ] as const)(
    "a held %s survives the bot ending reporting: the same trigger stays busy and focused until the answer arrives, then goes quiet, with no further request",
    async (item, key) => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      mocks[key].hold = true;
      const view = render(page([tracking()], true));
      const trigger = within(row("t-every")).getByRole("button", {
        name: "Reporting actions",
      });
      await focusMenuItem(user, item);
      const returned = focusReturns(trigger);
      await user.keyboard("{Enter}");
      await returned;

      view.rerender(
        page(
          [
            task("t-every", {
              cadence: { kind: "none" },
              state: "ended",
              endedReason: "by-bot",
              inputNeeded: [],
            }),
          ],
          true,
        ),
      );

      expect(
        within(endedRowFor("t-every")).getByRole("button", {
          name: "Reporting actions",
        }),
      ).toBe(trigger);
      expect(trigger.getAttribute("aria-busy")).toBe("true");
      expect(document.activeElement).toBe(trigger);

      act(() => mocks[key].settle?.());

      expect(trigger.getAttribute("aria-busy")).not.toBe("true");
      expect(document.activeElement).toBe(trigger);
      expect(mocks.actions).toHaveLength(1);
    },
    5_000,
  );
});
