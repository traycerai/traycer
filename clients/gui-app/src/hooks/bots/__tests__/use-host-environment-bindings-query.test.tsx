import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import {
  POOL_HOST_ID,
  poolHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  createHostRpcTierPlan,
  type HostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

const HOST_ID = "host-a";
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
const connectable = vi.hoisted(() => ({
  hostIds: [] as string[],
  resolved: true,
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({
    hostIds: connectable.hostIds,
    resolved: connectable.resolved,
  }),
}));
// The tier plan is settled once per process. This file's other rows assume
// no pool, so only the pool row substitutes a plan, and only for its reads.
const tierPlan = vi.hoisted(() => ({
  current: null as HostRpcTierPlan | null,
}));
vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () =>
        tierPlan.current ?? actual.readProcessHostRpcTierPlan(),
    };
  },
);
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer",
}));
const redialRemoteSessionsFor = vi.hoisted(() => vi.fn());
vi.mock(
  "@traycer-clients/shared/host-transport/remote/active-remote-sessions",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-transport/remote/active-remote-sessions")
    >()),
    redialRemoteSessionsFor,
  }),
);

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
  connectable.hostIds = [];
  connectable.resolved = true;
  tierPlan.current = null;
  redialRemoteSessionsFor.mockReset();
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

  it("redials a host whose status read failed before reading its status again", async () => {
    let statusCalls = 0;
    let statusCallsAtRedial: number | null = null;
    redialRemoteSessionsFor.mockImplementation(() => {
      statusCallsAtRedial = statusCalls;
    });
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => {
          statusCalls += 1;
          if (statusCalls === 1) return Promise.reject(new Error("offline"));
          return environmentStatusFixture({ principal: { kind: "personal" } });
        },
        "environment.host.read": () => ({
          ...BINDING,
          sharingGeneration: null,
        }),
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
    expect(redialRemoteSessionsFor).not.toHaveBeenCalled();

    result.current.retryFailed();

    expect(redialRemoteSessionsFor.mock.calls).toEqual([
      [HOST_ID, "user-retry"],
    ]);
    expect(statusCallsAtRedial).toBe(1);
    await waitFor(() => {
      expect(statusCalls).toBe(2);
    });
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

  it("redials the pool, not the subject, when the pool's binding read fails", async () => {
    const pool = poolHostDirectoryEntry("wss://pool.test/rpc");
    if (pool === null) throw new Error("expected a pool entry");
    tierPlan.current = createHostRpcTierPlan(pool);
    connectable.hostIds = [HOST_ID];
    let bindingReads = 0;
    const { spine, hosts } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
        "environment.binding.read": () => {
          bindingReads += 1;
          return Promise.reject(
            new RetryableTransportError({
              replaySafetyFromKey: false,
              code: "RPC_ERROR",
              message: "The relay did not answer.",
              requestId: "req-pool",
              method: "environment.binding.read",
              fatalDetails: null,
            }),
          );
        },
      },
    });
    hosts.set(pool.hostId, pool);
    runtime.client = spine;
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
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
      expect(bindingReads).toBeGreaterThan(0);
      expect(result.current.failedHostIds).toEqual([HOST_ID]);
    });
    expect(result.current.ownSettingsHostIds).toEqual([]);
    expect(redialRemoteSessionsFor).not.toHaveBeenCalled();

    result.current.retryFailed();

    expect(redialRemoteSessionsFor.mock.calls).toEqual([
      [POOL_HOST_ID, "user-retry"],
    ]);
  });
});
