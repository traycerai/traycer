import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  poolHostDirectoryEntry,
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  callEnvironmentIdOf,
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
  settleProcessHostRpcTierPlan,
  type HostServingDecision,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { accountWideManifestFixtures } from "@traycer-clients/shared/test-fixtures/account-wide-manifest";
import { viewReplicaRequestScope } from "@traycer-clients/shared/view-replica/identity";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { taskLight } from "@/lib/view-replica/__tests__/replica-fixtures";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { queryClient as appQueryClient } from "@/lib/query-client";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useAutoPolicyQuery } from "@/hooks/auto-mode/use-auto-policy-query";
import { useConfigurationGuideQuery } from "@/hooks/environment/team/use-guide-query";
import { useConfigurationReadClient } from "@/hooks/environment/team/use-configuration-read-client";
import { useEnvironmentSkillsQuery } from "@/hooks/environment/team/use-environment-skills";
import {
  useCloudEpicTasksQuery,
  useCloudEpicTasksQueryForClient,
} from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { historyReplicaService } from "@/lib/view-replica/history-replica";
import { viewReplicaStore } from "@/lib/view-replica/view-replica-store";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";

const clientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));

const servingStore = vi.hoisted(() => {
  let current: HostServingDecision = {
    servingPeer: null,
    servingPeerMethods: null,
    servingPeerEnvironmentId: null,
  };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (decision: HostServingDecision) => {
      current = decision;
      for (const listener of [...listeners]) listener();
    },
  };
});

vi.mock("@/lib/host/app-serving-decision", async (importOriginal) => {
  const react = await import("react");
  const actual =
    await importOriginal<typeof import("@/lib/host/app-serving-decision")>();
  return {
    ...actual,
    readServingTierHostId: (
      method: string,
      callerHostId: string | null,
      selectedHostId: string | null,
      params: unknown,
    ) =>
      hostRpcServingTierHostId(
        method,
        callerHostId,
        readProcessHostRpcTierPlan(),
        selectedHostId,
        servingStore.get(),
        callEnvironmentIdOf(params),
      ),
    useAppServingDecision: () =>
      react.useSyncExternalStore(
        servingStore.subscribe,
        servingStore.get,
        servingStore.get,
      ),
  };
});

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (clientRef.current === null) {
        throw new Error("host client fixture is not installed");
      }
      return clientRef.current;
    },
  };
});

vi.mock("@/components/settings/environment/configuration-source", () => ({
  useConfigurationSource: () => ({
    kind: "pool",
    environmentId: "environment-1",
  }),
}));

vi.mock("@/hooks/environment/team/use-configuration-read-client", () => ({
  useConfigurationReadClient: () =>
    clientRef.current?.createRequesterForHostId("pool") ?? null,
}));

vi.mock("@/lib/host/cloud-verdict-preflight", () => ({
  cloudVerdictPreflight: () => () => undefined,
}));

const poolEntry = poolHostDirectoryEntry("wss://pool.test/rpc");
if (poolEntry === null) throw new Error("pool fixture must build");

