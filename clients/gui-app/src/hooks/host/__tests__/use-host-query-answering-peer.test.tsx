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
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { accountWideManifestFixtures } from "@traycer-clients/shared/test-fixtures/account-wide-manifest";
import { viewReplicaRequestScope } from "@traycer-clients/shared/view-replica/identity";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import { taskLight } from "@/lib/view-replica/__tests__/replica-fixtures";
import {
  getNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { useAppServingDecision } from "@/lib/host/app-serving-decision";
import { queryClient as appQueryClient } from "@/lib/query-client";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  useCloudEpicTasksQuery,
  useCloudEpicTasksQueryForClient,
} from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { historyReplicaService } from "@/lib/view-replica/history-replica";
import { viewReplicaStore } from "@/lib/view-replica/view-replica-store";
import { HistoryLocalContributionMount } from "@/providers/history-local-contribution-mount";
import { __resetHistoryContributionsForTests } from "@/lib/history-composition/history-local-contribution";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useAutoPolicyQuery } from "@/hooks/auto-mode/use-auto-policy-query";
import { useConfigurationGuideQuery } from "@/hooks/environment/team/use-guide-query";
import { useConfigurationReadClient } from "@/hooks/environment/team/use-configuration-read-client";
import { useEnvironmentSkillsQuery } from "@/hooks/environment/team/use-environment-skills";

const clientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));
const runtimeBindingRef = vi.hoisted(() => ({
  current: null as HostRuntimeBinding<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    getHostBindingSnapshot: () => runtimeBindingRef.current,
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

vi.mock("@/hooks/environment/team/use-configuration-read-client", () => ({
  useConfigurationReadClient: () =>
    clientRef.current?.createRequesterForHostId(POOL_HOST_ID) ?? null,
}));

vi.mock("@/components/settings/environment/configuration-source", () => ({
  useConfigurationSource: () => ({
    kind: "pool",
    environmentId: "environment-1",
  }),
}));

vi.mock("@/lib/host/cloud-verdict-preflight", () => ({
  cloudVerdictPreflight: () => () => undefined,
}));

const poolEntry = poolHostDirectoryEntry("wss://pool.test/rpc");
if (poolEntry === null) throw new Error("pool fixture must build");

describe("useHostQuery follows the answering peer for account-wide reads", () => {
  afterEach(async () => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    clientRef.current = null;
    runtimeBindingRef.current = null;
    useSelectionAuthorityStore.getState().reset();
    resetNegotiatedManifests();
    appQueryClient.clear();
    __resetHistoryContributionsForTests();
    await viewReplicaStore.evict({ kind: "identity-retired" });
  });

  it("refetches once when a personal manifest arrives and stays on the pool for a team peer", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    let autoPolicyRequests = 0;
    let guideRequests = 0;
    let skillsRequests = 0;
    let titleRequests = 0;
    let taskListRequests = 0;
    let localHistoryRequests = 0;
    let teamContributionReentered = false;
    let requestId = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `answering-peer-${++requestId}`,
      handlers: {
        "autoPolicy.get": () => {
          autoPolicyRequests += 1;
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
        "epic.getChatTitle": () => {
          titleRequests += 1;
          return { chat: { title: "Task title" } };
        },
        "epic.listTasks": () => {
          taskListRequests += 1;
          return {
            tasks: [
              taskLight("pool-task", null),
              taskLight("deleted-pool-task", null),
            ],
            hasMore: false,
          };
        },
        "epic.localHistory.read": () => {
          localHistoryRequests += 1;
          return teamContributionReentered
            ? {
                complete: true,
                willComplete: true,
                localHomeRows: [taskLight("team-reentered-task", null)],
                preservedRows: [],
                tombstonedEpicIds: ["pool-task"],
                localRows: "present",
              }
            : ({
                complete: true,
                willComplete: true,
                localHomeRows: [taskLight("team-local-task", null)],
                preservedRows: [],
                tombstonedEpicIds: ["deleted-pool-task"],
                localRows: "present",
              } satisfies LocalHistoryReadResponse);
        },
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
        serving: () =>
          readHostServingDecision((hostId) => hostById.get(hostId) ?? null),
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
    const binding = Object.assign(Object.create(null), {
      hostClient: client,
    }) as HostRuntimeBinding<HostRpcRegistry>;
    runtimeBindingRef.current = binding;
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <HostRuntimeContext.Provider value={binding}>
        <QueryClientProvider client={queryClient}>
          <HistoryLocalContributionMount />
          {props.children}
        </QueryClientProvider>
      </HostRuntimeContext.Provider>
    );
    const poolRequester = client.createRequesterForHostId(POOL_HOST_ID);
    const rendered = renderHook(
      () => {
        const skillsClient = useConfigurationReadClient();
        return {
          servingDecision: useAppServingDecision(),
          autoPolicy: useAutoPolicyQuery(),
          guide: useConfigurationGuideQuery(),
          skills: useEnvironmentSkillsQuery(skillsClient, true),
          title: useHostQuery({
            cacheKeyIdentity: ["viewer-1"],
            client: poolRequester,
            method: "epic.getChatTitle",
            params: { taskId: "task-1", chatId: "chat-1" },
            options: { enabled: true, staleTime: Infinity },
          }),
          tasks: useCloudEpicTasksQuery(undefined, { enabled: true }),
        };
      },
      { wrapper: Wrapper },
    );

    try {
      await waitFor(() => {
        expect(autoPolicyRequests).toBe(1);
        expect(guideRequests).toBe(1);
        expect(skillsRequests).toBe(1);
        expect(titleRequests).toBe(1);
        expect(taskListRequests).toBe(1);
      });
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.getChatTitle")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.listTasks")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
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
      const teamManifest: ConnectionManifest = Object.fromEntries(
        [...currentManifest].map((method) => [
          method,
          {
            major: 1,
            minor:
              method === "environment.configuration.guide.get" ||
              method === "environment.configuration.skills.list"
                ? 1
                : 0,
          },
        ]),
      );
      act(() => {
        recordNegotiatedHostManifest(teamPeer.hostId, { ...teamManifest });
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
      });
      await waitFor(() => {
        expect(
          rendered.result.current.servingDecision.servingPeer?.hostId,
        ).toBe(teamPeer.hostId);
        expect(rendered.result.current.title.isFetching).toBe(false);
        expect(rendered.result.current.autoPolicy.isFetching).toBe(false);
        expect(rendered.result.current.guide.isFetching).toBe(false);
        expect(rendered.result.current.skills.isFetching).toBe(false);
        expect(rendered.result.current.tasks.query.isFetching).toBe(false);
        expect(guideRequests).toBe(2);
        expect(skillsRequests).toBe(2);
      });
      expect(autoPolicyRequests).toBe(1);
      expect(titleRequests).toBe(1);
      expect(taskListRequests).toBe(1);
      expect(
        messenger.calls
          .filter(
            (call) => call.method === "environment.configuration.guide.get",
          )
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool", teamPeer.hostId]);
      expect(
        messenger.calls
          .filter(
            (call) => call.method === "environment.configuration.skills.list",
          )
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool", teamPeer.hostId]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[2] === "autoPolicy.get")
          .map((query) => query.queryKey[1]),
      ).toEqual(["pool"]);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.getChatTitle")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[2] === "epic.getChatTitle")
          .map((query) => query.queryKey[1]),
      ).toEqual(["pool"]);

      act(() =>
        useSelectionAuthorityStore.setState({
          servingPeer: { kind: "computer", hostId: mockRemoteHostEntry.hostId },
        }),
      );
      await waitFor(() => {
        expect(
          rendered.result.current.servingDecision.servingPeer?.hostId,
        ).toBe(mockRemoteHostEntry.hostId);
        expect(rendered.result.current.title.isFetching).toBe(false);
      });
      expect(titleRequests).toBe(1);
      expect(taskListRequests).toBe(1);

      act(() =>
        recordNegotiatedHostManifest(mockRemoteHostEntry.hostId, {
          "epic.getChatTitle": { major: 1, minor: 0 },
        }),
      );
      await waitFor(() => {
        expect(
          rendered.result.current.servingDecision.servingPeerMethods?.has(
            "epic.getChatTitle",
          ),
        ).toBe(true);
      });
      await waitFor(() => {
        expect(
          queryClient
            .getQueryCache()
            .getAll()
            .filter((query) => query.queryKey[2] === "epic.getChatTitle")
            .map((query) => query.queryKey[1])
            .sort(),
        ).toEqual(["mock-remote", "pool"]);
      });
      await waitFor(() => expect(titleRequests).toBe(2));
      await waitFor(() =>
        expect(rendered.result.current.title.isFetching).toBe(false),
      );
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.getChatTitle")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool", mockRemoteHostEntry.hostId]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[2] === "epic.getChatTitle")
          .map((query) => query.queryKey[1])
          .sort(),
      ).toEqual(["mock-remote", "pool"]);

      act(() =>
        useSelectionAuthorityStore.setState({
          effectiveHostId: mockRemoteHostEntry.hostId,
          servingPeer: { kind: "computer", hostId: mockRemoteHostEntry.hostId },
        }),
      );
      await waitFor(() => {
        expect(
          rendered.result.current.servingDecision.servingPeer?.hostId,
        ).toBe(mockRemoteHostEntry.hostId);
        expect(rendered.result.current.title.isFetching).toBe(false);
      });
      expect(titleRequests).toBe(2);

      act(() =>
        useSelectionAuthorityStore.setState({
          effectiveHostId: teamPeer.hostId,
          servingPeer: { kind: "computer", hostId: teamPeer.hostId },
        }),
      );
      await waitFor(() => {
        expect(
          rendered.result.current.servingDecision.servingPeer?.hostId,
        ).toBe(teamPeer.hostId);
        expect(rendered.result.current.tasks.query.isFetching).toBe(false);
        expect(rendered.result.current.title.isFetching).toBe(false);
      });
      expect(taskListRequests).toBe(1);
      expect(titleRequests).toBe(2);
      await waitFor(() => {
        expect(localHistoryRequests).toBeGreaterThan(0);
        expect(
          rendered.result.current.tasks.tasks
            .map((task) => task.epic?.light?.id)
            .sort(),
        ).toEqual(["pool-task", "team-local-task"]);
      });
      expect(taskListRequests).toBe(1);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.listTasks")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual(["pool"]);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.localHistory.read")
          .map((call) => call.authority.endpoint.hostId)
          .sort(),
      ).toEqual(
        [teamPeer.hostId, teamPeer.hostId, mockRemoteHostEntry.hostId].sort(),
      );

      act(() =>
        useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } }),
      );
      await waitFor(() => {
        expect(rendered.result.current.servingDecision.servingPeer).toEqual(
          poolEntry,
        );
        expect(
          rendered.result.current.tasks.tasks
            .map((task) => task.epic?.light?.id)
            .sort(),
        ).toEqual(["deleted-pool-task", "pool-task"]);
      });
      expect(taskListRequests).toBe(1);
      expect(localHistoryRequests).toBe(3);

      teamContributionReentered = true;
      act(() =>
        useSelectionAuthorityStore.setState({
          effectiveHostId: teamPeer.hostId,
          servingPeer: { kind: "computer", hostId: teamPeer.hostId },
        }),
      );
      await waitFor(() => expect(localHistoryRequests).toBe(4));
      await waitFor(() => {
        expect(
          rendered.result.current.tasks.tasks
            .map((task) => task.epic?.light?.id)
            .sort(),
        ).toEqual(["deleted-pool-task", "team-reentered-task"]);
      });
      expect(taskListRequests).toBe(1);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.listTasks")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual([POOL_HOST_ID]);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.localHistory.read")
          .map((call) => call.authority.endpoint.hostId)
          .sort(),
      ).toEqual(
        [
          mockRemoteHostEntry.hostId,
          teamPeer.hostId,
          teamPeer.hostId,
          teamPeer.hostId,
        ].sort(),
      );
    } finally {
      rendered.unmount();
      client.dispose();
      queryClient.clear();
    }
  });

  it("drops a departed computer's row from the unavailable pool fallback", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    let taskListRequests = 0;
    let localHistoryRequests = 0;
    let requestId = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `departed-local-${++requestId}`,
      handlers: {
        "epic.listTasks": () => {
          taskListRequests += 1;
          throw new Error("pool task listing is unavailable");
        },
        "epic.localHistory.read": () => {
          localHistoryRequests += 1;
          return {
            complete: true,
            willComplete: true,
            localHomeRows: [taskLight("personal-local-task", null)],
            preservedRows: [],
            tombstonedEpicIds: [],
            localRows: "present",
          } satisfies LocalHistoryReadResponse;
        },
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
        serving: () =>
          readHostServingDecision((hostId) => hostById.get(hostId) ?? null),
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
    act(() => {
      recordNegotiatedHostManifest(mockRemoteHostEntry.hostId, {
        "epic.localHistory.read": { major: 1, minor: 0 },
      });
      useSelectionAuthorityStore.setState({
        effectiveHostId: mockRemoteHostEntry.hostId,
        servingPeer: { kind: "computer", hostId: mockRemoteHostEntry.hostId },
      });
    });
    const binding = Object.assign(Object.create(null), {
      hostClient: client,
    }) as HostRuntimeBinding<HostRpcRegistry>;
    runtimeBindingRef.current = binding;
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <HostRuntimeContext.Provider value={binding}>
        <QueryClientProvider client={queryClient}>
          <HistoryLocalContributionMount />
          {props.children}
        </QueryClientProvider>
      </HostRuntimeContext.Provider>
    );
    const rendered = renderHook(
      () => useCloudEpicTasksQuery(undefined, { enabled: true }),
      { wrapper: Wrapper },
    );

    try {
      await waitFor(() => {
        expect(rendered.result.current.hostId).toBe(POOL_HOST_ID);
        expect(
          rendered.result.current.tasks.map((task) => task.epic?.light?.id),
        ).toEqual(["personal-local-task"]);
        expect(rendered.result.current.completeness?.cloudPage).toBe(
          "unavailable",
        );
        expect(localHistoryRequests).toBeGreaterThan(0);
      });
      expect(
        getNegotiatedHostMethods(mockRemoteHostEntry.hostId)?.has(
          "epic.listTasks",
        ),
      ).toBe(false);
      expect(taskListRequests).toBe(1);
      const poolQueryKey = cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        "viewer-1",
        LIST_CLOUD_TASKS_REQUEST,
      );
      const poolQuery = queryClient.getQueryCache().find({
        queryKey: poolQueryKey,
        exact: true,
      });
      expect(poolQuery).toBeDefined();
      const rawPoolPage =
        queryClient.getQueryData<ListTasksResponse>(poolQueryKey);
      expect(rawPoolPage?.tasks).toEqual([]);
      expect(rawPoolPage?.completeness?.cloudPage).toBe("unavailable");

      act(() =>
        useSelectionAuthorityStore.setState({
          effectiveHostId: null,
          servingPeer: { kind: "pool" },
        }),
      );
      await waitFor(() => {
        expect(rendered.result.current.hostId).toBe(POOL_HOST_ID);
        expect(rendered.result.current.completeness?.cloudPage).toBe(
          "unavailable",
        );
        expect(rendered.result.current.tasks).toEqual([]);
      });
      expect(taskListRequests).toBe(1);
      expect(
        queryClient.getQueryCache().find({
          queryKey: poolQueryKey,
          exact: true,
        }),
      ).toBe(poolQuery);
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
        serving: () =>
          readHostServingDecision((hostId) => hostById.get(hostId) ?? null),
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
    const binding = Object.assign(Object.create(null), {
      hostClient: client,
    }) as HostRuntimeBinding<HostRpcRegistry>;
    runtimeBindingRef.current = binding;
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <HostRuntimeContext.Provider value={binding}>
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      </HostRuntimeContext.Provider>
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

      act(() => {
        recordNegotiatedHostMethods(mockRemoteHostEntry.hostId, [
          ...accountWideManifestFixtures().current,
        ]);
        useSelectionAuthorityStore.setState({
          effectiveHostId: mockRemoteHostEntry.hostId,
          servingPeer: { kind: "computer", hostId: mockRemoteHostEntry.hostId },
        });
      });
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

      await waitFor(() => {
        expect(
          viewReplicaStore
            .read(historyReplicaService, computerAddress)
            ?.page.tasks.map((task) => task.epic?.light?.id),
        ).toEqual(["computer-page"]);
      });
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
