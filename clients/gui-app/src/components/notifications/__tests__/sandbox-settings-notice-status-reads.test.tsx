import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  environmentStatusResponseSchemaV11,
  type EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import type { HostNotificationsCloudFeedRowV16 } from "@traycer/protocol/host/notifications/contracts";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { SandboxSettingsNoticeObservers } from "@/components/notifications/sandbox-settings-notice-observers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { sandboxQueryKeys } from "@/lib/query-keys";
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
  entry: null as HostDirectoryEntry | null,
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
  useHostDirectoryEntry: () => state.entry,
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
  useRunnerHostOrNull: () => null,
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
const SANDBOX_ID = "sbx-settings";
const OPERATION_ID = "attempt-failed";
const USER_ID = "settings-user";
const auth = createFakeSandboxBinding();
let queryClient: QueryClient;
let currentStatus: EnvironmentStatusResponseV11;
let statusRead: () => Promise<EnvironmentStatusResponseV11>;
let statusReads: number;
let resolvedIds: string[];

function status(
  operationId: string | null | undefined,
  itemStatus: string,
): EnvironmentStatusResponseV11 {
  return environmentStatusResponseSchemaV11.parse({
    principal: { kind: "personal" },
    reachability: "connected",
    bindingGeneration: 1,
    desiredRevision: 5,
    receivedRevision: 5,
    appliedRevision: 5,
    receiptAgeMs: 0,
    remoteAccess: "on",
    pendingUploads: [],
    setup: null,
    sandboxSettingsOperationId: operationId,
    items: [
      {
        kind: "variable",
        key: "variable/test",
        os: "any",
        desiredRevision: 5,
        status: itemStatus,
        code: "ok",
        args: { exitStatus: null, stage: null, durationMs: null, kind: null },
        brokerEnforced: null,
        minimumHostVersion: null,
        appliedAs: null,
      },
    ],
  });
}
function notice(
  entryId: string,
  operationId: string,
): HostNotificationsCloudFeedRowV16 {
  return {
    entryId,
    originHostId: "cloud-settings",
    coalesceKey: entryId,
    presentation: { epicTitle: null, chatTitle: null },
    entry: {
      id: entryId,
      updatedAt: Date.now(),
      readAt: Date.now(),
      kind: "environment.apply.failed",
      sourceRef: entryId,
      severity: "needs_action",
      epicId: null,
      chatId: null,
      outcome: "errored",
      payload: {
        kind: "environment_apply_failed",
        environmentId: "env_01J0000000000000000000A",
        hostId: HOST_ID,
        hostName: "build-box",
        itemKey: "settings",
        reason: "settings_not_applied",
        sandbox: {
          sandboxId: SANDBOX_ID,
          operationId,
          name: "build-box",
          configurationName: "Acme",
          attemptId: operationId,
          applied: [],
          notApplied: ["Variables"],
        },
      },
    },
  };
}
function seed(rows: HostNotificationsCloudFeedRowV16[]): void {
  useCloudNotificationsStore.setState({ accountId: "settings-user" });
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    summary: { totalCount: rows.length, unreadCount: 0, attentionCount: 0 },
    version: (useCloudNotificationsStore.getState().version ?? 0) + 1,
  });
}
function resolution(entryId: string): number | null {
  const row = Object.values(useCloudNotificationsStore.getState().rows).find(
    (row) => row?.entryId === entryId,
  );
  return row?.entry.kind === "environment.apply.failed"
    ? (row.entry.resolvedAt ?? null)
    : null;
}
function Shell() {
  return (
    <>
      <SandboxSettingsNoticeObservers />
      <NotificationsBell />
    </>
  );
}
function mount(): void {
  const router = createRouter({
    routeTree: createRootRoute({
      component: Shell,
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

beforeEach(() => {
  auth.auth.listSandboxes.mockReset();
  auth.auth.listSandboxes.mockResolvedValue({
    kind: "ok",
    response: {
      sandboxes: [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: HOST_ID,
          state: "awake",
          guestConfigured: true,
        }),
      ],
    },
  });
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "settings-user", userName: "U", email: "u@example.com" },
      { userId: "settings-user", username: "U" },
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
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  currentStatus = status(OPERATION_ID, "failed");
  statusReads = 0;
  resolvedIds = [];
  statusRead = () => Promise.resolve(currentStatus);
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => crypto.randomUUID(),
    handlers: {
      "environment.status": async () => {
        statusReads += 1;
        return statusRead();
      },
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
  state.entry = mockLocalHostEntry;
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
  state.entry = null;
  state.binding = null;
  useCloudNotificationsStore.getState().reset();
  useAuthStore.getState().setSignedOut();
});

function listWith(
  rows: readonly {
    id: string;
    lastTransitionAt: number;
    state: "awake" | "suspended";
    guestConfigured: boolean | null;
  }[],
): void {
  auth.auth.listSandboxes.mockResolvedValue({
    kind: "ok",
    response: {
      sandboxes: rows.map((row) =>
        sandboxSummaryFixture({ ...row, hostId: HOST_ID }),
      ),
    },
  });
}
async function refetchList(): Promise<void> {
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: sandboxQueryKeys.list(auth.auth, USER_ID),
    });
  });
}
const AWAKE = {
  id: SANDBOX_ID,
  lastTransitionAt: 1,
  state: "awake",
  guestConfigured: true,
} as const;

