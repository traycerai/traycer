/**
 * End-to-end proof that an `enqueueRateLimitFetch` call actually flips
 * `isFetching` on an already-mounted `useHostProviderRateLimitsQuery`
 * observer for the same provider - the mechanism `RateLimitProviderBlock`'s
 * per-provider refresh icon and `RateLimitRefreshAllButton` both depend on to
 * stay in sync. Uses a real `HostClient` + `MockHostMessenger` (not a fully
 * mocked query hook) so this exercises the real query-key derivation on both
 * sides, not just TanStack's own sharing semantics in isolation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import {
  __resetRateLimitQueueForTests,
  configureRateLimitQueue,
  enqueueRateLimitFetch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

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

describe("enqueueRateLimitFetch keeps a mounted useHostProviderRateLimitsQuery observer's isFetching in sync", () => {
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
  });

  it("flips isFetching true on the observer while a force:true enqueue is in flight, then false once it settles", async () => {
    // Production QueryClient configuration, not a bare test one: the global
    // `staleTime` default changes `fetchQuery` semantics (it serves
    // still-fresh cache without fetching), and this exact flow - data freshly
    // loaded, then a force:true enqueue - is where that difference silently
    // no-oped the real app's refresh while a staleTime-0 test client passed.
    const queryClient = createAppQueryClient();
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
    const { method, params, options } = providerRateLimitQueryOptions("codex");
    const rendered = renderHook(
      () => useHostQuery({ client, method, params, options }),
      { wrapper: Wrapper },
    );

    // Let the initial mount fetch settle (callCount === 1, resolves immediately).
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
    expect(rendered.result.current.isFetching).toBe(false);

    configureRateLimitQueue({
      hostId: mockLocalHostEntry.hostId,
      queryClient,
      request: (_hostId, rpcMethod, rpcParams) =>
        client.request(rpcMethod, rpcParams),
    });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
    });

    // The second call is the one that blocks on `pending` - the observer
    // mounted independently of the queue must see this as in flight.
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(true));

    pending.current.resolve();
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
  });
});
