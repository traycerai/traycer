import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { taskLight } from "@/lib/view-replica/__tests__/replica-fixtures";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { useBotMentionTargets } from "@/components/bots/use-bot-mention-targets";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { __resetCloudEpicTasksClientsForTests } from "@/lib/cloud-epic-tasks-query";

const VIEWER_ID = "viewer-1";
const TAB_HOST_ID = mockLocalHostEntry.hostId;
const ANSWERER_HOST_ID = "personal-answerer";

const fixture = vi.hoisted(() => ({
  hostClient: null as HostClient<HostRpcRegistry> | null,
  tabClient: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => fixture.tabClient,
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () =>
    fixture.hostClient === null ? null : { hostClient: fixture.hostClient },
}));

function wrapper(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  fixture.hostClient?.dispose();
  fixture.hostClient = null;
  fixture.tabClient = null;
  __resetCloudEpicTasksClientsForTests();
  resetNegotiatedManifests();
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("bot mention Home reads", () => {
  it("uses the negotiated list answerer even when the bot tab is bound to another host", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const tabEntry: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: TAB_HOST_ID,
    };
    const answererEntry: HostDirectoryEntry = {
      ...mockRemoteHostEntry,
      hostId: ANSWERER_HOST_ID,
      owner: { kind: "user", id: VIEWER_ID },
    };
    const hosts = new Map<string, HostDirectoryEntry>([
      [POOL_HOST_ID, poolEntry],
      [TAB_HOST_ID, tabEntry],
      [ANSWERER_HOST_ID, answererEntry],
    ]);
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "bot-mention-list-read",
      handlers: {
        "epic.listTasks": () => ({
          tasks: [
            {
              ...taskLight("answerer-home-task", null),
              ownerEnvironmentId: "team-environment",
            },
          ],
          hasMore: false,
        }),
      },
    });
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => hosts.get(hostId) ?? null,
      messenger,
      routing: {
        plan,
        selectedHostId: () => TAB_HOST_ID,
        serving: () =>
          readHostServingDecision((hostId) => hosts.get(hostId) ?? null),
      },
    });
    fixture.hostClient = client;
    fixture.tabClient = client.createRequesterForHostId(TAB_HOST_ID);
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "test-token",
        identity: {
          userId: VIEWER_ID,
          username: VIEWER_ID,
          providerHandle: null,
        },
      }),
    );
    recordNegotiatedHostManifest(ANSWERER_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 5 },
    });
    useSelectionAuthorityStore.setState({
      effectiveHostId: ANSWERER_HOST_ID,
      servingPeer: { kind: "computer", hostId: ANSWERER_HOST_ID },
    });
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: VIEWER_ID, userName: VIEWER_ID, email: "viewer@example.com" },
        { userId: VIEWER_ID, username: VIEWER_ID },
        [],
      );
    const rendered = renderHook(
      () =>
        useBotMentionTargets({
          environmentId: "team-environment",
          tasks: [],
          personal: false,
        }),
      { wrapper: wrapper(queryClient) },
    );

    try {
      await waitFor(() => {
        expect(rendered.result.current.tasks).toEqual([
          { id: "answerer-home-task", name: "answerer-home-task" },
        ]);
        expect(rendered.result.current.tasksAnswered).toBe(true);
      });
      expect(TAB_HOST_ID).not.toBe(ANSWERER_HOST_ID);
      expect(
        messenger.calls
          .filter((call) => call.method === "epic.listTasks")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual([ANSWERER_HOST_ID]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[2] === "cloud.listTasks")
          .map((query) => query.queryKey[1]),
      ).toEqual([ANSWERER_HOST_ID]);
    } finally {
      rendered.unmount();
      queryClient.clear();
    }
  });
});