describe("sandbox settings warning status reads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("does not poll environment.status while the center is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    currentStatus = status(OPERATION_ID, "pending");
    seed([notice("warning", OPERATION_ID)]);
    mount();
    await waitFor(() => expect(statusReads).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(statusReads).toBe(1);
    expect(resolution("warning")).toBeNull();
  });
  it("two notices on one host and sandbox share one status read", async () => {
    currentStatus = status(OPERATION_ID, "applied");
    seed([
      notice("warning-a", OPERATION_ID),
      notice("warning-b", OPERATION_ID),
    ]);
    mount();
    await waitFor(() =>
      expect([...resolvedIds].sort()).toEqual(["warning-a", "warning-b"]),
    );
    expect(statusReads).toBe(1);
  });
  it.each([
    ["transition revision", { ...AWAKE, lastTransitionAt: 2 }],
    [
      "waking after a rest",
      { ...AWAKE, state: "suspended", lastTransitionAt: 2 },
    ],
  ] as const)(
    "a relevant row change (%s) reads status afresh",
    async (_n, next) => {
      currentStatus = status(OPERATION_ID, "pending");
      listWith([AWAKE]);
      seed([notice("warning", OPERATION_ID)]);
      mount();
      await waitFor(() => expect(statusReads).toBe(1));
      listWith([next]);
      await refetchList();
      if (next.state === "suspended") {
        listWith([{ ...AWAKE, lastTransitionAt: 3 }]);
        await refetchList();
      }
      await waitFor(() => expect(statusReads).toBeGreaterThan(1));
    },
  );
  it("an unrelated sandbox row changing reads no status", async () => {
    currentStatus = status(OPERATION_ID, "pending");
    const other = {
      id: "sbx-other",
      lastTransitionAt: 1,
      state: "awake",
      guestConfigured: true,
    } as const;
    listWith([AWAKE, other]);
    seed([notice("warning", OPERATION_ID)]);
    mount();
    await waitFor(() => expect(statusReads).toBe(1));
    listWith([AWAKE, { ...other, lastTransitionAt: 9, state: "suspended" }]);
    await refetchList();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(statusReads).toBe(1);
  });
  it("a second notice on an unchanged row and connection reads no new status", async () => {
    currentStatus = status(OPERATION_ID, "pending");
    listWith([AWAKE]);
    seed([notice("warning", OPERATION_ID)]);
    mount();
    await waitFor(() => expect(statusReads).toBe(1));
    act(() =>
      seed([
        notice("warning", OPERATION_ID),
        notice("second", "other-operation"),
      ]),
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(statusReads).toBe(1);
  });
  it("a cached applied receipt retires only its own operation, including a notice added later", async () => {
    currentStatus = status(OPERATION_ID, "applied");
    listWith([AWAKE]);
    seed([notice("own", OPERATION_ID), notice("other", "other-operation")]);
    mount();
    await waitFor(() => expect(resolvedIds).toEqual(["own"]));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    act(() =>
      seed([
        notice("other", "other-operation"),
        notice("later", "later-operation"),
      ]),
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(statusReads).toBe(1);
    expect(resolvedIds).toEqual(["own"]);
    expect(resolution("other")).toBeNull();
    expect(resolution("later")).toBeNull();
  });
  it("returning to an earlier row reads status afresh after the intermediate row's read", async () => {
    currentStatus = status(OPERATION_ID, "pending");
    listWith([AWAKE]);
    seed([notice("warning", OPERATION_ID)]);
    mount();
    await waitFor(() => expect(statusReads).toBe(1));
    listWith([{ ...AWAKE, guestConfigured: null }]);
    await refetchList();
    await waitFor(() => expect(statusReads).toBe(2));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    listWith([AWAKE]);
    await refetchList();
    await waitFor(() => expect(statusReads).toBe(3));
  });
  it("the selected sandbox reaching guestConfigured reads status afresh", async () => {
    currentStatus = status(OPERATION_ID, "pending");
    listWith([{ ...AWAKE, guestConfigured: false }]);
    seed([notice("warning", OPERATION_ID)]);
    mount();
    await waitFor(() => expect(auth.auth.listSandboxes).toHaveBeenCalled());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const before = statusReads;
    listWith([AWAKE]);
    await refetchList();
    await waitFor(() => expect(statusReads).toBeGreaterThan(before));
  });
  it("the selected sandbox's wake phase changing reads status afresh", async () => {
    currentStatus = status(OPERATION_ID, "pending");
    auth.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({
            ...AWAKE,
            hostId: HOST_ID,
            phase: "booting",
          }),
        ],
      },
    });
    seed([notice("warning", OPERATION_ID)]);
    mount();
    await waitFor(() => expect(statusReads).toBe(1));
    auth.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({ ...AWAKE, hostId: HOST_ID, phase: "ready" }),
        ],
      },
    });
    await refetchList();
    await waitFor(() => expect(statusReads).toBeGreaterThan(1));
  });
  it("a host connection change reads status afresh", async () => {
    currentStatus = status(OPERATION_ID, "pending");
    listWith([AWAKE]);
    seed([notice("warning", OPERATION_ID)]);
    mount();
    await waitFor(() => expect(statusReads).toBe(1));
    state.entry = {
      ...mockLocalHostEntry,
      websocketUrl: "ws://127.0.0.1:1/changed",
    };
    act(() => seed([notice("warning", OPERATION_ID)]));
    await act(async () => {
      await refetchList();
    });
    await waitFor(() => expect(statusReads).toBeGreaterThan(1));
  });
});
