/**
 * End-to-end proof that a `queryClient.invalidateQueries` call for an
 * httpFetch provider's query key (what `RateLimitRefreshAllButton` issues)
 * flips `isFetching` on an already-mounted `useHostProviderRateLimitsQuery`
 * observer for that same provider - the mechanism `RateLimitProviderBlock`'s
 * per-provider refresh icon depends on. Uses the shared harness's real
 * `HostClient` + `MockHostMessenger` and PRODUCTION QueryClient
 * configuration - a bare test client's staleTime-0 defaults exercise
 * different fetch semantics than the app runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import { queryKeys } from "@/lib/query-keys";
import {
  createQueryClientWrapper,
  createRateLimitSharingHarness,
} from "@/lib/rate-limits/__tests__/provider-rate-limit-sharing-harness";

describe("invalidateQueries keeps a mounted useHostProviderRateLimitsQuery observer's isFetching in sync (httpFetch lane)", () => {
  afterEach(() => {
    cleanup();
  });

  it("flips isFetching true on the observer while the invalidation-triggered refetch is in flight", async () => {
    const harness = createRateLimitSharingHarness();
    const { method, params, options } =
      providerRateLimitQueryOptions("openrouter");
    const rendered = renderHook(
      () => useHostQuery({ client: harness.client, method, params, options }),
      { wrapper: createQueryClientWrapper(harness.queryClient) },
    );

    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
    expect(rendered.result.current.isFetching).toBe(false);

    // Exactly what `RateLimitRefreshAllButton.refreshAll` issues for an
    // httpFetch provider.
    void harness.queryClient.invalidateQueries({
      queryKey: queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
        mockLocalHostEntry.hostId,
        "host.getRateLimitUsage",
        { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId: "openrouter" },
      ),
    });

    await waitFor(() => expect(rendered.result.current.isFetching).toBe(true));

    harness.resolvePendingResponse();
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
  });
});
