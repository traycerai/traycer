import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { useRefreshProviders } from "@/hooks/providers/use-refresh-providers";
import { useTabRefreshProviders } from "@/hooks/providers/use-tab-refresh-providers";

const runtimeMock = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => runtimeMock.client,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => runtimeMock.client,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => mockLocalHostEntry.hostId,
}));

function pendingProvider(): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: true,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

describe("useRefreshProviders", () => {
  afterEach(() => {
    runtimeMock.client = null;
    cleanup();
  });

  it("resets a capped providers episode before active and tab-scoped forceAuthRefresh", async () => {
    const queryClient = createAppQueryClient();
    let requestSeq = 0;
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      schedulingPolicy: hostRpcSchedulingPolicy,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => {
          requestSeq += 1;
          return `req-${String(requestSeq)}`;
        },
        handlers: {
          "providers.list": () => ({ providers: [pendingProvider()] }),
        },
      }),
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
    runtimeMock.client = client;
    const queryKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      mockLocalHostEntry.hostId,
      "providers.list",
      {},
    );
    const coordinator = getConditionPollEpisodeCoordinator(queryClient);
    const interval = coordinator.refetchIntervalFor("providers.list");
    const pendingResponse = { providers: [pendingProvider()] };
    queryClient.setQueryData(queryKey, pendingResponse);
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: () => Promise.resolve(pendingResponse),
      meta: stampHostRpcMethod(undefined, "providers.list"),
      retry: false,
      refetchInterval: interval,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    for (let index = 0; index < 7; index += 1) {
      queryClient.setQueryData(queryKey, pendingResponse);
    }

    const query = queryClient.getQueryCache().find({
      queryKey,
      exact: true,
    });
    if (query === undefined) throw new Error("Expected providers query");
    expect(interval(query)).toBe(30_000);

    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        active: useRefreshProviders(),
        tab: useTabRefreshProviders(),
      }),
      {
        wrapper: Wrapper,
      },
    );
    await act(async () => {
      await result.current.active();
    });

    expect(interval(query)).toBe(800);
    for (let index = 0; index < 7; index += 1) {
      queryClient.setQueryData(queryKey, pendingResponse);
    }
    expect(interval(query)).toBe(30_000);
    await act(async () => {
      await result.current.tab();
    });
    expect(interval(query)).toBe(800);
    unsubscribe();
    coordinator.dispose();
  });
});
