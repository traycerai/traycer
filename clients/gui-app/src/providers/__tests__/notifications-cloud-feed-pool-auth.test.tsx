import "fake-indexeddb/auto";
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
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  NO_SERVING_PEER_DECISION,
  createHostRpcTierPlan,
  settleProcessHostRpcTierPlan,
  type HostServingDecision,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  getNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { accountWideManifestFixtures } from "@traycer-clients/shared/test-fixtures/account-wide-manifest";
import { stageNotificationPartitionFloors } from "./notification-partition-floors";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  HostNotificationsCloudFeedRow,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamClientBinding } from "@/hooks/host/use-host-stream-client-for";
import type { ReactNode } from "react";

interface PoolProviderHarness {
  client: HostClient<HostRpcRegistry> | null;
  messenger: MockHostMessenger<HostRpcRegistry> | null;
  addressableHostId: string | null;
  noComputer: boolean;
  teamServing: boolean;
  readonly cloudArrivalCompletions: Array<Promise<void>>;
  readonly streams: Map<string, IHostStreamClient<HostStreamRpcRegistry>>;
}

const harness = vi.hoisted<PoolProviderHarness>(() => ({
  client: null,
  messenger: null,
  addressableHostId: null,
  noComputer: false,
  teamServing: false,
  cloudArrivalCompletions: [],
  streams: new Map(),
}));

const showNotificationMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve("presented" as const)),
);
const toastMock = vi.hoisted(() => {
  const toast = vi.fn();
  Object.assign(toast, { error: vi.fn(), success: vi.fn() });
  return toast;
});
const directory = vi.hoisted(() => ({
  list: vi.fn(() => Promise.resolve([])),
  onChange: vi.fn(() => ({ dispose: vi.fn() })),
}));

const mockAuth = {
  onChange: vi.fn((_handler: (status: string) => void) => ({
    dispose: vi.fn(),
  })),
  revalidateCurrentContext: vi.fn(() => Promise.resolve(null)),
};

vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () =>
    harness.noComputer ? null : mockLocalHostEntry.hostId,
  useNotificationResolveHost: () => ({
    hostId: harness.noComputer ? null : mockLocalHostEntry.hostId,
    client:
      harness.noComputer || harness.client === null
        ? null
        : harness.client.createRequesterForHostId(mockLocalHostEntry.hostId),
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () =>
    harness.client === null ? null : { hostClient: harness.client, directory },
  useHostClient: () => harness.client,
  useHostRuntimeClient: () => harness.client,
  useAuthService: () => mockAuth,
}));

vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostBinding: () =>
      harness.client === null
        ? null
        : { hostClient: harness.client, directory },
  };
});

vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: () => undefined,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => ({ major: 1, minor: 2 }),
  useStreamMethodSupportFor: () => "supported",
  useStreamMethodSchemaVersionFor: () => ({ major: 1, minor: 2 }),
}));

vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => {
    if (harness.noComputer) return null;
    return harness.teamServing ? teamComputerEntry : mockLocalHostEntry;
  },
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => ({
    revalidateForReconnect: () => Promise.resolve("rejected" as const),
  }),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async () => {
  const { remoteAwareOwnerIdentityKey } =
    await import("@/lib/host/transport-key");
  return {
    useHostStreamClientBindingFor: (
      target: HostDirectoryEntry | null,
    ): HostStreamClientBinding | null => {
      if (target === null || harness.client === null) return null;
      const client = harness.streams.get(target.hostId);
      const transportKey = remoteAwareOwnerIdentityKey(
        target,
        harness.client.getRequestContextUserId(),
      );
      if (client === undefined || transportKey === null) return null;
      return {
        client,
        transportKey,
        pin: () => undefined,
        unpin: () => undefined,
      };
    },
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () =>
    harness.noComputer
      ? {
          hasLocalHost: false,
          onSystemSuspended: () => ({ dispose: () => undefined }),
          onSystemResumed: () => ({ dispose: () => undefined }),
        }
      : null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => harness.addressableHostId,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    harness.client === null || hostId === null
      ? null
      : harness.client.createRequesterForHostId(hostId),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (target: HostDirectoryEntry | null) =>
    target === null || harness.client === null
      ? null
      : harness.client.createRequester(target),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0) return null;
    if (hostId === poolEntry.hostId) return poolEntry;
    return harness.teamServing ? teamComputerEntry : mockLocalHostEntry;
  },
}));

