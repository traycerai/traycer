/**
 * A bot's Activity page, the reporting controls of a watched task while their
 * End reporting confirmation is open and while a stop they sent is in flight,
 * when the task's controls go away under it. Same real page, stores and
 * boundaries as `bot-activity-page.test.tsx`.
 */
import { describe, vi } from "vitest";
import { installPageCaseLifecycle } from "@/components/bots/__tests__/bot-activity-page-support";
import { describeEachSurface } from "@/components/bots/__tests__/bot-activity-page-surfaces-support";

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

describe("<BotActivityPage /> reporting controls that go away under a confirmation and a stop in flight", () => {
  describeEachSurface(["confirmation", "stop in flight"]);
});
