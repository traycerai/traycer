import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import {
  POOL_HOST_ID,
  poolHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import {
  hostEnvironmentBindingQueryKey,
  useHostEnvironmentBindings,
} from "@/hooks/bots/use-host-environment-bindings-query";
import { useAuthStore } from "@/stores/auth/auth-store";

const VIEWER = "user-1";
const TARGET_HOST = "host-9";
const POOL_ENTRY = poolHostDirectoryEntry("wss://pool.test/rpc");

const bindingRef = vi.hoisted(() => ({
  current: null as {
    hostClient: HostClient<HostRpcRegistry>;
    hostId: undefined;
  } | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => bindingRef.current,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: VIEWER,
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

const BINDING: EnvironmentHostBinding = {
  hostId: TARGET_HOST,
  environment: {
    environmentId: "env-personal",
    ownerKind: "user",
    ownerId: VIEWER,
    roomId: "room",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

function signInAs(status: "signed-in" | "unverified"): void {
  useAuthStore.setState({
    status,
    contextMetadata: { userId: VIEWER, username: VIEWER },
  });
}

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const reads: string[] = [];
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      return hostId === POOL_HOST_ID ? POOL_ENTRY : null;
    },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req",
      handlers: {
        "environment.binding.read": (params) => {
          reads.push(params.hostId);
          return BINDING;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      identity: { userId: VIEWER, username: VIEWER, providerHandle: null },
      origin: "renderer",
    }),
  );
  bindingRef.current = { hostClient: spine, hostId: undefined };
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    queryClient,
    reads,
    wrapper,
    client: spine.createRequester(mockLocalHostEntry),
  };
}

describe("environment.binding.read in a pool build", () => {
  beforeEach(() => {
    settleProcessHostRpcTierPlan(POOL_ENTRY);
  });

  afterEach(() => {
    cleanup();
    bindingRef.current = null;
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("is never dispatched by useHostEnvironmentBindings while the session lacks a verdict, and is once authorized", async () => {
    signInAs("unverified");
    const fixture = mount();
    const rendered = renderHook(
      () => useHostEnvironmentBindings([TARGET_HOST], true),
      { wrapper: fixture.wrapper },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.reads).toEqual([]);

    act(() => {
      signInAs("signed-in");
    });
    await waitFor(() => {
      expect(rendered.result.current.byHostId.get(TARGET_HOST)).toEqual(
        BINDING,
      );
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("refuses a refetch of that read once the verdict is gone, without dispatching", async () => {
    signInAs("signed-in");
    const fixture = mount();
    renderHook(() => useHostEnvironmentBindings([TARGET_HOST], true), {
      wrapper: fixture.wrapper,
    });
    await waitFor(() => {
      expect(fixture.reads).toEqual([TARGET_HOST]);
    });

    act(() => {
      signInAs("unverified");
    });
    const query = fixture.queryClient.getQueryCache().find({
      queryKey: hostEnvironmentBindingQueryKey(TARGET_HOST, VIEWER),
    });
    const refused: unknown = await query?.fetch().then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : "").toContain(
      "no longer holds a cloud verdict",
    );
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("is never dispatched by useEnvironmentHostReadQuery while the session lacks a verdict, and is once authorized", async () => {
    signInAs("unverified");
    const fixture = mount();
    const rendered = renderHook(
      () => useEnvironmentHostReadQuery(fixture.client, TARGET_HOST, true),
      { wrapper: fixture.wrapper },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.reads).toEqual([]);

    act(() => {
      signInAs("signed-in");
    });
    await waitFor(() => {
      expect(rendered.result.current.data).toEqual(BINDING);
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("refuses a refetch of useEnvironmentHostReadQuery once the verdict is gone, without dispatching", async () => {
    signInAs("signed-in");
    const fixture = mount();
    const rendered = renderHook(
      () => useEnvironmentHostReadQuery(fixture.client, TARGET_HOST, true),
      { wrapper: fixture.wrapper },
    );
    await waitFor(() => {
      expect(rendered.result.current.data).toEqual(BINDING);
    });

    act(() => {
      signInAs("unverified");
    });
    const refetched = await act(() => rendered.result.current.refetch());

    expect(refetched.error?.message).toContain(
      "no longer holds a cloud verdict",
    );
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });
});
