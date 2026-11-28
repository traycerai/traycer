import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import {
  hostEnvironmentBindingQueryKey,
  useHostEnvironmentBindings,
} from "@/hooks/bots/use-host-environment-bindings-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const HOST_ID = "host-a";
const SERVING_HOST_ID = "personal-answerer";
const BINDING: EnvironmentHostBinding = {
  hostId: HOST_ID,
  environment: {
    environmentId: "env-personal",
    ownerKind: "user",
    ownerId: "viewer",
    roomId: "room",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};
const runtime: { client: HostClient<HostRpcRegistry> | null } = vi.hoisted(
  () => ({ client: null }),
);

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    runtime.client === null
      ? null
      : { hostClient: runtime.client, hostId: undefined },
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  getHostBindingSnapshot: () =>
    runtime.client === null ? null : { hostClient: runtime.client },
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: [], resolved: true }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer",
}));

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      {props.children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  runtime.client = null;
  resetNegotiatedManifests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useHostEnvironmentBindings retry", () => {
  it("classifies a Local host as own settings without sending environment.host.read", async () => {
    let bindingCalls = 0;
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: null,
            planes: { records: "local", broker: "local", room: "local" },
          }),
        "environment.host.read": () => {
          bindingCalls += 1;
          return { ...BINDING, sharingGeneration: null };
        },
      },
    });
    runtime.client = spine;
    const { result } = renderHook(
      () => useHostEnvironmentBindings([HOST_ID], true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.ownSettingsHostIds).toEqual([HOST_ID]);
    });
    expect(result.current.byHostId.has(HOST_ID)).toBe(false);
    expect(result.current.failedHostIds).toEqual([]);
    expect(bindingCalls).toBe(0);
  });

  it("uses the host binding when answered status is not Local", async () => {
    let bindingCalls = 0;
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
        "environment.host.read": () => {
          bindingCalls += 1;
          return { ...BINDING, sharingGeneration: null };
        },
      },
    });
    runtime.client = spine;
    const { result } = renderHook(
      () => useHostEnvironmentBindings([HOST_ID], true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.byHostId.get(HOST_ID)).toEqual({
        ...BINDING,
        sharingGeneration: null,
      });
    });
    expect(result.current.ownSettingsHostIds).toEqual([]);
    expect(result.current.failedHostIds).toEqual([]);
    expect(bindingCalls).toBe(1);
  });

  it("rechecks status when retrying a failed binding and classifies the host as Local", async () => {
    let statusCalls = 0;
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => {
          statusCalls += 1;
          return statusCalls === 1
            ? environmentStatusFixture({ principal: { kind: "personal" } })
            : environmentStatusFixture({
                principal: null,
                planes: { records: "local", broker: "local", room: "local" },
              });
        },
        "environment.host.read": () =>
          Promise.reject(new Error("binding unavailable")),
      },
    });
    runtime.client = spine;
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
      "environment.host.read": { major: 1, minor: 1 },
    });
    const { result } = renderHook(
      () => useHostEnvironmentBindings([HOST_ID], true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.failedHostIds).toEqual([HOST_ID]);
    });
    expect(statusCalls).toBe(1);

    result.current.retryFailed();

    await waitFor(() => {
      expect(result.current.ownSettingsHostIds).toEqual([HOST_ID]);
      expect(result.current.failedHostIds).toEqual([]);
    });
    expect(statusCalls).toBe(2);
  });

  it("retries a failed status and classifies the host as Local without reading its binding", async () => {
    let statusCalls = 0;
    let bindingCalls = 0;
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => {
          statusCalls += 1;
          if (statusCalls === 1) return Promise.reject(new Error("offline"));
          return environmentStatusFixture({
            principal: null,
            planes: { records: "local", broker: "local", room: "local" },
          });
        },
        "environment.host.read": () => {
          bindingCalls += 1;
          return Promise.reject(new Error("Local hosts refuse this read"));
        },
      },
    });
    runtime.client = spine;
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
      "environment.host.read": { major: 1, minor: 1 },
    });
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer", username: "viewer" },
    });
    const { result } = renderHook(
      () => useHostEnvironmentBindings([HOST_ID], true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.failedHostIds).toEqual([HOST_ID]);
    });
    expect(result.current.ownSettingsHostIds).toEqual([]);
    expect(bindingCalls).toBe(0);

    result.current.retryFailed();

    await waitFor(() => {
      expect(result.current.ownSettingsHostIds).toEqual([HOST_ID]);
      expect(result.current.failedHostIds).toEqual([]);
    });
    expect(statusCalls).toBe(2);
    expect(bindingCalls).toBe(0);
  });

  it("keeps a failed host failed until status answers non-Local, then reads its binding", async () => {
    let statusCalls = 0;
    let bindingCalls = 0;
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => {
          statusCalls += 1;
          if (statusCalls === 1) {
            return Promise.reject(new Error("status unavailable"));
          }
          if (statusCalls === 2)
            return Promise.reject(new Error("status still unavailable"));
          return environmentStatusFixture({
            principal: { kind: "personal" },
          });
        },
        "environment.host.read": () => {
          bindingCalls += 1;
          return { ...BINDING, sharingGeneration: null };
        },
      },
    });
    runtime.client = spine;
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
      "environment.host.read": { major: 1, minor: 1 },
    });
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer", username: "viewer" },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const queryWrapper = (props: {
      readonly children: ReactNode;
    }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => useHostEnvironmentBindings([HOST_ID], true),
      { wrapper: queryWrapper },
    );

    await waitFor(() => {
      expect(result.current.failedHostIds).toEqual([HOST_ID]);
    });
    expect(result.current.ownSettingsHostIds).toEqual([]);
    expect(bindingCalls).toBe(0);

    result.current.retryFailed();

    await waitFor(() => {
      expect(statusCalls).toBe(2);
      expect(result.current.failedHostIds).toEqual([HOST_ID]);
    });
    expect(bindingCalls).toBe(0);

    result.current.retryFailed();

    await waitFor(() => {
      expect(result.current.byHostId.get(HOST_ID)).toEqual({
        ...BINDING,
        sharingGeneration: null,
      });
      expect(result.current.failedHostIds).toEqual([]);
    });
    expect(statusCalls).toBe(3);
    expect(bindingCalls).toBe(1);
  });
});

