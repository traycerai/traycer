import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  environmentStatusResponseSchemaV11,
  type EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import type {
  HostNotificationEnvironmentApplyFailedPayload,
  HostNotificationsCloudFeedRowV15,
} from "@traycer/protocol/host/notifications/contracts";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { SandboxSettingsNoticeObservers } from "@/components/notifications/sandbox-settings-notice-observers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
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
const auth = createFakeSandboxBinding();
let queryClient: QueryClient;
let currentStatus: EnvironmentStatusResponseV11;
let statusRead: () => Promise<EnvironmentStatusResponseV11>;
let statusReads: number;
let resolvedIds: string[];
let repairSucceeds: boolean;

type EnvironmentApplyFailedRow = HostNotificationsCloudFeedRowV15 & {
  readonly entry: Extract<
    HostNotificationsCloudFeedRowV15["entry"],
    { kind: "environment.apply.failed" }
  > & {
    readonly payload: HostNotificationEnvironmentApplyFailedPayload;
  };
};

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
): EnvironmentApplyFailedRow {
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
function readNotice(row: EnvironmentApplyFailedRow): EnvironmentApplyFailedRow {
  return {
    ...row,
    entry: { ...row.entry, readAt: Date.now() },
  };
}
function seed(rows: HostNotificationsCloudFeedRowV15[]): void {
  // The opened session's owner: the signed-in `settings-user` below.
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
function Shell(props: { readonly showCenter: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <SandboxSettingsNoticeObservers />
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
function mount(showCenter: boolean): void {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Shell showCenter={showCenter} />,
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
  // The host negotiated the combined retry, which offers `Retry applying`.
  recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
    "host.sandbox.repairGuestConfiguration": { major: 1, minor: 1 },
  });
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
  repairSucceeds = true;
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
      "host.sandbox.repairGuestConfiguration": () =>
        Promise.resolve({
          // A retry that did not apply leaves the guest itself configured.
          guestConfigured: true,
          guestConfigFailureReason: null,
          settingsApplied: repairSucceeds,
        }),
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
  resetNegotiatedManifests();
  queryClient.clear();
  state.client = null;
  state.binding = null;
  useCloudNotificationsStore.getState().reset();
  useAuthStore.getState().setSignedOut();
});

describe("sandbox settings warnings in the notification center", () => {
  it("moves a read failed-apply notice without sandbox context to Recent", async () => {
    const original = notice("non-sandbox-warning", OPERATION_ID);
    const unread: EnvironmentApplyFailedRow = {
      ...original,
      entry: {
        ...original.entry,
        readAt: null,
        payload: { ...original.entry.payload, sandbox: null },
      },
    };
    expect(unread.entry).not.toHaveProperty("resolvedAt");
    seed([unread]);
    mount(true);
    await screen.findByText("Needs attention");

    act(() => seed([readNotice(unread)]));

    await waitFor(() => {
      expect(screen.queryByText("Needs attention")).toBeNull();
      const row = screen.getByTestId("notification-entry");
      const section = row.closest("section");
      if (section === null) throw new Error("notification has no section");
      expect(section.textContent).toContain("Recent activity");
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getByTestId("environment-apply-failed-card")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Details" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry applying" })).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications");
    expect(screen.queryByTestId("notifications-needs-you-count")).toBeNull();
    expect(auth.auth.listSandboxes).not.toHaveBeenCalled();
    expect(statusReads).toBe(0);
    expect(resolvedIds).toEqual([]);
  });

  it("keeps read sandbox warnings actionable when sandbox identity is unavailable", async () => {
    const original = notice("unknown-sandbox-identity", OPERATION_ID);
    const sandbox = original.entry.payload.sandbox;
    if (sandbox === undefined || sandbox === null)
      throw new Error("notice fixture has no sandbox context");
    const unread: EnvironmentApplyFailedRow = {
      ...original,
      entry: {
        ...original.entry,
        readAt: null,
        payload: {
          ...original.entry.payload,
          sandbox: { ...sandbox, sandboxId: null, operationId: null },
        },
      },
    };
    expect(unread.entry).not.toHaveProperty("resolvedAt");
    seed([unread]);
    mount(true);
    await screen.findByText("Needs attention");

    act(() => seed([readNotice(unread)]));

    await waitFor(() =>
      expect(
        screen
          .getByTestId("notification-entry")
          .getAttribute("data-notification-read"),
      ).toBe("true"),
    );
    expect(screen.getByText("Needs attention")).not.toBeNull();
    expect(
      await screen.findByRole("button", { name: "Retry applying" }),
    ).not.toBeNull();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, 1 needs you");
    expect(statusReads).toBe(0);
    expect(resolvedIds).toEqual([]);
  });

  it("retires from a fresh successful status for the notice's own operation while the center is closed", async () => {
    currentStatus = status(OPERATION_ID, "applied");
    seed([notice("warning", OPERATION_ID)]);
    mount(false);
    await waitFor(() => expect(resolution("warning")).not.toBeNull());
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications");
    expect(resolvedIds).toEqual(["warning"]);
    expect(auth.auth.listSandboxes).toHaveBeenCalledTimes(1);
  });
  it.each(["applied", "failed", "unsupported"])(
    "a different operation's %s item does not retire the notice",
    async (itemStatus) => {
      currentStatus = status("later-operation", itemStatus);
      seed([notice("warning", OPERATION_ID)]);
      mount(false);
      await waitFor(() => expect(statusReads).toBe(1));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(resolution("warning")).toBeNull();
      expect(
        screen.getByTestId("notifications-bell").getAttribute("aria-label"),
      ).toBe("Notifications, 1 needs you");
      expect(resolvedIds).toEqual([]);
    },
  );
  it("Retry applying retires its own row only after a successful action", async () => {
    seed([notice("warning", OPERATION_ID)]);
    mount(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry applying" }),
    );
    await waitFor(() => expect(resolution("warning")).not.toBeNull());
    expect(resolvedIds).toEqual(["warning"]);
  });
  it.each([
    "failed",
    "pending",
    "received",
    "offline",
    "unknown-operation",
    "old-host",
  ])("retains an unconfirmed status: %s", async (kind) => {
    currentStatus = status(
      OPERATION_ID,
      kind === "offline" || kind === "unknown-operation" || kind === "old-host"
        ? "applied"
        : kind,
    );
    if (kind === "offline")
      currentStatus = { ...currentStatus, reachability: "offline" };
    if (kind === "unknown-operation")
      currentStatus = { ...currentStatus, sandboxSettingsOperationId: null };
    if (kind === "old-host")
      currentStatus = {
        ...currentStatus,
        sandboxSettingsOperationId: undefined,
      };
    seed([notice("warning", OPERATION_ID)]);
    mount(false);
    await waitFor(() => expect(statusReads).toBe(1));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(resolution("warning")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, 1 needs you");
    expect(resolvedIds).toEqual([]);
  });
  it.each([
    "list-error",
    "hidden-row",
    "host-error",
    "guest-unknown",
    "guest-failed",
  ])("retains unavailable evidence: %s", async (kind) => {
    currentStatus = status(OPERATION_ID, "applied");
    if (kind === "list-error")
      auth.auth.listSandboxes.mockResolvedValue({
        kind: "network-error",
        detail: "offline",
      });
    if (kind === "hidden-row")
      auth.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: [] },
      });
    if (kind === "host-error")
      statusRead = () => Promise.reject(new Error("offline"));
    if (kind === "guest-unknown" || kind === "guest-failed")
      auth.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes: [
            sandboxSummaryFixture({
              id: SANDBOX_ID,
              hostId: HOST_ID,
              guestConfigured: kind === "guest-failed" ? false : null,
            }),
          ],
        },
      });
    seed([notice("warning", OPERATION_ID)]);
    mount(false);
    await waitFor(() =>
      expect(auth.auth.listSandboxes).toHaveBeenCalledTimes(1),
    );
    if (kind !== "list-error" && kind !== "hidden-row") {
      await waitFor(() => expect(statusReads).toBe(1));
    }
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(resolution("warning")).toBeNull();
    expect(resolvedIds).toEqual([]);
  });
  it("keeps the warning when Retry applying does not finish successfully", async () => {
    repairSucceeds = false;
    seed([notice("warning", OPERATION_ID)]);
    mount(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry applying" }),
    );
    await screen.findByText("Settings still didn't apply · SBX-0520");
    expect(resolution("warning")).toBeNull();
    expect(resolvedIds).toEqual([]);
  });
  it("shares one list read between multiple active notices", async () => {
    currentStatus = status(OPERATION_ID, "applied");
    seed([
      notice("warning-a", OPERATION_ID),
      notice("warning-b", OPERATION_ID),
    ]);
    mount(false);
    await waitFor(() =>
      expect(resolvedIds.sort()).toEqual(["warning-a", "warning-b"]),
    );
    expect(auth.auth.listSandboxes).toHaveBeenCalledTimes(1);
  });
  it("reads no sandbox list without an active settings warning", async () => {
    seed([]);
    mount(false);
    await act(async () => {
      await queryClient.cancelQueries();
    });
    expect(auth.auth.listSandboxes).not.toHaveBeenCalled();
  });
  it("a new operation's notice retains its warning without a second status read", async () => {
    seed([notice("warning", OPERATION_ID)]);
    mount(false);
    await waitFor(() => expect(statusReads).toBe(1));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    act(() => seed([notice("warning", "new-warning")]));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(statusReads).toBe(1);
    expect(resolution("warning")).toBeNull();
    expect(resolvedIds).toEqual([]);
  });
});
