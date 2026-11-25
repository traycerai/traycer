import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryFunctionContext,
} from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  useHostQuery,
  useHostQueryEntryHash,
} from "@/hooks/host/use-host-query";
import type { HostServingDecision } from "@traycer-clients/shared/host-client/host-rpc-routing";

const servingDecision = vi.hoisted(() => {
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
    publish: (next: HostServingDecision) => {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
});

vi.mock("@/lib/host/app-serving-decision", async (importOriginal) => {
  const react = await import("react");
  const routing =
    await import("@traycer-clients/shared/host-client/host-rpc-routing");
  const actual =
    await importOriginal<typeof import("@/lib/host/app-serving-decision")>();
  return {
    ...actual,
    useAppServingDecision: () =>
      react.useSyncExternalStore(
        servingDecision.subscribe,
        servingDecision.get,
        servingDecision.get,
      ),
    readServingTierHostId: (
      method: string,
      callerHostId: string | null,
      _selectedHostId: string | null,
      params: unknown,
    ) =>
      routing.hostRpcServingTierHostId(
        method,
        callerHostId,
        routing.readProcessHostRpcTierPlan(),
        null,
        servingDecision.get(),
        routing.callEnvironmentIdOf(params),
      ),
  };
});

const personalHost = {
  ...mockRemoteHostEntry,
  hostId: "stale-query-personal",
  owner: { kind: "user" as const, id: "viewer-1" },
};

function wrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  resetNegotiatedManifests();
  settleProcessHostRpcTierPlan(poolEntry);
  servingDecision.publish({
    servingPeer: null,
    servingPeerMethods: null,
    servingPeerEnvironmentId: null,
  });
});

afterEach(() => {
  cleanup();
  servingDecision.publish({
    servingPeer: null,
    servingPeerMethods: null,
    servingPeerEnvironmentId: null,
  });
  resetNegotiatedManifests();
});

it("refuses a retained pool query callback after its answerer moves to a computer", async () => {
  const plan = settleProcessHostRpcTierPlan(poolEntry);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => "stale-answer-request",
    handlers: {
      "organization.refresh": () => ({
        catalog: [],
        groups: { version: "0", groups: [], memberships: [] },
        appearances: [],
        taskLabels: {},
        ready: true,
        authenticationRequired: false,
        pending: [],
        failures: [],
      }),
    },
  });
  recordNegotiatedHostMethods(poolEntry.hostId, ["organization.refresh"]);
  recordNegotiatedHostMethods(personalHost.hostId, ["organization.refresh"]);
  const hosts = new Map<string, HostDirectoryEntry>([
    [poolEntry.hostId, poolEntry],
    [personalHost.hostId, personalHost],
  ]);
  const client = new HostClient({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => hosts.get(hostId) ?? null,
    routing: {
      plan,
      selectedHostId: () => personalHost.hostId,
      serving: () => servingDecision.get(),
    },
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "viewer-token",
      identity: {
        userId: "viewer-1",
        username: "Viewer",
        providerHandle: "viewer",
      },
    }),
  );
  const poolRequester = client.createRequesterForHostId(poolEntry.hostId);
  const rendered = renderHook(
    () => {
      const args = {
        cacheKeyIdentity: ["viewer-1"],
        client: poolRequester,
        method: "organization.refresh" as const,
        params: { taskIds: [] },
        options: { enabled: true, staleTime: Infinity },
      };
      const query = useHostQuery(args);
      const entryHash = useHostQueryEntryHash(args);
      return { query, entryHash };
    },
    { wrapper: wrapper(queryClient) },
  );

  try {
    await waitFor(() => expect(messenger.calls).toHaveLength(1));
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(
      poolEntry.hostId,
    );
    const poolHash = rendered.result.current.entryHash;
    expect(poolHash).toContain(poolEntry.hostId);
    const previousPoolQuery = queryClient.getQueryCache().get(poolHash);
    if (previousPoolQuery === undefined)
      throw new Error("pool query entry missing");
    const retainedCallback = previousPoolQuery.options.queryFn;
    if (typeof retainedCallback !== "function")
      throw new Error("pool query callback missing");

    act(() => {
      servingDecision.publish({
        servingPeer: personalHost,
        servingPeerMethods: new Set(["organization.refresh"]),
        servingPeerEnvironmentId: null,
      });
    });
    await waitFor(() => {
      expect(rendered.result.current.entryHash).not.toBe(poolHash);
      expect(rendered.result.current.query.isSuccess).toBe(true);
    });
    expect(messenger.calls).toHaveLength(2);
    expect(messenger.calls[1]?.authority.endpoint.hostId).toBe(
      personalHost.hostId,
    );
    await expect(
      retainedCallback({
        client: queryClient,
        queryKey: previousPoolQuery.queryKey,
        signal: new AbortController().signal,
        meta: previousPoolQuery.meta,
      } satisfies QueryFunctionContext),
    ).rejects.toBeDefined();
    expect(messenger.calls).toHaveLength(2);
  } finally {
    rendered.unmount();
    client.dispose();
    queryClient.clear();
  }
});