describe("useHostQuery uses its answering peer for an account-wide list", () => {
  afterEach(async () => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    clientRef.current = null;
    servingStore.publish({
      servingPeer: null,
      servingPeerMethods: null,
      servingPeerEnvironmentId: null,
    });
    useSelectionAuthorityStore.getState().reset();
    resetNegotiatedManifests();
    appQueryClient.clear();
    await viewReplicaStore.evict({ kind: "identity-retired" });
  });

  it("refetches once when a personal manifest arrives and stays on the pool for a team peer", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    let requests = 0;
    let guideRequests = 0;
    let skillsRequests = 0;
    let taskListRequests = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `auto-policy-${requests}`,
      handlers: {
        "autoPolicy.get": () => {
          requests += 1;
          return {
            body: null,
            updatedAt: null,
            source: "account",
            team: null,
            readState: "fresh",
          };
        },
        "environment.configuration.guide.get": () => {
          guideRequests += 1;
          return {
            outcome: "ok",
            text: "Guide",
            revision: `guide-${guideRequests}`,
          };
        },
        "environment.configuration.skills.list": () => {
          skillsRequests += 1;
          return {
            outcome: "listed",
            revision: null,
            policyRevision: null,
            skills: [],
            deletedBundled: [],
          };
        },
        "epic.listTasks": () => {
          taskListRequests += 1;
          return { tasks: [taskLight("pool-task", null)], hasMore: false };
        },
        "epic.localHistory.read": () =>
          ({
            complete: true,
            willComplete: true,
            localHomeRows: [taskLight("team-local-task", null)],
            preservedRows: [],
            tombstonedEpicIds: [],
            localRows: "present",
          }) satisfies LocalHistoryReadResponse,
      },
    });
    const hostById = new Map<string, HostDirectoryEntry>([
      [poolEntry.hostId, poolEntry],
      [mockRemoteHostEntry.hostId, mockRemoteHostEntry],
      [
        "team-computer",
        {
          ...mockRemoteHostEntry,
          hostId: "team-computer",
          owner: { kind: "team", id: "team-1", name: "Team" },
        },
      ],
    ]);
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => hostById.get(hostId) ?? null,
      messenger,
      routing: {
        plan,
        selectedHostId: () => mockRemoteHostEntry.hostId,
        serving: () => servingStore.get(),
      },
    });
    clientRef.current = client;
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "test",
        identity: {
          userId: "viewer-1",
          username: "Viewer",
          providerHandle: "viewer",
        },
      }),
    );
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "viewer-1", userName: "Viewer", email: "viewer@example.com" },
        { userId: "viewer-1", username: "Viewer" },
        [],
      );
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const rendered = renderHook(
      () => {
        const skillsClient = useConfigurationReadClient();
        return {
          autoPolicy: useAutoPolicyQuery(),
          guide: useConfigurationGuideQuery(),
          skills: useEnvironmentSkillsQuery(skillsClient, true),
          tasks: useCloudEpicTasksQuery(undefined, { enabled: true }),
        };
      },
      { wrapper: Wrapper },
    );

    try {
      await waitFor(() => {
        expect(requests).toBe(1);
        expect(guideRequests).toBe(1);
        expect(skillsRequests).toBe(1);
        expect(taskListRequests).toBe(1);
      });
      expect(
        messenger.calls
          .filter((call) => call.method === "autoPolicy.get")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.listTasks")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
      expect(
        messenger.calls
          .filter(
            (call) => call.method === "environment.configuration.guide.get",
          )
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
      expect(
        messenger.calls
          .filter(
            (call) => call.method === "environment.configuration.skills.list",
          )
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);

      const teamPeer = hostById.get("team-computer");
      if (teamPeer === undefined) throw new Error("team fixture must exist");
      const currentManifest = accountWideManifestFixtures().current;
      expect(currentManifest.size).toBe(23);
      recordNegotiatedHostMethods(teamPeer.hostId, [...currentManifest]);
      useSelectionAuthorityStore.setState({
        servingPeer: { kind: "computer", hostId: teamPeer.hostId },
      });
      appQueryClient.setQueryData(
        hostQueryKeys.method<HostRpcRegistry, "environment.binding.read">(
          poolEntry.hostId,
          "environment.binding.read",
          { hostId: teamPeer.hostId },
        ),
        {
          hostId: teamPeer.hostId,
          environment: {
            environmentId: "environment-1",
            ownerKind: "organization",
            ownerId: "team-1",
            roomId: "room-team",
            label: "Team",
          },
          explicit: true,
          enrolledByUserId: "viewer-1",
          canUnbind: false,
        },
      );
      act(() =>
        servingStore.publish(
          readHostServingDecision((hostId) => hostById.get(hostId) ?? null),
        ),
      );
      await waitFor(() => expect(guideRequests).toBe(2));
      await waitFor(() => expect(skillsRequests).toBe(2));
      expect(requests).toBe(1);
      expect(taskListRequests).toBe(1);
      expect(
        messenger.calls
          .filter((call) => call.method === "autoPolicy.get")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
      expect(
        messenger.calls
          .filter(
            (call) => call.method === "environment.configuration.guide.get",
          )
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool", "team-computer"]);
      expect(
        messenger.calls
          .filter(
            (call) => call.method === "environment.configuration.skills.list",
          )
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool", "team-computer"]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[2] === "autoPolicy.get")
          .map((query) => query.queryKey[1]),
      ).toEqual(["pool"]);

      act(() =>
        servingStore.publish({
          servingPeer: mockRemoteHostEntry,
          servingPeerMethods: null,
          servingPeerEnvironmentId: null,
        }),
      );
      expect(guideRequests).toBe(2);
      expect(requests).toBe(1);
      expect(taskListRequests).toBe(1);

      act(() =>
        servingStore.publish({
          servingPeer: mockRemoteHostEntry,
          servingPeerMethods: new Set(["autoPolicy.get"]),
          servingPeerEnvironmentId: null,
        }),
      );
      await waitFor(() => expect(requests).toBe(2));
      expect(
        messenger.calls
          .filter((call) => call.method === "autoPolicy.get")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool", mockRemoteHostEntry.hostId]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[2] === "autoPolicy.get")
          .map((query) => query.queryKey[1])
          .sort(),
      ).toEqual(["mock-remote", "pool"]);

      act(() =>
        servingStore.publish({
          servingPeer: mockRemoteHostEntry,
          servingPeerMethods: new Set(["autoPolicy.get"]),
          servingPeerEnvironmentId: null,
        }),
      );
      expect(requests).toBe(2);

      useSelectionAuthorityStore.setState({
        effectiveHostId: teamPeer.hostId,
        servingPeer: { kind: "computer", hostId: teamPeer.hostId },
      });
      act(() =>
        servingStore.publish(
          readHostServingDecision((hostId) => hostById.get(hostId) ?? null),
        ),
      );
      expect(taskListRequests).toBe(1);
      await act(async () => {
        await rendered.result.current.tasks.query.refetch();
      });
      await waitFor(() => {
        expect(
          rendered.result.current.tasks.tasks.map(
            (task) => task.epic?.light?.id,
          ),
        ).toContain("team-local-task");
      });
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.listTasks")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool", "pool"]);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.localHistory.read")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual([teamPeer.hostId, teamPeer.hostId]);
    } finally {
      rendered.unmount();
      client.dispose();
      queryClient.clear();
    }
  });

  it("keeps a late pool page in the pool replica after History moves to a computer", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    let requestId = 0;
    let listTaskRequests = 0;
    const poolPage = Promise.withResolvers<ListTasksResponse>();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `history-peer-${++requestId}`,
      handlers: {
        "epic.listTasks": () => {
          listTaskRequests += 1;
          return listTaskRequests === 1
            ? poolPage.promise
            : { tasks: [taskLight("computer-page", null)], hasMore: false };
        },
        "epic.localHistory.read": () => ({
          complete: true,
          willComplete: true,
          localHomeRows: [],
          preservedRows: [],
          tombstonedEpicIds: [],
          localRows: "present",
        }),
      },
    });
    const hostById = new Map<string, HostDirectoryEntry>([
      [poolEntry.hostId, poolEntry],
      [mockRemoteHostEntry.hostId, mockRemoteHostEntry],
    ]);
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => hostById.get(hostId) ?? null,
      messenger,
      routing: {
        plan,
        selectedHostId: () => mockRemoteHostEntry.hostId,
        serving: () => servingStore.get(),
      },
    });
    clientRef.current = client;
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "test",
        identity: {
          userId: "viewer-1",
          username: "Viewer",
          providerHandle: "viewer",
        },
      }),
    );
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "viewer-1", userName: "Viewer", email: "viewer@example.com" },
        { userId: "viewer-1", username: "Viewer" },
        [],
      );
    await viewReplicaStore.warm("viewer-1");
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const poolRequester = client.createRequesterForHostId(POOL_HOST_ID);
    const rendered = renderHook(
      () => ({
        app: useCloudEpicTasksQuery(undefined, { enabled: true }),
        heldPool: useCloudEpicTasksQueryForClient(poolRequester, undefined, {
          enabled: true,
        }),
      }),
      { wrapper: Wrapper },
    );

    try {
      await waitFor(() => {
        expect(
          messenger.calls.filter(
            (call) =>
              call.method === "epic.listTasks" &&
              call.authority.endpoint.hostId === POOL_HOST_ID,
          ),
        ).toHaveLength(1);
      });

      recordNegotiatedHostMethods(mockRemoteHostEntry.hostId, [
        ...accountWideManifestFixtures().current,
      ]);
      useSelectionAuthorityStore.setState({
        effectiveHostId: mockRemoteHostEntry.hostId,
        servingPeer: { kind: "computer", hostId: mockRemoteHostEntry.hostId },
      });
      act(() =>
        servingStore.publish(
          readHostServingDecision((hostId) => hostById.get(hostId) ?? null),
        ),
      );
      expect(plan.pool?.hostId).toBe(poolEntry.hostId);

      await waitFor(() => {
        expect(
          messenger.calls.some(
            (call) =>
              call.method === "epic.listTasks" &&
              call.authority.endpoint.hostId === mockRemoteHostEntry.hostId,
          ),
        ).toBe(true);
        expect(
          rendered.result.current.app.tasks.map((task) => task.epic?.light?.id),
        ).toContain("computer-page");
      });

      const poolAddress = {
        accountId: "viewer-1",
        service: "epic.listTasks",
        servingTier: POOL_HOST_ID,
        requestScope: viewReplicaRequestScope(LIST_CLOUD_TASKS_REQUEST),
      };
      const computerAddress = {
        ...poolAddress,
        servingTier: mockRemoteHostEntry.hostId,
      };
      await act(async () => {
        poolPage.resolve({
          tasks: [taskLight("late-pool-page", null)],
          hasMore: false,
        });
        await poolPage.promise;
      });
      await waitFor(() => {
        expect(
          rendered.result.current.heldPool.tasks.map(
            (task) => task.epic?.light?.id,
          ),
        ).toContain("late-pool-page");
      });

      expect(
        viewReplicaStore
          .read(historyReplicaService, computerAddress)
          ?.page.tasks.map((task) => task.epic?.light?.id),
      ).toEqual(["computer-page"]);
      expect(
        viewReplicaStore
          .read(historyReplicaService, poolAddress)
          ?.page.tasks.map((task) => task.epic?.light?.id),
      ).toContain("late-pool-page");
    } finally {
      rendered.unmount();
      client.dispose();
      queryClient.clear();
      await viewReplicaStore.evict({ kind: "identity-retired" });
    }
  });
});