vi.mock("@/hooks/notifications/use-notifications", () => ({
  useNotificationShow: () => showNotificationMock,
}));

vi.mock(
  "@/hooks/notifications/use-notification-activation",
  async (importActual) => {
    const actual =
      await importActual<
        typeof import("@/hooks/notifications/use-notification-activation")
      >();
    return {
      ...actual,
      useNotificationActivationWithNavigate: () => ({
        activate: vi.fn(),
        pendingFeedId: null,
      }),
    };
  },
);

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/notifications/notification-display", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/notifications/notification-display")
    >();
  return {
    ...actual,
    displayCloudSnapshotArrivals: (
      ...args: Parameters<typeof actual.displayCloudSnapshotArrivals>
    ) => {
      const completion = actual.displayCloudSnapshotArrivals(...args);
      harness.cloudArrivalCompletions.push(completion);
      return completion;
    },
  };
});

import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { notificationsMutationKeys } from "@/lib/query-keys/notifications-mutation-keys";
import {
  notificationFeedReplicaAddress,
  notificationFeedReplicaService,
} from "@/lib/view-replica/notification-feed-replica";
import { viewReplicaStore } from "@/lib/view-replica/view-replica-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
import {
  cloudNotificationFeedId,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

settleProcessHostRpcTierPlan(poolEntry);

const teamComputerEntry: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  owner: { kind: "team", id: "team-1", name: "Team" },
};

function createHostClient(): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "pool-auth-request",
    handlers: {
      "host.notifications.markRead": () => ({}),
      "host.notifications.cloudFeed.markRead": () => ({
        status: "applied",
        version: 2,
      }),
      "host.notifications.indicatorState": () =>
        ({
          epics: {},
          chats: {},
          complete: true,
        }) satisfies HostNotificationsIndicatorStateResponse,
    },
  });
  harness.messenger = messenger;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger,
    findHostById: (hostId) => {
      if (hostId === poolEntry.hostId) return poolEntry;
      if (hostId === mockLocalHostEntry.hostId) {
        return harness.teamServing ? teamComputerEntry : mockLocalHostEntry;
      }
      return null;
    },
    routing: {
      plan: createHostRpcTierPlan(poolEntry),
      selectedHostId: () => null,
      serving: () => {
        const peer = useSelectionAuthorityStore.getState().servingPeer;
        if (peer === null) return NO_SERVING_PEER_DECISION;
        let entry: HostDirectoryEntry | null = null;
        if (peer.kind === "pool") entry = poolEntry;
        else if (peer.hostId === mockLocalHostEntry.hostId) {
          entry = harness.teamServing ? teamComputerEntry : mockLocalHostEntry;
        }
        return {
          servingPeer: entry,
          servingPeerMethods:
            entry === null ? null : getNegotiatedHostMethods(entry.hostId),
          servingPeerEnvironmentId: null,
        } satisfies HostServingDecision;
      },
    },
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return client;
}

function publishServingPeer(
  peer: "pool" | "computer",
  selectionRevision: number,
): void {
  const isComputer = peer === "computer";
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: isComputer ? mockLocalHostEntry.hostId : null,
    targetHostId: isComputer ? mockLocalHostEntry.hostId : null,
    effectiveHostId: isComputer ? mockLocalHostEntry.hostId : null,
    servingPeer: isComputer
      ? { kind: "computer", hostId: mockLocalHostEntry.hostId }
      : { kind: "pool" },
    noPeerPresentation: null,
    leases: [],
    selectionRevision,
  });
}

