/**
 * End-to-end proof that an `enqueueRateLimitFetch` call actually flips
 * `isFetching` on an already-mounted `useHostProviderRateLimitsQuery`
 * observer for the same provider - the mechanism `RateLimitProviderBlock`'s
 * per-provider refresh icon and `RateLimitRefreshAllButton` both depend on to
 * stay in sync. Uses the shared harness's real `HostClient` +
 * `MockHostMessenger` and PRODUCTION QueryClient configuration: this exact
 * flow - disabled observer mounted, first snapshot loaded by the queue, then
 * a force:true enqueue - is where the inherited global staleTime silently
 * no-oped the real app's refresh while a bare staleTime-0 test client passed.
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

// The queue's queryFn now wraps the mock messenger's raw response (always
// `providerRateLimits: null` here - see the harness's own `response()` doc
// comment: only fetch timing matters to these tests) into the provider-pull
// envelope before TanStack caches it - a disabled passive `useHostQuery`
// observer of this key family sees whatever's actually in the cache, so its
// `.data` reflects the envelope shape too.
const EXPECTED_RATE_LIMIT_ENVELOPE = {
  latest: null,
  lastGood: null,
  lastGoodAt: null,
  lastFailureAt: null,
};

describe("enqueueRateLimitFetch keeps a mounted useHostProviderRateLimitsQuery observer's isFetching in sync", () => {
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
  });

  it("populates a disabled Codex observer from the queue and reflects a later force:true enqueue's fetch state", async () => {
    const harness = createRateLimitSharingHarness();
    const { method, params, options } = providerRateLimitQueryOptions(
      "codex",
      null,
    );
    const rendered = renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: harness.client,
          method,
          params,
          options,
        }),
      { wrapper: createQueryClientWrapper(harness.queryClient) },
    );

    // Codex is an `ephemeralProcess` provider: the mounted observer is disabled
    // and must not start a subprocess-spawning request on its own.
    expect(rendered.result.current.isPending).toBe(true);
    expect(rendered.result.current.isFetching).toBe(false);
    expect(rendered.result.current.data).toBeUndefined();

    configureRateLimitQueue({
      hostId: mockLocalHostEntry.hostId,
      queryClient: harness.queryClient,
      request: (_hostId, rpcMethod, rpcParams) =>
        harness.client.request(rpcMethod, rpcParams),
    });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });

    await waitFor(() =>
      expect(rendered.result.current.data).toEqual(
        EXPECTED_RATE_LIMIT_ENVELOPE,
      ),
    );
    expect(rendered.result.current.isPending).toBe(false);
    expect(rendered.result.current.isFetching).toBe(false);

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });

    // The second call is the one the harness blocks. The disabled observer,
    // mounted independently of the queue, must still see it as in flight.
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(true));

    harness.resolvePendingResponse();
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
    expect(rendered.result.current.data).toEqual(EXPECTED_RATE_LIMIT_ENVELOPE);
  });
});
