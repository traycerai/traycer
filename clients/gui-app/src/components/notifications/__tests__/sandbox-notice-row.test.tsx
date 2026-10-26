import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
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
import type { HostNotificationsCloudFeedRowV15 } from "@traycer/protocol/host/notifications/contracts";
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
  notice: Record<string, unknown>,
): HostNotificationsCloudFeedRowV15 {
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
      severity: "info",
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

function seedCloud(row: HostNotificationsCloudFeedRowV15): void {
  notificationFeedMode.value = "cloud";
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [row],
    summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
    version: 1,
  });
}

function Shell(): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <NotificationsPopover
      variant="center"
      onNavigate={() => undefined}
      headingRef={headingRef}
      shellRef={shellRef}
      shellStyle={{}}
      onFilterMenuOpenChange={() => undefined}
    />
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
      <RouterProvider router={router} />
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
    hostRequestMock.mockResolvedValue({});
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
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    resetSandboxesPage();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    binding.current = null;
    notificationFeedMode.value = "local";
    useCloudNotificationsStore.getState().reset();
  });

  const WARNING = {
    kind: "resting_warning",
    destroyAt: Date.now() + 10 * 60_000,
    periodMinutes: 5,
  };

  it("shows a resting warning's copy with Give it another 5 minutes, Details and Dismiss", async () => {
    seedCloud(noticeRow("entry-warning", WARNING));
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

  it("extends with the row's own period, then marks the row read", async () => {
    seedCloud(noticeRow("entry-warning", WARNING));
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
      expect(hostCalls("host.notifications.cloudFeed.markRead")).toEqual([
        { entryId: "entry-warning" },
      ]);
    });
  });

  it("opens Settings › Sandboxes on that sandbox from Details", async () => {
    seedCloud(noticeRow("entry-warning", WARNING));
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
    seedCloud(noticeRow("entry-warning", WARNING));
    renderCenter();

    fireEvent.click(await screen.findByTestId("sandbox-notice-dismiss"));

    await waitFor(() => {
      expect(hostCalls("host.notifications.cloudFeed.clear")).toEqual([
        { entryId: "entry-warning" },
      ]);
    });
    expect(sandbox.auth.patchSandbox).not.toHaveBeenCalled();
  });

  it("offers a notice that is not a warning only Details and Dismiss", async () => {
    seedCloud(noticeRow("entry-destroyed", { kind: "resting_destroyed" }));
    renderCenter();

    const actions = await screen.findByTestId("sandbox-notice-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Details", "Dismiss"]);
  });
});
