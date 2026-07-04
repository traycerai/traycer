/**
 * End-to-end proof that a `queryClient.invalidateQueries` call for an
 * httpFetch provider's query key (what `RateLimitRefreshAllButton` issues)
 * flips `isFetching` on an already-mounted `useHostProviderRateLimitsQuery`
 * observer for that same provider - the mechanism `RateLimitProviderBlock`'s
 * per-provider refresh icon depends on. Uses a real `HostClient` +
 * `MockHostMessenger`, not a fully mocked query hook.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import { queryKeys } from "@/lib/query-keys";

function makeControllableResponse() {
  let resolveFn: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: () => resolveFn?.(),
  };
}

describe("invalidateQueries keeps a mounted useHostProviderRateLimitsQuery observer's isFetching in sync (httpFetch lane)", () => {
  afterEach(() => {
    cleanup();
  });

  it("flips isFetching true on the observer while the invalidation-triggered refetch is in flight", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let callCount = 0;
    const pending = { current: makeControllableResponse() };
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "host.getRateLimitUsage": async () => {
            callCount += 1;
            if (callCount === 1) {
              return {
                totalTokens: 0,
                remainingTokens: 0,
                providerRateLimits: null,
              };
            }
            await pending.current.promise;
            return {
              totalTokens: 0,
              remainingTokens: 0,
              providerRateLimits: null,
            };
          },
        },
      }),
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );

    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { method, params, options } =
      providerRateLimitQueryOptions("openrouter");
    const rendered = renderHook(
      () => useHostQuery({ client, method, params, options }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
    expect(rendered.result.current.isFetching).toBe(false);

    // Exactly what `RateLimitRefreshAllButton.refreshAll` issues for an
    // httpFetch provider.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
        mockLocalHostEntry.hostId,
        "host.getRateLimitUsage",
        { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId: "openrouter" },
      ),
    });

    await waitFor(() => expect(rendered.result.current.isFetching).toBe(true));

    pending.current.resolve();
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
  });
});
