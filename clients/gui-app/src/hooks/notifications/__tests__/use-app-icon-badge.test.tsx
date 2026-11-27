import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppIconBadgeCountSource } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { TestRouterProvider } from "../../../__tests__/with-test-router";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppIconBadge } from "@/hooks/notifications/use-app-icon-badge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useNeedsYouTaskCountStore } from "@/stores/notifications/needs-you-task-count-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

// The notifications row is not exported. The drawer's task list asks a host
// runtime this file does not mount, so those reads are stubbed. The row's mark
// still comes from the notification stores the publisher reads.
vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: {
      items: [],
      totalCount: 0,
      hostRequiresCloudToList: false,
    },
    sort: "recent",
    createdSortAvailable: true,
    isPending: false,
    cloudPagePending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    refetchTasks: () => Promise.resolve(),
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    currentUserId: null,
    hostId: null,
    activityRefreshScope: "",
  }),
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(),
    localHomedTaskIds: new Set<string>(),
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    refetchBatches: [],
  }),
}));

vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));

const SIGNED_IN_PROFILE = {
  userId: "badge-user",
  userName: "Badge User",
  email: "badge@example.com",
} as const;

const NEEDS_YOU = 4;
const ATTENTION = 7;
const QUIET_UNREAD = 3;
const ATTENTION_OVER_CAP = 120;

function signIn(): void {
  useAuthStore.getState().setSignedIn(
    SIGNED_IN_PROFILE,
    { userId: SIGNED_IN_PROFILE.userId, username: SIGNED_IN_PROFILE.userName },
    [],
  );
}

function resetPlanes(): void {
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  useCloudNotificationsStore.getState().reset();
  useNeedsYouTaskCountStore.setState({ count: 0 });
  useNotificationsPopoverStore.getState().setOpen(false);
  useMobileNavStore.setState({ open: false });
  window.localStorage.clear();
}

function applyHostSummary(unreadCount: number, attentionCount: number): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: { entries: [], nextCursor: null },
    recent: { entries: [], nextCursor: null },
    summary: { unreadCount, attentionCount },
  });
}

function Publisher(): null {
  useAppIconBadge();
  return null;
}