describe("useHostEnvironmentBindings with a personal serving answerer", () => {
  it("sends the multi-host binding read to the answerer and keys its result there", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const targetEntry: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: HOST_ID,
    };
    const servingEntry: HostDirectoryEntry = {
      ...mockRemoteHostEntry,
      hostId: SERVING_HOST_ID,
      owner: { kind: "user", id: "viewer" },
    };
    const hosts = new Map<string, HostDirectoryEntry>([
      [POOL_HOST_ID, poolEntry],
      [HOST_ID, targetEntry],
      [SERVING_HOST_ID, servingEntry],
    ]);
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "multi-host-binding-read",
      handlers: {
        "environment.binding.read": () => BINDING,
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
        selectedHostId: () => null,
        serving: () =>
          readHostServingDecision((hostId) => hosts.get(hostId) ?? null),
      },
    });
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "test" }),
    );
    recordNegotiatedHostManifest(SERVING_HOST_ID, {
      "environment.binding.read": { major: 1, minor: 0 },
    });
    useSelectionAuthorityStore.setState({
      effectiveHostId: SERVING_HOST_ID,
      servingPeer: { kind: "computer", hostId: SERVING_HOST_ID },
    });
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer", username: "viewer" },
    });
    runtime.client = client;
    const queryWrapper = (props: {
      readonly children: ReactNode;
    }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    try {
      const { result } = renderHook(
        () => useHostEnvironmentBindings([HOST_ID], true),
        { wrapper: queryWrapper },
      );

      await waitFor(() => {
        expect(result.current.byHostId.get(HOST_ID)).toEqual(BINDING);
      });
      expect(
        messenger.calls
          .filter((call) => call.method === "environment.binding.read")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual([SERVING_HOST_ID]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[2] === "environment.binding.read")
          .map((query) => query.queryKey),
      ).toEqual([
        [
          "host",
          SERVING_HOST_ID,
          "environment.binding.read",
          { hostId: HOST_ID },
          "viewer",
        ],
      ]);
      expect(hostEnvironmentBindingQueryKey(HOST_ID, "viewer")).toEqual([
        "host",
        SERVING_HOST_ID,
        "environment.binding.read",
        { hostId: HOST_ID },
        "viewer",
      ]);
    } finally {
      client.dispose();
      queryClient.clear();
    }
  });
});
