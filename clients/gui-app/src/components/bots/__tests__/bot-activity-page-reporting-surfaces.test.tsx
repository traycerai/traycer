/**
 * A bot's Activity page, the reporting controls of a watched task under an
 * open menu, when the task's controls go away under it, and when the negotiated
 * manifest stops offering them. Same real page, stores and boundaries as
 * `bot-activity-page.test.tsx`.
 */
import {
  act,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  REPORT_METHODS,
  installPageCaseLifecycle,
  reachReportingSurface,
  row,
} from "@/components/bots/__tests__/bot-activity-page-support";
import {
  describeEachSurface,
  expectSentStopHolds,
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

describe("<BotActivityPage /> reporting controls that go away under an open surface", () => {
  describeEachSurface(["menu"]);

  describe("when the negotiated manifest stops offering the methods and offers them again", () => {
    const lose = (view: RenderResult): void => {
      mocks.state.supported = new Set();
      view.rerender(page([tracking()], true));
    };
    const restore = (view: RenderResult): void => {
      mocks.state.supported = new Set(REPORT_METHODS);
      view.rerender(page([tracking()], true));
    };

    it("leaves a menu that was open closed", async () => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      const view = render(page([tracking()], true));
      await reachReportingSurface(user, "menu");

      lose(view);
      expect(screen.queryByRole("menu")).toBeNull();
      restore(view);

      expect(screen.queryByRole("menu")).toBeNull();
      expect(
        within(row("t-every")).getByRole("button", {
          name: "Reporting actions",
        }),
      ).toBeTruthy();
    });

    it("closes an unsent confirmation and does not bring it back", async () => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      const view = render(page([tracking()], true));
      await reachReportingSurface(user, "confirmation");

      lose(view);
      expect(screen.queryByText("End reporting?")).toBeNull();
      restore(view);

      expect(screen.queryByText("End reporting?")).toBeNull();
      expect(mocks.actions).toHaveLength(0);
    });

    it("keeps an already sent stop's modal open until it settles, then closes it for good", async () => {
      const user = userEvent.setup();
      mocks.state.supported = new Set(REPORT_METHODS);
      const view = render(page([tracking()], true));
      await reachReportingSurface(user, "stop in flight");
      expect(mocks.actions).toHaveLength(1);

      lose(view);
      restore(view);

      expect(screen.getByText("End reporting?")).toBeTruthy();
      await expectSentStopHolds(user, 1);
      act(() => mocks.stop.settle?.("success"));
      expect(screen.queryByText("End reporting?")).toBeNull();
      lose(view);
      restore(view);

      expect(screen.queryByText("End reporting?")).toBeNull();
      expect(mocks.actions).toHaveLength(1);
    });
  });
});
