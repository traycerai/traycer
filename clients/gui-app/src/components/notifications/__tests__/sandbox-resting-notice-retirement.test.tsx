import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useRef } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostNotificationsCloudFeedRowV15 } from "@traycer/protocol/host/notifications/contracts";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { SandboxRestingNoticeObservers } from "../sandbox-resting-notice-observers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  sandboxListReadSentAt,
  useSandboxList,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { useNeedsYouTaskCountStore } from "@/stores/notifications/needs-you-task-count-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

interface NotificationBinding extends FakeSandboxBinding {
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly directory: FakeSandboxBinding["directory"] & {
    readonly getLocalEntry: () => HostDirectoryEntry;
    readonly onChange: () => { readonly dispose: () => void };
  };
}

const state = vi.hoisted(() => ({
  binding: null as NotificationBinding | null,
  client: null as HostRequester<HostRpcRegistry> | null,
  controlUnavailable: null as string | null,
}));
vi.mock("@/lib/host", async (original) => ({
  ...(await original<typeof import("@/lib/host")>()),
  useHostBinding: () => state.binding,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => state.client,
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (original) => ({
  ...(await original<typeof import("@/hooks/host/use-host-directory-entry")>()),
  useHostDirectoryEntry: () => mockLocalHostEntry,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (original) => ({
  ...(await original<typeof import("@/hooks/host/use-host-supports-method")>()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => mockLocalHostEntry.hostId,
  useNotificationResolveHost: () => ({
    hostId: mockLocalHostEntry.hostId,
    client: state.client,
  }),
}));
vi.mock("@/lib/notifications/notification-feed-mode", async (original) => ({
  ...(await original<
    typeof import("@/lib/notifications/notification-feed-mode")
  >()),
  useNotificationFeedMode: () => "cloud",
  useNotificationFeedModeSettling: () => false,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () =>
    state.controlUnavailable === null
      ? null
      : { sandboxControlUnavailableReason: state.controlUnavailable },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", () => ({
  useSandboxConfigurations: () => ({ configurations: [] }),
  sandboxConfigurationOf: () => null,
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const HOST_ID = mockLocalHostEntry.hostId;
const SANDBOX_ID = "sbx-resting";
const PERIOD_MINUTES = 5;
// One fixed clock for every case: the warning's own episode.
const DESTROY_AT = Date.now() + 60 * 60_000;
const RESTING_SINCE = DESTROY_AT - PERIOD_MINUTES * 60_000;
const auth = createFakeSandboxBinding();
let queryClient: QueryClient;
let resolvedIds: string[];

function warning(
  entryId: string,
  updatedAt: number,
  resolvedAt: null | undefined,
): HostNotificationsCloudFeedRowV15 {
  return {
    entryId,
    originHostId: "cloud-resting",
    coalesceKey: `sandbox-notice:${entryId}`,
    presentation: { epicTitle: null, chatTitle: null },
    entry: {
      id: entryId,
      updatedAt,
      // The older relay stamps the row read yet leaves it unresolved.
      readAt: updatedAt,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      kind: "sandbox.notice",
      sourceRef: entryId,
      severity: "needs_action",
      outcome: "completed",
      epicId: null,
      chatId: null,
      payload: {
        kind: "sandbox_notice",
        sandboxId: SANDBOX_ID,
        sandboxName: "build-box",
        notice: {
          kind: "resting_warning",
          destroyAt: DESTROY_AT,
          periodMinutes: PERIOD_MINUTES,
        },
      },
    },
  };
}
function seed(rows: HostNotificationsCloudFeedRowV15[]): void {
  useCloudNotificationsStore.setState({ accountId: "resting-user" });
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    summary: { totalCount: rows.length, unreadCount: 0, attentionCount: 0 },
    version: (useCloudNotificationsStore.getState().version ?? 0) + 1,
  });
}
function listing(overrides: Partial<SandboxSummary>) {
  return {
    kind: "ok" as const,
    response: {
      sandboxes: [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: HOST_ID,
          ...overrides,
        }),
      ],
    },
  };
}
const AWAKE = listing({ state: "awake" });
const RESTING = listing({
  state: "suspended",
  restingSince: RESTING_SINCE,
  destroyAfterRestingMinutes: PERIOD_MINUTES,
  destroyAt: DESTROY_AT,
});
function resolvedAtOf(entryId: string): number | null {
  const row = Object.values(useCloudNotificationsStore.getState().rows).find(
    (candidate) => candidate?.entryId === entryId,
  );
  return row?.entry.kind === "sandbox.notice"
    ? (row.entry.resolvedAt ?? null)
    : null;
}
function bellLabel(): string | null {
  return screen.getByTestId("notifications-bell").getAttribute("aria-label");
}

function Probe() {
  useSandboxList();
  return null;
}
function Shell(props: {
  readonly showCenter: boolean;
  readonly withConsumer: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <SandboxRestingNoticeObservers />
      {props.withConsumer ? <Probe /> : null}
      <NotificationsBell />
      {props.showCenter ? (
        <NotificationsPopover
          variant="center"
          onNavigate={() => undefined}
          headingRef={headingRef}
          shellRef={shellRef}
          shellStyle={{}}
          onFilterMenuOpenChange={() => undefined}
        />
      ) : null}
    </>
  );
}
function mount(showCenter: boolean, withConsumer: boolean): void {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <Shell showCenter={showCenter} withConsumer={withConsumer} />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
/** Wait until the one list read this case expects has landed and nothing is in flight. */
async function listSettled(reads: number): Promise<void> {
  await waitFor(() =>
    expect(auth.auth.listSandboxes).toHaveBeenCalledTimes(reads),
  );
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
}

async function preloadList(): Promise<number> {
  const consumer = renderHook(() => useSandboxList(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(consumer.result.current.isSuccess).toBe(true));
  const sentAt = sandboxListReadSentAt(consumer.result.current.data);
  consumer.unmount();
  if (sentAt === null) throw new Error("the preloaded list has no send time");
  return sentAt;
}

beforeEach(() => {
  auth.auth.listSandboxes.mockReset();
  auth.auth.listSandboxes.mockResolvedValue(AWAKE);
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "resting-user", userName: "U", email: "u@example.com" },
      { userId: "resting-user", username: "U" },
      [],
    );
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  useCloudNotificationsStore.getState().reset();
  useHostNotificationsStore.getState().applySnapshot({
    attention: { entries: [], nextCursor: null },
    recent: { entries: [], nextCursor: null },
    summary: { unreadCount: 0, attentionCount: 0 },
  });
  useNeedsYouTaskCountStore.setState({ count: 0 });
  useNotificationsPopoverStore.getState().setOpen(false);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  resolvedIds = [];
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => crypto.randomUUID(),
    handlers: {
      "host.notifications.cloudFeed.resolve": (params) => {
        resolvedIds.push(params.entryId);
        return Promise.resolve({ status: "applied", version: 2 });
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  state.client = client.createRequester(mockLocalHostEntry);
  state.binding = {
    ...auth,
    hostClient: client,
    directory: {
      ...auth.directory,
      getLocalEntry: () => mockLocalHostEntry,
      onChange: () => ({ dispose: () => undefined }),
    },
  };
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  state.client = null;
  state.binding = null;
  state.controlUnavailable = null;
  useCloudNotificationsStore.getState().reset();
  useAuthStore.getState().setSignedOut();
});

describe("sandbox resting warnings in the notification center", () => {
  it.each([undefined, null])(
    "an ended episode retires from the list and stays retired when a fresh feed replays it with resolvedAt %s",
    async (resolvedAt) => {
      const updatedAt = Date.now();
      seed([warning("resting", updatedAt, resolvedAt)]);
      mount(false, false);
      await waitFor(() => expect(resolvedAtOf("resting")).not.toBeNull());
      expect(bellLabel()).toBe("Notifications");
      // The relay forgot the retirement; the cloud store restarts empty.
      act(() => {
        useCloudNotificationsStore.getState().reset();
        seed([warning("resting", updatedAt, resolvedAt)]);
      });
      await waitFor(() => expect(resolvedAtOf("resting")).not.toBeNull());
      expect(bellLabel()).toBe("Notifications");
      expect(new Set(resolvedIds)).toEqual(new Set(["resting"]));
    },
  );

  it("moves an ended episode from Needs attention to Recent activity with the center open", async () => {
    seed([warning("resting", Date.now(), undefined)]);
    mount(true, false);
    await waitFor(() =>
      expect(screen.queryByText("Needs attention")).toBeNull(),
    );
    expect(screen.getByText("Recent activity")).toBeTruthy();
    expect(screen.getByText(/build-box is destroyed/)).toBeTruthy();
    await waitFor(() => expect(resolvedIds).toEqual(["resting"]));
  });

  it("keeps the same clock in Needs attention and counts it on the bell", async () => {
    auth.auth.listSandboxes.mockResolvedValue(RESTING);
    seed([warning("resting", Date.now(), undefined)]);
    mount(true, false);
    await listSettled(1);
    expect(resolvedAtOf("resting")).toBeNull();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(bellLabel()).toBe("Notifications, 1 needs you");
    expect(resolvedIds).toEqual([]);
  });

  it("retains a resting warning when an older list has no clock evidence", async () => {
    auth.auth.listSandboxes.mockResolvedValue(listing({ state: "suspended" }));
    seed([warning("resting", Date.now(), undefined)]);
    mount(false, false);
    await listSettled(1);
    expect(resolvedAtOf("resting")).toBeNull();
    expect(bellLabel()).toBe("Notifications, 1 needs you");
    expect(resolvedIds).toEqual([]);
  });

  it.each([
    ["a new destroy time", { destroyAt: DESTROY_AT + 5 * 60_000 }],
    ["a later rest", { restingSince: RESTING_SINCE + 1 }],
    ["a destroyed sandbox", { state: "destroyed", destroyAt: null }],
  ] satisfies ReadonlyArray<readonly [string, Partial<SandboxSummary>]>)(
    "retires for %s",
    async (_name, change) => {
      const { response } = RESTING;
      auth.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes: response.sandboxes.map((sandbox) => ({
            ...sandbox,
            ...change,
          })),
        },
      });
      seed([warning("resting", Date.now(), undefined)]);
      mount(false, false);
      await waitFor(() => expect(resolvedAtOf("resting")).not.toBeNull());
      expect(bellLabel()).toBe("Notifications");
    },
  );

  it.each(["unavailable", "hidden-row", "other-sandbox"])(
    "retains the warning when the list cannot speak for the sandbox: %s",
    async (kind) => {
      if (kind === "unavailable")
        auth.auth.listSandboxes.mockResolvedValue({
          kind: "network-error",
          detail: "offline",
        });
      if (kind === "hidden-row")
        auth.auth.listSandboxes.mockResolvedValue({
          kind: "ok",
          response: { sandboxes: [] },
        });
      if (kind === "other-sandbox")
        auth.auth.listSandboxes.mockResolvedValue(
          listing({ id: "another-sandbox", state: "awake" }),
        );
      seed([warning("resting", Date.now(), undefined)]);
      mount(false, false);
      await listSettled(1);
      expect(resolvedAtOf("resting")).toBeNull();
      expect(bellLabel()).toBe("Notifications, 1 needs you");
      expect(resolvedIds).toEqual([]);
    },
  );

  it("retains the warning while the list has not loaded", async () => {
    auth.auth.listSandboxes.mockReturnValue(new Promise(() => undefined));
    seed([warning("resting", Date.now(), undefined)]);
    mount(false, false);
    await waitFor(() =>
      expect(auth.auth.listSandboxes).toHaveBeenCalledTimes(1),
    );
    expect(resolvedAtOf("resting")).toBeNull();
    expect(bellLabel()).toBe("Notifications, 1 needs you");
    expect(resolvedIds).toEqual([]);
  });

  it("does not retire against a list read sent before the warning was raised", async () => {
    const sentAt = await preloadList();
    // The sandbox rested after that awake answer; the refetch says so.
    auth.auth.listSandboxes.mockResolvedValue(RESTING);
    seed([warning("resting", sentAt + 1, undefined)]);
    mount(false, false);
    await listSettled(2);
    expect(resolvedAtOf("resting")).toBeNull();
    expect(bellLabel()).toBe("Notifications, 1 needs you");
    expect(resolvedIds).toEqual([]);
  });

  it("ignores a cached list while the control plane is unavailable", async () => {
    const sentAt = await preloadList();
    state.controlUnavailable = "unavailable on this build";
    seed([warning("resting", sentAt - 1, undefined)]);
    mount(false, false);
    await act(async () => {
      await queryClient.cancelQueries();
    });
    expect(auth.auth.listSandboxes).toHaveBeenCalledTimes(1);
    expect(resolvedAtOf("resting")).toBeNull();
    expect(bellLabel()).toBe("Notifications, 1 needs you");
    expect(resolvedIds).toEqual([]);
  });

  it("shares one list read with another consumer of the sandbox list", async () => {
    seed([warning("resting", Date.now(), undefined)]);
    mount(false, true);
    await waitFor(() => expect(resolvedAtOf("resting")).not.toBeNull());
    expect(auth.auth.listSandboxes).toHaveBeenCalledTimes(1);
  });

  it("reads no sandbox list while there is no resting warning", async () => {
    seed([]);
    mount(false, false);
    await act(async () => {
      await queryClient.cancelQueries();
    });
    expect(auth.auth.listSandboxes).not.toHaveBeenCalled();
    expect(bellLabel()).toBe("Notifications");
  });
});
