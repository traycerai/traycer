import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type {
  HostNotificationSandboxNotice,
  HostNotificationSeverity,
  HostNotificationsCloudFeedRowV16,
} from "@traycer/protocol/host/notifications/contracts";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import {
  resetSandboxesPage,
  useSandboxesPageStore,
} from "@/stores/sandboxes/sandboxes-page-store";
import { createFakeSandboxBinding } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { useNeedsYouTaskCountStore } from "@/stores/notifications/needs-you-task-count-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

const hostRequestMock = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
);

interface StubHostClient {
  readonly request: typeof hostRequestMock;
  readonly getActiveHostId: () => string | null;
  readonly createRequesterForHostId: (hostId: string | null) => StubHostClient;
  readonly requestWithSignalRequiringHostMethodVersion: (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
}

const binding = vi.hoisted(() => ({
  current: null as {
    readonly hostClient: unknown;
    readonly directory: unknown;
  } | null,
}));
const notificationFeedMode = vi.hoisted<{ value: "local" | "cloud" }>(() => ({
  value: "local",
}));

vi.mock("@/lib/host", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/host")>()),
  useHostBinding: () => binding.current,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-local",
}));
// A sandbox notice exists only with sandboxes on, which every case is about.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on",
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => "host-local",
  useNotificationResolveHost: () => ({
    hostId: "host-local",
    client: binding.current?.hostClient,
  }),
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/notifications/notification-feed-mode", async (importActual) => ({
  ...(await importActual<
    typeof import("@/lib/notifications/notification-feed-mode")
  >()),
  useNotificationFeedMode: () => notificationFeedMode.value,
  useNotificationFeedModeSettling: () => false,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const SANDBOX_ID = "sbx_notice_1";

function noticeRow(
  entryId: string,
  notice: HostNotificationSandboxNotice,
  severity: HostNotificationSeverity,
): HostNotificationsCloudFeedRowV16 & {
  readonly entry: Extract<
    HostNotificationsCloudFeedRowV16["entry"],
    { kind: "sandbox.notice" }
  >;
} {
  return {
    entryId,
    originHostId: "host-cloud",
    coalesceKey: `sandbox-notice:${entryId}`,
    entry: {
      id: entryId,
      updatedAt: Date.now(),
      readAt: null,
      kind: "sandbox.notice",
      sourceRef: entryId,
      severity,
      outcome: "completed",
      epicId: null,
      chatId: null,
      payload: {
        kind: "sandbox_notice",
        sandboxId: SANDBOX_ID,
        sandboxName: "e2e-sbx-p2-renamed",
        notice,
      },
    },
    presentation: { epicTitle: null, chatTitle: null },
  };
}

function seedCloud(
  rows: ReadonlyArray<HostNotificationsCloudFeedRowV16>,
): void {
  notificationFeedMode.value = "cloud";
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    summary: {
      totalCount: rows.length,
      unreadCount: rows.filter((row) => row.entry.readAt === null).length,
      attentionCount: rows.filter(
        (row) =>
          row.entry.readAt === null &&
          (row.entry.severity === "needs_action" ||
            row.entry.severity === "failure"),
      ).length,
    },
    version: (useCloudNotificationsStore.getState().version ?? 0) + 1,
  });
}

function Shell(): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <NotificationsBell />
      <NotificationsPopover
        variant="center"
        onNavigate={() => undefined}
        headingRef={headingRef}
        shellRef={shellRef}
        shellStyle={{}}
        onFilterMenuOpenChange={() => undefined}
      />
    </>
  );
}

