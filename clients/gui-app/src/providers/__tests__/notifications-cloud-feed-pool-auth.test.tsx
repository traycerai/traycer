import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { stageNotificationPartitionFloors } from "./notification-partition-floors";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamClientBinding } from "@/hooks/host/use-host-stream-client-for";

interface PoolProviderHarness {
  client: HostClient<HostRpcRegistry> | null;
  readonly streams: Map<string, IHostStreamClient<HostStreamRpcRegistry>>;
}

const harness = vi.hoisted<PoolProviderHarness>(() => ({
  client: null,
  streams: new Map(),
}));

const mockAuth = {
  onChange: vi.fn((_handler: (status: string) => void) => ({
    dispose: vi.fn(),
  })),
  revalidateCurrentContext: vi.fn(() => Promise.resolve(null)),
};

vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => mockLocalHostEntry.hostId,
  useNotificationResolveHost: () => ({
    hostId: mockLocalHostEntry.hostId,
    client: harness.client,
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => harness.client,
  useHostRuntimeClient: () => harness.client,
  useAuthService: () => mockAuth,
}));

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
  useReactiveLocalHostEntry: () => mockLocalHostEntry,
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
  useRunnerHostOrNull: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => harness.client,
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (target: HostDirectoryEntry | null) =>
    target === null || harness.client === null
      ? null
      : harness.client.createRequester(target),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId === poolEntry.hostId ? poolEntry : mockLocalHostEntry,
}));

vi.mock("@/hooks/notifications/use-notifications", () => ({
  useNotificationShow: () => vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivationWithNavigate: () => ({
    activate: vi.fn(),
    pendingFeedId: null,
  }),
}));

vi.mock("@/stores/notifications/merged-notifications", () => ({
  useMergedNotificationsActions: () => ({
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    markEntityAsRead: vi.fn(),
    loadMoreHost: vi.fn(),
    canLoadMoreHost: false,
    isLoadingMoreHost: false,
    hasHostLoadError: false,
    loadMoreAttention: vi.fn(),
    canLoadMoreAttention: false,
    isLoadingMoreAttention: false,
    hasAttentionLoadError: false,
    loadMoreUnreadRecent: vi.fn(),
    canLoadMoreUnreadRecent: false,
    isLoadingMoreUnreadRecent: false,
    hasUnreadRecentLoadError: false,
  }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useAuthStore } from "@/stores/auth/auth-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";

settleProcessHostRpcTierPlan(poolEntry);

function createHostClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "pool-auth-request",
      handlers: {
        "host.notifications.markRead": () => ({}),
        "host.notifications.indicatorState": () =>
          ({
            epics: {},
            chats: {},
            complete: true,
          }) satisfies HostNotificationsIndicatorStateResponse,
      },
    }),
    findHostById: () => mockLocalHostEntry,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return client;
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

async function renderPoolNotificationsProvider(): Promise<{
  readonly serving: FakeStreamClient;
  readonly pool: FakeStreamClient;
}> {
  const serving = new FakeStreamClient(true);
  const pool = new FakeStreamClient(true);
  harness.client = createHostClient();
  harness.streams.clear();
  harness.streams.set(mockLocalHostEntry.hostId, serving);
  harness.streams.set(poolEntry.hostId, pool);
  useAppLocalNotificationsStore.getState().activateIdentity("user-a");
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-a", userName: "user-a", email: "a@example.com" },
    contextMetadata: { userId: "user-a", username: "user-a" },
    subscriptionStatus: "FREE",
  });

  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationsSessionProvider navigate={() => Promise.resolve()}>
        <div />
      </NotificationsSessionProvider>
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(serving.subscribes.map(({ method }) => method)).toEqual(
      expect.arrayContaining([
        "agent.activity.subscribe",
        "notifications.subscribe",
        "host.notifications.feed.subscribe",
      ]),
    );
    expect(pool.subscribes.map(({ method }) => method)).toContain(
      "host.notifications.cloudFeed.subscribe",
    );
  });
  return { serving, pool };
}

describe("NotificationsSessionProvider pool sign-in recovery", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stageNotificationPartitionFloors([mockLocalHostEntry.hostId]);
    mockAuth.onChange.mockClear();
    mockAuth.revalidateCurrentContext.mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    useAppLocalNotificationsStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    harness.client = null;
    harness.streams.clear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    useAppLocalNotificationsStore.getState().resetForTests();
    resetNegotiatedManifests();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  it("revalidates sign-in when the pool cloud-feed connection closes unauthorized", async () => {
    const { pool } = await renderPoolNotificationsProvider();
    act(() => {
      sessionFor(pool, "host.notifications.cloudFeed.subscribe").emitClosed(
        fatalUnauthorized(),
      );
    });
    expect(mockAuth.revalidateCurrentContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    "agent.activity.subscribe",
    "notifications.subscribe",
    "host.notifications.feed.subscribe",
  ] as const)(
    "does not revalidate sign-in when serving-host %s closes",
    async (method) => {
      const { serving } = await renderPoolNotificationsProvider();
      act(() => {
        sessionFor(serving, method).emitClosed(fatalUnauthorized());
      });
      expect(mockAuth.revalidateCurrentContext).not.toHaveBeenCalled();
    },
  );
});