async function renderPublisher(input: {
  readonly countSource: AppIconBadgeCountSource;
  readonly drawer: boolean;
  readonly setCount: (count: number) => Promise<void>;
}): Promise<RenderResult> {
  const runnerHost = createFakeRunnerHost({
    appIconBadge: {
      countSource: input.countSource,
      setCount: input.setCount,
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <TestRouterProvider>
            <Publisher />
            <NotificationsBell />
            {input.drawer ? <MobileNavDrawer /> : null}
          </TestRouterProvider>
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  // The in-memory router paints its root on a later turn.
  await screen.findByTestId("notifications-bell");
  return view;
}

async function expectPublished(
  counts: readonly number[],
  count: number,
): Promise<void> {
  await waitFor(() => {
    expect(counts.at(-1)).toBe(count);
  });
}

function renderedInteger(testId: string): number {
  const text = screen.getByTestId(testId).textContent.trim();
  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw new Error(`${testId} rendered ${JSON.stringify(text)}`);
  }
  return value;
}

function expectNoBellNumber(): void {
  expect(screen.queryByTestId("notifications-needs-you-count")).toBeNull();
  expect(screen.queryByTestId("notifications-attention-count")).toBeNull();
}

function expectNoRowNumber(): void {
  expect(
    screen.queryByTestId("mobile-nav-notifications-attention-count"),
  ).toBeNull();
}

describe("useAppIconBadge", () => {
  beforeEach(() => {
    resetPlanes();
    signIn();
  });

  afterEach(() => {
    cleanup();
    resetPlanes();
    useAuthStore.getState().setSignedOut();
  });

  it("publishes the number the bell renders for each mark", async () => {
    const counts: number[] = [];
    await renderPublisher({
      countSource: "bell",
      drawer: false,
      setCount: (count) => {
        counts.push(count);
        return Promise.resolve();
      },
    });

    expect(
      screen.getByTestId("notifications-unknown-indicator"),
    ).toBeTruthy();
    expectNoBellNumber();
    await expectPublished(counts, 0);

    act(() => {
      useNeedsYouTaskCountStore.setState({ count: NEEDS_YOU });
    });
    expect(renderedInteger("notifications-needs-you-count")).toBe(NEEDS_YOU);
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    await expectPublished(counts, NEEDS_YOU);

    act(() => {
      useNeedsYouTaskCountStore.setState({ count: 0 });
    });
    expect(
      screen.getByTestId("notifications-unknown-indicator"),
    ).toBeTruthy();
    expectNoBellNumber();
    await expectPublished(counts, 0);

    act(() => {
      applyHostSummary(0, 0);
      useNeedsYouTaskCountStore.setState({ count: NEEDS_YOU });
    });
    expect(renderedInteger("notifications-needs-you-count")).toBe(NEEDS_YOU);
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    await expectPublished(counts, NEEDS_YOU);

    act(() => {
      useNeedsYouTaskCountStore.setState({ count: 0 });
      applyHostSummary(0, ATTENTION);
    });
    expect(renderedInteger("notifications-attention-count")).toBe(ATTENTION);
    expect(screen.queryByTestId("notifications-needs-you-count")).toBeNull();
    await expectPublished(counts, ATTENTION);

    act(() => {
      applyHostSummary(QUIET_UNREAD, 0);
    });
    expect(screen.getByTestId("notifications-quiet-dot")).toBeTruthy();
    expectNoBellNumber();
    await expectPublished(counts, 0);

    act(() => {
      applyHostSummary(0, 0);
    });
    expectNoBellNumber();
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    await expectPublished(counts, 0);
  });

  it("publishes the phone row's attention count and ignores needs-you", async () => {
    const counts: number[] = [];
    useMobileNavStore.setState({ open: true });
    await renderPublisher({
      countSource: "attention",
      drawer: true,
      setCount: (count) => {
        counts.push(count);
        return Promise.resolve();
      },
    });

    const row = await screen.findByTestId("mobile-nav-notifications");
    expect(row.getAttribute("aria-label")).toBe(
      "Notifications, status unavailable",
    );
    expect(
      screen.getByTestId("notifications-unknown-indicator"),
    ).toBeTruthy();
    expectNoRowNumber();
    await expectPublished(counts, 0);

    act(() => {
      useNeedsYouTaskCountStore.setState({ count: NEEDS_YOU });
    });
    expect(renderedInteger("notifications-needs-you-count")).toBe(NEEDS_YOU);
    expect(row.getAttribute("aria-label")).toBe(
      "Notifications, status unavailable",
    );
    expectNoRowNumber();
    await expectPublished(counts, 0);
    expect(counts.includes(NEEDS_YOU)).toBe(false);

    act(() => {
      applyHostSummary(0, 0);
    });
    expect(renderedInteger("notifications-needs-you-count")).toBe(NEEDS_YOU);
    expect(row.getAttribute("aria-label")).toBe("Notifications");
    expectNoRowNumber();
    expect(
      screen.queryByTestId("mobile-nav-notifications-quiet-dot"),
    ).toBeNull();
    await expectPublished(counts, 0);
    expect(counts.includes(NEEDS_YOU)).toBe(false);

    act(() => {
      useNeedsYouTaskCountStore.setState({ count: 0 });
      applyHostSummary(0, ATTENTION);
    });
    expect(renderedInteger("notifications-attention-count")).toBe(ATTENTION);
    expect(renderedInteger("mobile-nav-notifications-attention-count")).toBe(
      ATTENTION,
    );
    await expectPublished(counts, ATTENTION);

    act(() => {
      useNeedsYouTaskCountStore.setState({ count: NEEDS_YOU });
    });
    expect(renderedInteger("notifications-needs-you-count")).toBe(NEEDS_YOU);
    expect(screen.queryByTestId("notifications-attention-count")).toBeNull();
    expect(renderedInteger("mobile-nav-notifications-attention-count")).toBe(
      ATTENTION,
    );
    await expectPublished(counts, ATTENTION);
    expect(counts.includes(NEEDS_YOU)).toBe(false);

    act(() => {
      useNeedsYouTaskCountStore.setState({ count: 0 });
      applyHostSummary(QUIET_UNREAD, 0);
    });
    expect(screen.getByTestId("notifications-quiet-dot")).toBeTruthy();
    expect(
      screen.getByTestId("mobile-nav-notifications-quiet-dot"),
    ).toBeTruthy();
    expectNoBellNumber();
    expectNoRowNumber();
    await expectPublished(counts, 0);

    act(() => {
      applyHostSummary(0, 0);
    });
    expect(row.getAttribute("aria-label")).toBe("Notifications");
    expectNoBellNumber();
    expectNoRowNumber();
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(
      screen.queryByTestId("mobile-nav-notifications-quiet-dot"),
    ).toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    await expectPublished(counts, 0);

    act(() => {
      applyHostSummary(0, ATTENTION_OVER_CAP);
    });
    expect(renderedInteger("notifications-attention-count")).toBe(
      ATTENTION_OVER_CAP,
    );
    expect(
      screen
        .getByTestId("mobile-nav-notifications-attention-count")
        .textContent.trim(),
    ).toBe("99+");
    await expectPublished(counts, ATTENTION_OVER_CAP);
  });

  it("publishes 0 when the session signs out", async () => {
    const counts: number[] = [];
    act(() => {
      useNeedsYouTaskCountStore.setState({ count: NEEDS_YOU });
    });
    await renderPublisher({
      countSource: "bell",
      drawer: false,
      setCount: (count) => {
        counts.push(count);
        return Promise.resolve();
      },
    });

    expect(renderedInteger("notifications-needs-you-count")).toBe(NEEDS_YOU);
    await expectPublished(counts, NEEDS_YOU);

    act(() => {
      useAuthStore.getState().setSignedOut();
    });

    await expectPublished(counts, 0);
  });

  it("publishes 0 when the publisher unmounts", async () => {
    const counts: number[] = [];
    act(() => {
      applyHostSummary(0, ATTENTION);
    });
    const view = await renderPublisher({
      countSource: "bell",
      drawer: false,
      setCount: (count) => {
        counts.push(count);
        return Promise.resolve();
      },
    });

    expect(renderedInteger("notifications-attention-count")).toBe(ATTENTION);
    await expectPublished(counts, ATTENTION);

    view.unmount();

    await expectPublished(counts, 0);
  });
});