function renderCenter(): void {
  const router = createRouter({
    routeTree: createRootRoute({ component: Shell }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function hostCalls(method: string): ReadonlyArray<unknown> {
  return hostRequestMock.mock.calls
    .filter(([called]) => called === method)
    .map(([, params]) => params);
}

describe("a sandbox.notice row in the notification center", () => {
  const sandbox = createFakeSandboxBinding();

  beforeEach(() => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-notice", userName: "U", email: "u@example.com" },
        { userId: "user-notice", username: "U" },
        [],
      );
    hostRequestMock.mockReset();
    hostRequestMock.mockResolvedValue({ status: "applied", version: 2 });
    sandbox.auth.patchSandbox.mockReset();
    sandbox.auth.patchSandbox.mockResolvedValue({
      kind: "ok",
      settled: true,
    });
    const hostClient: StubHostClient = {
      request: hostRequestMock,
      getActiveHostId: () => mockLocalHostEntry.hostId,
      createRequesterForHostId: () => hostClient,
      requestWithSignalRequiringHostMethodVersion: (method, params) =>
        hostRequestMock(method, params),
    };
    binding.current = {
      ...sandbox,
      hostClient,
      directory: {
        ...sandbox.directory,
        getLocalEntry: () => mockLocalHostEntry,
        onChange: () => ({ dispose: () => undefined }),
      },
    };
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    useCloudNotificationsStore.setState({ accountId: "user-notice" });
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    resetSandboxesPage();
    useNotificationsPopoverStore.getState().setOpen(false);
    useNeedsYouTaskCountStore.setState({ count: 0 });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    binding.current = null;
    notificationFeedMode.value = "local";
    useCloudNotificationsStore.getState().reset();
    vi.useRealTimers();
  });

  const WARNING: HostNotificationSandboxNotice = {
    kind: "resting_warning",
    destroyAt: Date.now() + 10 * 60_000,
    periodMinutes: 5,
  };

  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly notice: HostNotificationSandboxNotice;
    readonly severity: HostNotificationSeverity;
    readonly actionable: boolean;
  }> = [
    {
      name: "resting warning",
      notice: WARNING,
      severity: "needs_action",
      actionable: true,
    },
    {
      name: "credits frozen",
      notice: { kind: "frozen", cause: "credits" },
      severity: "needs_action",
      actionable: true,
    },
    {
      name: "payer removed",
      notice: { kind: "frozen", cause: "payer_removed" },
      severity: "needs_action",
      actionable: true,
    },
    {
      name: "day-30 warning",
      notice: { kind: "frozen_warning", daysLeft: 1 },
      severity: "needs_action",
      actionable: true,
    },
    ...(
      [
        "resting_destroyed",
        "frozen_deleting",
        "frozen_destroyed",
        "lost",
        "create_failed",
      ] as const
    ).map((kind) => ({
      name: kind,
      notice: { kind },
      severity: "info" as const,
      actionable: false,
    })),
    {
      name: "destroyed by member",
      notice: { kind: "destroyed_by_member", actorName: "Alex" },
      severity: "info",
      actionable: false,
    },
    ...(["suspend", "stop"] as const).flatMap((verb) =>
      (["confirmed", "failed"] as const).map((outcome) => ({
        name: `${verb} ${outcome}`,
        notice: {
          kind: "manual_rest" as const,
          verb,
          outcome,
          byYou: false,
          actorName: "Alex",
        },
        severity: "info" as const,
        actionable: false,
      })),
    ),
  ];

  it.each(CASES)(
    "groups and counts $name through the center and bell",
    async ({ notice, severity, actionable }) => {
      seedCloud([noticeRow("entry-kind", notice, severity)]);
      renderCenter();

      const entry = await screen.findByTestId("notification-entry");
      const section = entry.closest("section");
      if (section === null) throw new Error("notification has no section");
      expect(
        within(section).getByText(
          actionable ? "Needs attention" : "Recent activity",
        ),
      ).not.toBeNull();
      expect(
        screen.queryByTestId("notifications-needs-you-count")?.textContent ??
          null,
      ).toBe(actionable ? "1" : null);
    },
  );

  it("keeps a read warning with no resolvedAt actionable and adds it to the task count", async () => {
    const warning = noticeRow("entry-read", WARNING, "needs_action");
    seedCloud([
      { ...warning, entry: { ...warning.entry, readAt: Date.now() } },
    ]);
    useNeedsYouTaskCountStore.setState({ count: 2 });
    renderCenter();

    await screen.findByText("Needs attention");
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, 3 need you");
    expect(
      screen.getByTestId("notifications-needs-you-count").textContent,
    ).toBe("3");
  });

  it("mark all read acknowledges warnings without retiring them", async () => {
    seedCloud([noticeRow("entry-bulk-read", WARNING, "needs_action")]);
    renderCenter();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Mark all notifications as read",
      }),
    );
    await waitFor(() =>
      expect(
        hostCalls("host.notifications.cloudFeed.markAllRead"),
      ).toHaveLength(1),
    );
    expect(screen.getByText("Needs attention")).not.toBeNull();
    expect(
      screen.getByTestId("notifications-needs-you-count").textContent,
    ).toBe("1");
  });

  it("a resolved warning relayed by the server is recent even if unread", async () => {
    const row = noticeRow("entry-resolved", WARNING, "needs_action");
    seedCloud([{ ...row, entry: { ...row.entry, resolvedAt: Date.now() } }]);
    renderCenter();
    await screen.findByText("Recent activity");
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
    expect(screen.queryByTestId("notifications-needs-you-badge")).toBeNull();
  });

  it("excludes Details-only settings failures from the task and actionable notice count", async () => {
    const row: HostNotificationsCloudFeedRowV16 = {
      ...noticeRow("entry-settings", WARNING, "needs_action"),
      entry: {
        id: "entry-settings",
        kind: "environment.apply.failed",
        severity: "needs_action",
        updatedAt: Date.now(),
        readAt: Date.now(),
        sourceRef: null,
        outcome: "errored",
        epicId: null,
        chatId: null,
        payload: {
          kind: "environment_apply_failed",
          environmentId: "env-settings",
          hostId: "host-cloud",
          hostName: "Sandbox",
          itemKey: "settings",
          reason: "unavailable",
        },
      },
    };
    seedCloud([row, noticeRow("entry-warning", WARNING, "needs_action")]);
    useNeedsYouTaskCountStore.setState({ count: 2 });
    renderCenter();
    await screen.findByText("Needs attention");
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, 3 need you");
    expect(
      screen.getByTestId("notifications-needs-you-count").textContent,
    ).toBe("3");
  });

  it("reading Details acknowledges a warning without retiring it", async () => {
    seedCloud([noticeRow("entry-read-details", WARNING, "needs_action")]);
    renderCenter();
    fireEvent.click(await screen.findByTestId("sandbox-notice-details"));
    await waitFor(() =>
      expect(hostCalls("host.notifications.cloudFeed.markRead")).toEqual([
        { entryId: "entry-read-details" },
      ]),
    );
    expect(screen.getByText("Needs attention")).not.toBeNull();
    expect(
      screen.getByTestId("notifications-needs-you-count").textContent,
    ).toBe("1");
  });

  it("retires an older warning when a later notice arrives for its sandbox, including after the outcome is dismissed", async () => {
    const warning = noticeRow("entry-old", WARNING, "needs_action");
    seedCloud([warning]);
    renderCenter();
    await screen.findByText("Needs attention");

    const outcome = noticeRow(
      "entry-new",
      { kind: "resting_destroyed" },
      "info",
    );
    act(() =>
      seedCloud([
        warning,
        {
          ...outcome,
          entry: { ...outcome.entry, updatedAt: warning.entry.updatedAt + 1 },
        },
      ]),
    );
    await waitFor(() => {
      expect(screen.queryByText("Needs attention")).toBeNull();
      expect(screen.queryByTestId("notifications-needs-you-badge")).toBeNull();
    });
    act(() => seedCloud([warning]));
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("does not retire a warning for a different sandbox or an older notice", async () => {
    const warning = noticeRow("entry-current", WARNING, "needs_action");
    const older = noticeRow(
      "entry-old-outcome",
      { kind: "resting_destroyed" },
      "info",
    );
    const other = noticeRow(
      "entry-other",
      { kind: "destroyed_by_member", actorName: null },
      "info",
    );
    seedCloud([
      warning,
      {
        ...older,
        entry: { ...older.entry, updatedAt: warning.entry.updatedAt - 1 },
      },
      {
        ...other,
        entry: {
          ...other.entry,
          updatedAt: warning.entry.updatedAt + 1,
          payload: { ...other.entry.payload, sandboxId: "another-sandbox" },
        },
      },
    ]);
    renderCenter();
    await screen.findByText("Needs attention");
    expect(
      screen.getByTestId("notifications-needs-you-count").textContent,
    ).toBe("1");
  });

  it("retires at destroyAt without requiring another feed snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const now = Date.now();
    seedCloud([
      noticeRow(
        "entry-expiring",
        { kind: "resting_warning", destroyAt: now + 1_000, periodMinutes: 5 },
        "needs_action",
      ),
    ]);
    renderCenter();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Needs attention")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.getByText("Recent activity")).not.toBeNull();
    expect(screen.queryByTestId("notifications-needs-you-badge")).toBeNull();
  });

  it("shows a resting warning's copy with Give it another 5 minutes, Details and Dismiss", async () => {
    seedCloud([noticeRow("entry-warning", WARNING, "needs_action")]);
    renderCenter();

    const entry = await screen.findByTestId("notification-entry");
    expect(within(entry).getByTestId("notification-title").textContent).toMatch(
      /^e2e-sbx-p2-renamed is destroyed .* unless you use it$/,
    );
    expect(within(entry).getByTestId("notification-body").textContent).toBe(
      "Files on this sandbox cannot be recovered; published chats stay readable.",
    );
    expect(
      within(screen.getByTestId("sandbox-notice-actions"))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Give it another 5 minutes", "Details", "Dismiss"]);
  });

  it("extends with the row's own period, then retires the warning to Recent activity", async () => {
    const warning = noticeRow("entry-warning", WARNING, "needs_action");
    seedCloud([warning]);
    renderCenter();

    fireEvent.click(await screen.findByText("Give it another 5 minutes"));

    await waitFor(() => {
      expect(sandbox.auth.patchSandbox).toHaveBeenCalledWith(SANDBOX_ID, {
        displayName: null,
        idleMinutes: null,
        destroyAfterRestingMinutes: 5,
      });
    });
    await waitFor(() => {
      expect(hostCalls("host.notifications.cloudFeed.resolve")).toEqual([
        { entryId: "entry-warning" },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText("Needs attention")).toBeNull();
      expect(screen.getByText("Recent activity")).not.toBeNull();
      expect(screen.queryByTestId("notifications-needs-you-badge")).toBeNull();
    });
    // The deployed pool strips resolvedAt until its protocol pin is rebuilt.
    act(() => seedCloud([warning]));
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("opens Settings › Sandboxes on that sandbox from Details", async () => {
    seedCloud([noticeRow("entry-warning", WARNING, "needs_action")]);
    renderCenter();

    fireEvent.click(await screen.findByTestId("sandbox-notice-details"));

    await waitFor(() => {
      expect(useSandboxesPageStore.getState()).toMatchObject({
        revealSandboxId: SANDBOX_ID,
        revealConfigurationPending: true,
      });
    });
  });

  it("clears the row from Dismiss", async () => {
    seedCloud([noticeRow("entry-warning", WARNING, "needs_action")]);
    renderCenter();

    fireEvent.click(await screen.findByTestId("sandbox-notice-dismiss"));

    await waitFor(() => {
      expect(hostCalls("host.notifications.cloudFeed.clear")).toEqual([
        { entryId: "entry-warning" },
      ]);
    });
    expect(sandbox.auth.patchSandbox).not.toHaveBeenCalled();
    act(() => seedCloud([]));
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-needs-you-badge")).toBeNull();
      expect(screen.queryByTestId("notification-entry")).toBeNull();
    });
  });

  it("offers a notice that is not a warning only Details and Dismiss", async () => {
    seedCloud([
      noticeRow("entry-destroyed", { kind: "resting_destroyed" }, "info"),
    ]);
    renderCenter();

    const actions = await screen.findByTestId("sandbox-notice-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Details", "Dismiss"]);
  });

  it("retires a used action even while the relay cannot confirm its resolve marker", async () => {
    hostRequestMock.mockResolvedValue({ status: "unavailable", version: null });
    seedCloud([noticeRow("entry-relay-unavailable", WARNING, "needs_action")]);
    renderCenter();
    fireEvent.click(await screen.findByText("Give it another 5 minutes"));
    await waitFor(() =>
      expect(hostCalls("host.notifications.cloudFeed.resolve")).toHaveLength(1),
    );
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByTestId("notifications-needs-you-badge")).toBeNull();
  });
});
