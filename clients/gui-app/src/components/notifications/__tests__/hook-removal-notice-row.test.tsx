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
import type {
  HostNotificationCloudEntryV26,
  HostNotificationsCloudFeedRowV16,
} from "@traycer/protocol/host/notifications/contracts";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { NotificationsSettingsPanelForClient } from "@/components/settings/panels/notifications-settings-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
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

const REMOTE_HOST = "host-work-laptop";

function removalEntry(
  id: string,
  hostName: string,
  count: number,
  hostId: string,
): HostNotificationCloudEntryV26 {
  return {
    id,
    // Distinct times pin the newest-first order the assertions read.
    updatedAt: 1_700_000_000_000 + count,
    readAt: null,
    kind: "notification.hooks.removed",
    sourceRef: `hook-removal:${id}`,
    severity: "info",
    outcome: "completed",
    epicId: null,
    chatId: null,
    payload: {
      kind: "notification_hooks_removed",
      hostId,
      hostName,
      count,
    },
  };
}

function cloudRow(
  entry: HostNotificationCloudEntryV26,
): HostNotificationsCloudFeedRowV16 {
  if (entry.sourceRef === null) {
    throw new Error("Removal fixture requires a stable source reference");
  }
  return {
    entryId: entry.id,
    originHostId: REMOTE_HOST,
    coalesceKey: entry.sourceRef,
    entry,
    presentation: { epicTitle: null, chatTitle: null },
  };
}

function Shell(props: {
  readonly onNavigate: () => void;
  readonly extra: ReactNode;
}): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <NotificationsPopover
        variant="center"
        onNavigate={props.onNavigate}
        headingRef={headingRef}
        shellRef={shellRef}
        shellStyle={{}}
        onFilterMenuOpenChange={() => undefined}
      />
      {props.extra}
    </>
  );
}

function renderCenter(
  onNavigate: () => void,
  queryClient: QueryClient,
  extra: ReactNode,
): void {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Shell onNavigate={onNavigate} extra={extra} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("a notification.hooks.removed row in the notification center", () => {
  const sandbox = createFakeSandboxBinding();

  beforeEach(() => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-hooks", userName: "U", email: "u@example.com" },
        { userId: "user-hooks", username: "U" },
        [],
      );
    hostRequestMock.mockReset();
    hostRequestMock.mockResolvedValue({});
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
    useSettingsHostScopeStore.setState({ scopedHostId: null });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    binding.current = null;
    notificationFeedMode.value = "local";
    useCloudNotificationsStore.getState().reset();
  });

  it("says the plural and singular sentences exactly and offers Review hooks on each", async () => {
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: {
        entries: [
          removalEntry("receipt-2", "Studio", 1, REMOTE_HOST),
          removalEntry("receipt-1", "Work laptop", 2, REMOTE_HOST),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 2, attentionCount: 0 },
    });
    renderCenter(() => undefined, freshQueryClient(), null);

    const entries = await screen.findAllByTestId("notification-entry");
    expect(
      entries
        .map((entry) => [
          within(entry).getByTestId("notification-title").textContent,
          within(entry).getByTestId("notification-body").textContent,
          within(entry).getAllByRole("button", { name: "Review hooks" }),
        ])
        .map(([title, body, buttons]) => [title, body, buttons.length]),
    ).toEqual([
      [
        "Notification hooks removed",
        "Removed 2 notification hooks from Work laptop because they could send its private data.",
        1,
      ],
      [
        "Notification hooks removed",
        "Removed 1 notification hook from Studio because it could send its private data.",
        1,
      ],
    ]);
  });

  it("opens the affected computer's Notifications settings, not the one this window views", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [
        cloudRow(removalEntry("receipt-1", "Work laptop", 2, REMOTE_HOST)),
      ],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 1,
    });
    const onNavigate = vi.fn();
    renderCenter(onNavigate, freshQueryClient(), null);

    fireEvent.click(
      await screen.findByRole("button", { name: "Review hooks" }),
    );

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(
        REMOTE_HOST,
      );
    });
    expect(useSettingsHostScopeStore.getState().scopedHostId).not.toBe(
      mockLocalHostEntry.hostId,
    );
  });
});

/**
 * The pending alert in Settings shares the Query cache with the notification
 * center. Its host keeps reporting the receipt (the retirement write has not
 * landed), so only the center's own successful read or clear can keep it gone.
 */
describe("the Settings alert after the notification center acknowledges a removal", () => {
  const sandbox = createFakeSandboxBinding();
  let statusCalls = 0;

  function settingsPanel(): ReactNode {
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-stale-receipt",
        handlers: {
          "host.notifications.getConfig": () => ({
            matrix: {
              info: { renderer: true, email: false },
              needs_action: { renderer: true, email: false },
              failure: { renderer: true, email: false },
              done: { renderer: true, email: false },
            },
            channels: {
              renderer: { lastError: null },
              email: {
                host: "",
                port: 587,
                user: "",
                from: "",
                credentialConfigured: false,
                lastError: null,
              },
            },
          }),
          "host.notificationHooks.status": () => {
            statusCalls += 1;
            return {
              configPath: "/home/me/.traycer/notification-hooks.json",
              configError: null,
              hooks: [],
              configurationRevision: "rev-1",
              pendingRemovalNotices: [
                {
                  id: "receipt-1",
                  hostId: mockLocalHostEntry.hostId,
                  hostName: "Work laptop",
                  count: 2,
                  occurredAt: 1_700_000_000_000,
                },
              ],
            };
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok" }),
    );
    return (
      <NotificationsSettingsPanelForClient
        client={spine.createRequester(mockLocalHostEntry)}
      />
    );
  }

  beforeEach(() => {
    statusCalls = 0;
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-hooks", userName: "U", email: "u@example.com" },
        { userId: "user-hooks", username: "U" },
        [],
      );
    hostRequestMock.mockReset();
    hostRequestMock.mockResolvedValue({});
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
      recent: {
        entries: [
          removalEntry(
            "receipt-1",
            "Work laptop",
            2,
            mockLocalHostEntry.hostId,
          ),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 1, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    binding.current = null;
  });

  async function expectAlertGoneAndStaysGone(): Promise<void> {
    const manager = screen.getByTestId("notification-hooks-manager");
    await waitFor(() => {
      expect(within(manager).queryByRole("alert")).toBeNull();
    });
    const callsBefore = statusCalls;
    fireEvent.click(within(manager).getByRole("button", { name: /Refresh/ }));
    await waitFor(() => {
      expect(statusCalls).toBeGreaterThan(callsBefore);
    });
    expect(within(manager).queryByRole("alert")).toBeNull();
  }

  it("stays absent after Mark as read on the row, though the host still reports the receipt", async () => {
    renderCenter(() => undefined, freshQueryClient(), settingsPanel());
    const manager = await screen.findByTestId("notification-hooks-manager");
    await within(manager).findByRole("alert");

    fireEvent.click(await screen.findByTestId("notification-mark-read"));

    await expectAlertGoneAndStaysGone();
  });

  it("stays absent after Clear notifications, though the host still reports the receipt", async () => {
    renderCenter(() => undefined, freshQueryClient(), settingsPanel());
    const manager = await screen.findByTestId("notification-hooks-manager");
    await within(manager).findByRole("alert");

    fireEvent.click(
      await screen.findByRole("button", { name: "Clear notifications" }),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));

    await expectAlertGoneAndStaysGone();
  });
});
