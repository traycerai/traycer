/**
 * The build without environments (`unreleased-features.ts`) has no team
 * environments to list, so even an authorized viewer in a pool build asks for
 * none.
 */
const bindingRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useOptionalHostClient: () => bindingRef.current,
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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useTeamEnvironmentOwnership } from "@/hooks/environment/use-team-environment-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";

const VIEWER = "user-1";
const POOL_ENTRY = poolHostDirectoryEntry("wss://pool.test/rpc");

afterEach(() => {
  cleanup();
  bindingRef.current = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useTeamEnvironmentOwnership without environments", () => {
  it("sends no environment.list for an authorized viewer in a pool build and reads a chat as another person's", async () => {
    settleProcessHostRpcTierPlan(POOL_ENTRY);
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER, username: VIEWER },
    });
    const lists: string[] = [];
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
          "environment.list": () => {
            lists.push("environment.list");
            return { environments: [] };
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
    bindingRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => useTeamEnvironmentOwnership("env-team-1", null),
      { wrapper },
    );
    // Give a query the hook might start a turn of the loop to dispatch.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lists).toEqual([]);
    expect(result.current).toBe("other");
  });
});
