import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  poolHostDirectoryEntry,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  settleProcessHostRpcTierPlan,
  type HostServingDecision,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { accountWideManifestFixtures } from "@traycer-clients/shared/test-fixtures/account-wide-manifest";
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
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useAuthStore } from "@/stores/auth/auth-store";

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
  afterEach(() => {
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
          return { tasks: [], hasMore: false };
        },
        "epic.localHistory.read": () => ({
          complete: true,
          willComplete: true,
          localHomeRows: [],
          preservedRows: [],
          tombstonedEpicIds: [],
          localRows: "none",
        }),
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
    } finally {
      rendered.unmount();
      client.dispose();
      queryClient.clear();
    }
  });
});
