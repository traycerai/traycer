/**
 * End-to-end proof that an `enqueueRateLimitFetch` call actually flips
 * `isFetching` on an already-mounted `useHostProviderRateLimitsQuery`
 * observer for the same provider - the mechanism `RateLimitProviderBlock`'s
 * per-provider refresh icon and `RateLimitRefreshAllButton` both depend on to
 * stay in sync. Uses the shared harness's real `HostClient` +
 * `MockHostMessenger` and PRODUCTION QueryClient configuration: this exact
 * flow - data freshly loaded, then a force:true enqueue - is where the
 * inherited global staleTime silently no-oped the real app's refresh while a
 * bare staleTime-0 test client passed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import {
  __resetRateLimitQueueForTests,
  configureRateLimitQueue,
  enqueueRateLimitFetch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  createQueryClientWrapper,
  createRateLimitSharingHarness,
} from "@/lib/rate-limits/__tests__/provider-rate-limit-sharing-harness";

describe("enqueueRateLimitFetch keeps a mounted useHostProviderRateLimitsQuery observer's isFetching in sync", () => {
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
  });

  it("flips isFetching true on the observer while a force:true enqueue is in flight, then false once it settles", async () => {
    const harness = createRateLimitSharingHarness();
    const { method, params, options } = providerRateLimitQueryOptions("codex");
    const rendered = renderHook(
      () => useHostQuery({ client: harness.client, method, params, options }),
      { wrapper: createQueryClientWrapper(harness.queryClient) },
    );

    // Let the initial mount fetch settle (the harness resolves it immediately).
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
    expect(rendered.result.current.isFetching).toBe(false);

    configureRateLimitQueue({
      hostId: mockLocalHostEntry.hostId,
      queryClient: harness.queryClient,
      request: (_hostId, rpcMethod, rpcParams) =>
        harness.client.request(rpcMethod, rpcParams),
    });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
    });

    // The second call is the one the harness blocks - the observer mounted
    // independently of the queue must see this as in flight.
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(true));

    harness.resolvePendingResponse();
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
  });
});