function cloudRow(
  entryId: string,
  updatedAt: number,
): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId: mockLocalHostEntry.hostId,
    coalesceKey: `agent.stopped:${entryId}`,
    entry: {
      id: entryId,
      updatedAt,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: entryId,
      severity: "done",
      outcome: "completed",
      epicId: "epic-cloud",
      chatId: "chat-cloud",
      payload: {
        kind: "chat",
        epicId: "epic-cloud",
        chatId: "chat-cloud",
        taskTitle: "Cloud epic",
        agentName: "Cloud chat",
        outcome: "completed",
      },
    },
    presentation: { epicTitle: "Cloud epic", chatTitle: "Cloud chat" },
  };
}

function recordComputerNotificationsManifest(): void {
  recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
    "host.notifications.list": { major: 2, minor: 2 },
    "host.notifications.markAllRead": { major: 1, minor: 1 },
    "host.notifications.indicatorState": { major: 1, minor: 1 },
    "host.notifications.clearAll": { major: 1, minor: 1 },
    "host.notifications.cloudFeed.subscribe": { major: 1, minor: 2 },
  });
}

function recordTeamComputerManifest(): void {
  const current = accountWideManifestFixtures().current;
  if (current.size !== 23) {
    throw new Error("the current team computer manifest must have 23 methods");
  }
  const manifest: Record<string, { major: number; minor: number }> = {};
  for (const method of current) {
    manifest[method] = { major: 1, minor: 1 };
  }
  Object.assign(manifest, {
    "host.notifications.list": { major: 2, minor: 2 },
    "host.notifications.markAllRead": { major: 1, minor: 1 },
    "host.notifications.indicatorState": { major: 1, minor: 1 },
    "host.notifications.clearAll": { major: 1, minor: 1 },
    "host.notifications.cloudFeed.subscribe": { major: 1, minor: 2 },
  });
  recordNegotiatedHostManifest(
    mockLocalHostEntry.hostId,
    manifest satisfies ConnectionManifest,
  );
}

function fatalUnauthorized(): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "test host refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function sessionFor(
  client: FakeStreamClient,
  method: string,
): FakeStreamClient["sessions"][number] {
  const index = client.subscribes.findIndex(
    (subscription) => subscription.method === method,
  );
  if (index < 0) {
    throw new Error(`No stream session opened for ${method}`);
  }
  return client.sessions[index];
}

function emitCloudSnapshot(
  session: FakeStreamSession,
  version: number,
  rows: ReadonlyArray<HostNotificationsCloudFeedRow>,
): void {
  session.emit(
    {
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version,
      rows,
      summary: {
        totalCount: rows.length,
        unreadCount: rows.filter((row) => row.entry.readAt === null).length,
        attentionCount: 0,
      },
    },
    null,
  );
}

async function awaitProviderCloudArrival(index: number): Promise<void> {
  const completion = harness.cloudArrivalCompletions.at(index);
  if (completion === undefined) {
    throw new Error(
      `the provider did not capture cloud arrival ${String(index)}`,
    );
  }
  await act(async () => {
    await completion;
  });
}

async function renderPoolNotificationsProvider(options: {
  readonly addressableHostId?: string | null;
  readonly noComputer: boolean;
  readonly servingPeer: "pool" | "computer" | null;
  readonly teamServing: boolean;
  readonly child: ReactNode;
}): Promise<{
  readonly serving: FakeStreamClient;
  readonly pool: FakeStreamClient;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
}> {
  const serving = new FakeStreamClient(true);
  const pool = new FakeStreamClient(true);
  const queryClient = new QueryClient();
  harness.client = createHostClient();
  harness.addressableHostId = options.addressableHostId ?? null;
  harness.noComputer = options.noComputer;
  harness.teamServing = options.teamServing;
  harness.streams.clear();
  harness.streams.set(mockLocalHostEntry.hostId, serving);
  harness.streams.set(poolEntry.hostId, pool);
  if (options.servingPeer === "computer") {
    if (options.teamServing) recordTeamComputerManifest();
    else recordComputerNotificationsManifest();
  }
  if (options.servingPeer !== null) {
    publishServingPeer(options.servingPeer, 1);
  }
  useAppLocalNotificationsStore.getState().activateIdentity("user-a");
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-a", userName: "user-a", email: "a@example.com" },
    contextMetadata: { userId: "user-a", username: "user-a" },
    subscriptionStatus: "FREE",
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <NotificationsSessionProvider navigate={() => Promise.resolve()}>
          {options.child}
        </NotificationsSessionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );

  await waitFor(() => {
    const opensCloudOnly = options.noComputer;
    const openedClient = opensCloudOnly ? pool : serving;
    const openedMethod = opensCloudOnly
      ? "host.notifications.cloudFeed.subscribe"
      : "host.notifications.feed.subscribe";
    expect(openedClient.subscribes.map(({ method }) => method)).toContain(
      openedMethod,
    );
  });
  const messenger = harness.messenger;
  if (messenger === null) throw new Error("Pool host messenger is missing");
  return { serving, pool, messenger, queryClient };
}

