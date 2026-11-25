import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  settleProcessHostRpcTierPlan,
  type HostServingDecision,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { AutoPolicySetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { hostRpcRegistry } from "@traycer/protocol/host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostQueryKeys } from "@/lib/query-keys";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { useAutoPolicySetMutation } from "@/hooks/auto-mode/use-auto-policy-set-mutation";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";

const hostClientRef = vi.hoisted(() => ({
  current: null as HostClient<typeof hostRpcRegistry> | null,
}));
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

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (hostClientRef.current === null)
        throw new Error("Auto Policy host client fixture is not installed");
      return hostClientRef.current;
    },
    useHostBinding: () => null,
  };
});

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return { ...actual, useCloudChatViewerId: () => "policy-viewer" };
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

const hostA = {
  ...mockRemoteHostEntry,
  hostId: "policy-reader-a",
  owner: { kind: "user" as const, id: "policy-viewer" },
};
const hostB = {
  ...mockRemoteHostEntry,
  hostId: "policy-reader-b",
  owner: { kind: "user" as const, id: "policy-viewer" },
};
const VIEWER_ID = "policy-viewer";
const operation: EnvironmentCloud = {
  authnBaseUrl: "",
  bearer: { kind: "cloud", getBearerToken: () => null },
  transport: () => Promise.reject(new Error("not sent")),
  onOriginSignIn: () => true,
};

function wrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  hostClientRef.current?.dispose();
  hostClientRef.current = null;
  servingDecision.publish({
    servingPeer: null,
    servingPeerMethods: null,
    servingPeerEnvironmentId: null,
  });
  resetNegotiatedManifests();
});

it("writes through to the get peer captured at mutation start and invalidates the moved reader", async () => {
  const plan = settleProcessHostRpcTierPlan(poolEntry);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const write = Promise.withResolvers<AutoPolicySetResponse>();
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => "auto-policy-moved-answer-request",
    handlers: {
      "autoPolicy.set": () => write.promise,
    },
  });
  const methods = ["autoPolicy.get", "autoPolicy.set"] as const;
  recordNegotiatedHostMethods(hostA.hostId, [...methods]);
  recordNegotiatedHostMethods(hostB.hostId, [...methods]);
  const hosts = new Map<string, HostDirectoryEntry>([
    [poolEntry.hostId, poolEntry],
    [hostA.hostId, hostA],
    [hostB.hostId, hostB],
  ]);
  const client = new HostClient({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => hosts.get(hostId) ?? null,
    routing: {
      plan,
      selectedHostId: () => poolEntry.hostId,
      serving: () => servingDecision.get(),
    },
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "policy-token",
      identity: {
        userId: VIEWER_ID,
        username: "Policy viewer",
        providerHandle: "policy-viewer",
      },
    }),
  );
  hostClientRef.current = client;
  const viewFor = (body: string) => ({
    body,
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "account" as const,
    readState: "fresh" as const,
    shippedDefaults: undefined,
    team: null,
  });
  const keyA = hostQueryKeys.autoPolicyForViewer(hostA.hostId, VIEWER_ID);
  const keyB = hostQueryKeys.autoPolicyForViewer(hostB.hostId, VIEWER_ID);
  queryClient.setQueryData(keyA, viewFor("reader A before save"));
  queryClient.setQueryData(keyB, viewFor("reader B before save"));
  servingDecision.publish({
    servingPeer: poolEntry,
    servingPeerMethods: null,
    servingPeerEnvironmentId: null,
  });

  const rendered = renderHook(() => useAutoPolicySetMutation(), {
    wrapper: wrapper(queryClient),
  });
  try {
    const save = rendered.result.current.mutate;
    act(() => {
      servingDecision.publish({
        servingPeer: hostA,
        servingPeerMethods: new Set(methods),
        servingPeerEnvironmentId: null,
      });
    });
    act(() => {
      save({
        request: { body: "saved policy" },
        operation,
      });
    });
    await waitFor(() => expect(messenger.calls).toHaveLength(1));
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(hostA.hostId);

    servingDecision.publish({
      servingPeer: hostB,
      servingPeerMethods: new Set(methods),
      servingPeerEnvironmentId: null,
    });
    await act(async () => {
      write.resolve({ updatedAt: "2026-01-01T00:01:00.000Z" });
      await write.promise;
    });
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData<{ body: string }>(keyA)?.body).toBe(
      "saved policy",
    );
    expect(queryClient.getQueryData<{ body: string }>(keyB)?.body).toBe(
      "reader B before save",
    );
    expect(queryClient.getQueryState(keyB)?.isInvalidated).toBe(true);
  } finally {
    rendered.unmount();
    queryClient.clear();
  }
});
