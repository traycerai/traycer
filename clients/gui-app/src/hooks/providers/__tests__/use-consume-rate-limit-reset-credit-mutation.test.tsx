/**
 * Exercises the REAL `useConsumeRateLimitResetCreditMutation` against a real
 * `HostClient` + `MockHostMessenger` and a real `QueryClient` - proving the
 * `onSuccess` handler's interaction with `fetchProviderRateLimits`: a Codex
 * read already in flight for the reset profile is cancelled (not joined) and
 * a fresh, forced read replaces it. See `codex-reset-credit-action.test.tsx`
 * for the confirmation-dialog / idempotency-key behavior, which mocks this
 * hook entirely and never exercises `onSuccess`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RateLimitUsageResponse } from "@/lib/rate-limits/rate-limit-envelope";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { fetchProviderRateLimits } from "@/lib/rate-limits/provider-rate-limit-fetch";

const mocks = vi.hoisted<{
  hostId: string | null;
  client: HostClient<HostRpcRegistry> | null;
}>(() => ({ hostId: null, client: null }));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mocks.hostId,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => mocks.client,
    // The SPINE, a separate export since redesign P2.1.
    useHostRuntimeClient: () => mocks.client,
  };
});

import { useProviderRateLimitFetchScope } from "@/hooks/rate-limits/use-provider-rate-limit-fetch-scope";
import { useConsumeRateLimitResetCreditMutation } from "@/hooks/providers/use-consume-rate-limit-reset-credit-mutation";

function usageResponse(): RateLimitUsageResponse {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits: null };
}

interface Harness {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  /** Every `host.getRateLimitUsage` call, in order, with the `force` it carried. */
  readonly getRateLimitUsageCalls: ReadonlyArray<{
    readonly profileId: string | null;
    readonly force: boolean | undefined;
  }>;
  readonly settleGetRateLimitUsage: (index: number) => void;
}

function buildHarness(): Harness {
  const queryClient = createAppQueryClient();
  const getRateLimitUsageCalls: Array<{
    readonly profileId: string | null;
    readonly force: boolean | undefined;
  }> = [];
  const settlers: Array<() => void> = [];
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-reset-credit",
      handlers: {
        "host.getRateLimitUsage": (params) => {
          getRateLimitUsageCalls.push({
            profileId: params.profileId,
            force: params.force,
          });
          return new Promise<RateLimitUsageResponse>((resolve) => {
            settlers.push(() => resolve(usageResponse()));
          });
        },
        "providers.consumeRateLimitResetCredit": () =>
          Promise.resolve({ outcome: "reset" as const }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    queryClient,
    client: spine.createRequester(mockLocalHostEntry),
    getRateLimitUsageCalls,
    settleGetRateLimitUsage: (index) => settlers[index](),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useConsumeRateLimitResetCreditMutation onSuccess", () => {
  afterEach(() => {
    cleanup();
  });

  it("cancels a Codex read already in flight for the reset profile and issues a NEW forced request, rather than joining the cancelled one", async () => {
    const harness = buildHarness();
    mocks.hostId = mockLocalHostEntry.hostId;
    mocks.client = harness.client;
    const wrapper = wrapperFor(harness.queryClient);

    const scopeHook = renderHook(() => useProviderRateLimitFetchScope(), {
      wrapper,
    });
    const scope = scopeHook.result.current;
    if (scope === null) throw new Error("expected a resolved fetch scope");

    // Seed an in-flight AUTOMATIC read for the profile the reset targets.
    void fetchProviderRateLimits(
      scope,
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "personal",
      },
      { force: false },
    );
    await flush();
    expect(harness.getRateLimitUsageCalls).toEqual([
      { profileId: "personal", force: false },
    ]);

    const mutationHook = renderHook(
      () => useConsumeRateLimitResetCreditMutation(),
      { wrapper },
    );
    act(() => {
      mutationHook.result.current.mutate({
        providerId: "codex",
        profileId: "personal",
        idempotencyKey: "idem-1",
        creditId: null,
      });
    });

    await waitFor(() =>
      expect(mutationHook.result.current.isSuccess).toBe(true),
    );
    await flush();

    // Not joined: the in-flight automatic read was cancelled, and the reset's
    // own forced read is a second, independent request on the wire.
    expect(harness.getRateLimitUsageCalls).toEqual([
      { profileId: "personal", force: false },
      { profileId: "personal", force: true },
    ]);

    const queryKey = queryKeys.hostMethod<
      HostRpcRegistry,
      "host.getRateLimitUsage"
    >(mockLocalHostEntry.hostId, "host.getRateLimitUsage", {
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "codex",
      profileId: "personal",
    });
    expect(harness.queryClient.getQueryState(queryKey)?.fetchStatus).toBe(
      "fetching",
    );

    // Resolve the forced (second) read first, then the stale cancelled first
    // read - the cancelled one's late arrival must not overwrite it.
    harness.settleGetRateLimitUsage(1);
    await flush();
    const afterForced = harness.queryClient.getQueryData(queryKey);
    expect(afterForced).toBeDefined();

    harness.settleGetRateLimitUsage(0);
    await flush();
    expect(harness.queryClient.getQueryData(queryKey)).toEqual(afterForced);
  });
});