describe("NotificationsSessionProvider pool sign-in recovery", () => {
  beforeEach(() => {
    harness.cloudArrivalCompletions.length = 0;
    window.localStorage.clear();
    resetNegotiatedManifests();
    useSelectionAuthorityStore.getState().reset();
    useNotificationsPopoverStore.getState().setOpen(false);
    harness.noComputer = false;
    harness.addressableHostId = null;
    harness.teamServing = false;
    harness.messenger = null;
    showNotificationMock.mockClear();
    stageNotificationPartitionFloors([mockLocalHostEntry.hostId]);
    mockAuth.onChange.mockClear();
    mockAuth.revalidateCurrentContext.mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    useAppLocalNotificationsStore.getState().resetForTests();
  });

  afterEach(async () => {
    cleanup();
    harness.client = null;
    harness.messenger = null;
    harness.addressableHostId = null;
    harness.noComputer = false;
    harness.teamServing = false;
    harness.streams.clear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    useAppLocalNotificationsStore.getState().resetForTests();
    useSelectionAuthorityStore.getState().reset();
    useNotificationsPopoverStore.getState().setOpen(false);
    resetNegotiatedManifests();
    await viewReplicaStore.evict({ kind: "identity-retired" });
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  it("revalidates sign-in when the pool cloud-feed connection closes unauthorized", async () => {
    const { pool } = await renderPoolNotificationsProvider({
      noComputer: false,
      servingPeer: null,
      teamServing: false,
      child: <div />,
    });
    act(() => {
      sessionFor(pool, "host.notifications.cloudFeed.subscribe").emitClosed(
        fatalUnauthorized(),
      );
    });
    expect(mockAuth.revalidateCurrentContext).toHaveBeenCalledTimes(1);
  });

  it("serves and reads the cloud bell from the pool, then reopens once on the serving computer", async () => {
    const { messenger, pool, queryClient, serving } =
      await renderPoolNotificationsProvider({
        addressableHostId: mockLocalHostEntry.hostId,
        noComputer: true,
        servingPeer: "pool",
        teamServing: false,
        child: <NotificationsBell />,
      });
    await viewReplicaStore.warm("user-a");
    expect(pool.subscribes.map(({ method }) => method)).toEqual([
      "host.notifications.cloudFeed.subscribe",
    ]);
    expect(serving.subscribes).toEqual([]);

    const originalPoolSession = sessionFor(
      pool,
      "host.notifications.cloudFeed.subscribe",
    );
    const poolReplicaAddress = notificationFeedReplicaAddress(
      "user-a",
      poolEntry.hostId,
    );
    const computerReplicaAddress = notificationFeedReplicaAddress(
      "user-a",
      mockLocalHostEntry.hostId,
    );
    if (poolReplicaAddress === null || computerReplicaAddress === null) {
      throw new Error("both cloud-feed replica addresses must exist");
    }
    const row = cloudRow("pool-cloud-entry", 7);
    act(() => emitCloudSnapshot(originalPoolSession, 1, []));
    const initialRowDeliveryIndex = harness.cloudArrivalCompletions.length;
    act(() => emitCloudSnapshot(originalPoolSession, 2, [row]));
    await awaitProviderCloudArrival(initialRowDeliveryIndex);
    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(
        viewReplicaStore
          .read(notificationFeedReplicaService, poolReplicaAddress)
          ?.page.rows.map((storedRow) => storedRow.entryId),
      ).toEqual([row.entryId]);
    });

    fireEvent.click(screen.getByTestId("notifications-bell"));
    const title = await screen.findByTestId("notification-title");
    expect(title.textContent).toBe("Cloud epic");
    expect(screen.getAllByTestId("notification-title")).toHaveLength(1);
    expect(
      useCloudNotificationsStore.getState().rows[
        cloudNotificationFeedId(row.entryId)
      ],
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
    await waitFor(() => {
      expect(
        useCloudNotificationsStore.getState().rows[
          cloudNotificationFeedId(row.entryId)
        ]?.entry.readAt,
      ).not.toBeNull();
    });
    await waitFor(() => {
      expect(
        queryClient.getMutationCache().find({
          mutationKey: notificationsMutationKeys.cloudMarkRead(),
        })?.state.status,
      ).toBe("success");
    });
    await waitFor(() => {
      expect(
        messenger.calls.filter(
          (call) => call.method === "host.notifications.cloudFeed.markRead",
        ),
      ).toHaveLength(1);
    });
    expect(
      messenger.calls
        .filter(
          (call) => call.method === "host.notifications.cloudFeed.markRead",
        )
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          params: call.params,
        })),
    ).toEqual([
      {
        hostId: poolEntry.hostId,
        params: { entryId: row.entryId },
      },
    ]);

    // This frame is already queued on the live pool stream when the serving
    // store moves. Deliver it before React commits the replacement composition.
    const delayedPoolRow = {
      ...row,
      presentation: { ...row.presentation, epicTitle: "Pool late snapshot" },
    };
    const delayedPoolDeliveryIndex = harness.cloudArrivalCompletions.length;
    act(() => {
      harness.noComputer = false;
      recordComputerNotificationsManifest();
      publishServingPeer("computer", 2);
      emitCloudSnapshot(originalPoolSession, 4, [delayedPoolRow]);
    });
    await awaitProviderCloudArrival(delayedPoolDeliveryIndex);
    await waitFor(() => {
      expect(serving.subscribes.map(({ method }) => method).sort()).toEqual(
        [
          "agent.activity.subscribe",
          "host.notifications.cloudFeed.subscribe",
          "host.notifications.feed.subscribe",
          "notifications.subscribe",
        ].sort(),
      );
      expect(
        sessionFor(pool, "host.notifications.cloudFeed.subscribe").closed,
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        viewReplicaStore
          .read(notificationFeedReplicaService, poolReplicaAddress)
          ?.page.rows.map((storedRow) => [
            storedRow.entryId,
            storedRow.presentation.epicTitle,
          ]),
      ).toEqual([[row.entryId, "Pool late snapshot"]]);
    });
    expect(
      viewReplicaStore.read(
        notificationFeedReplicaService,
        computerReplicaAddress,
      ),
    ).toBeNull();
    expect(showNotificationMock).toHaveBeenCalledTimes(1);

    const computerDeliveryIndex = harness.cloudArrivalCompletions.length;
    act(() =>
      emitCloudSnapshot(
        sessionFor(serving, "host.notifications.cloudFeed.subscribe"),
        3,
        [row],
      ),
    );
    await awaitProviderCloudArrival(computerDeliveryIndex);
    await waitFor(() => {
      expect(screen.getAllByTestId("notification-title")).toHaveLength(1);
      expect(
        viewReplicaStore
          .read(notificationFeedReplicaService, computerReplicaAddress)
          ?.page.rows.map((storedRow) => storedRow.entryId),
      ).toEqual([row.entryId]);
    });
    expect(
      viewReplicaStore
        .read(notificationFeedReplicaService, poolReplicaAddress)
        ?.page.rows.map((storedRow) => [
          storedRow.entryId,
          storedRow.presentation.epicTitle,
        ]),
    ).toEqual([[row.entryId, "Pool late snapshot"]]);
    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    expect(pool.subscribes).toHaveLength(1);
    expect(
      serving.subscribes.filter(
        ({ method }) => method === "host.notifications.cloudFeed.subscribe",
      ),
    ).toHaveLength(1);

    act(() => {
      harness.noComputer = true;
      publishServingPeer("pool", 3);
    });
    await waitFor(() => {
      expect(
        pool.subscribes.filter(
          ({ method }) => method === "host.notifications.cloudFeed.subscribe",
        ),
      ).toHaveLength(2);
      expect(serving.sessions.every((session) => session.closed)).toBe(true);
    });
    expect(pool.sessions).toHaveLength(2);
    expect(pool.sessions[0].closed).toBe(true);
    const reopenedPoolSession = pool.sessions[1];
    expect(reopenedPoolSession.closed).toBe(false);
    const reopenedPoolDeliveryIndex = harness.cloudArrivalCompletions.length;
    act(() => emitCloudSnapshot(reopenedPoolSession, 5, [row]));
    await awaitProviderCloudArrival(reopenedPoolDeliveryIndex);
    await waitFor(() => {
      expect(screen.getAllByTestId("notification-title")).toHaveLength(1);
    });
    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    expect(
      useCloudNotificationsStore.getState().rows[
        cloudNotificationFeedId(row.entryId)
      ],
    ).toBeDefined();
  });

  it("opens the existing four stream composition when a computer serves from startup", async () => {
    const { pool, serving } = await renderPoolNotificationsProvider({
      noComputer: false,
      servingPeer: "computer",
      teamServing: false,
      child: <NotificationsBell />,
    });

    expect(serving.subscribes.map(({ method }) => method).sort()).toEqual(
      [
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
        "host.notifications.feed.subscribe",
        "notifications.subscribe",
      ].sort(),
    );
    expect(pool.subscribes).toEqual([]);
  });

  it("keeps the team-serving peer's cloud bell feed and mark-read on the pool", async () => {
    const { messenger, pool, serving } = await renderPoolNotificationsProvider({
      noComputer: false,
      servingPeer: "computer",
      teamServing: true,
      child: <NotificationsBell />,
    });
    expect(teamComputerEntry.owner).toEqual({
      kind: "team",
      id: "team-1",
      name: "Team",
    });
    expect(accountWideManifestFixtures().current.size).toBe(23);
    expect(
      pool.subscribes.filter(
        ({ method }) => method === "host.notifications.cloudFeed.subscribe",
      ),
    ).toHaveLength(1);
    expect(
      serving.subscribes.filter(
        ({ method }) => method === "host.notifications.cloudFeed.subscribe",
      ),
    ).toEqual([]);

    const row = cloudRow("team-cloud-entry", 9);
    act(() =>
      emitCloudSnapshot(
        sessionFor(pool, "host.notifications.cloudFeed.subscribe"),
        1,
        [row],
      ),
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect((await screen.findByTestId("notification-title")).textContent).toBe(
      "Cloud epic",
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
    await waitFor(() => {
      expect(
        messenger.calls.filter(
          (call) => call.method === "host.notifications.cloudFeed.markRead",
        ),
      ).toHaveLength(1);
    });
    expect(
      messenger.calls
        .filter(
          (call) => call.method === "host.notifications.cloudFeed.markRead",
        )
        .map((call) => call.authority.endpoint.hostId),
    ).toEqual([poolEntry.hostId]);
  });

  it.each([
    "agent.activity.subscribe",
    "notifications.subscribe",
    "host.notifications.feed.subscribe",
  ] as const)(
    "does not revalidate sign-in when serving-host %s closes",
    async (method) => {
      const { serving } = await renderPoolNotificationsProvider({
        noComputer: false,
        servingPeer: null,
        teamServing: false,
        child: <div />,
      });
      act(() => {
        sessionFor(serving, method).emitClosed(fatalUnauthorized());
      });
      expect(mockAuth.revalidateCurrentContext).not.toHaveBeenCalled();
    },
  );
});
