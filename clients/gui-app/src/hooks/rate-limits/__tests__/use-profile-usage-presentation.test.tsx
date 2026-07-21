import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ReactNode } from "react";
import { queryKeys } from "@/lib/query-keys";
import type { RunTargetHost } from "@/hooks/rate-limits/use-run-target-host";
import { __resetRateLimitQueueForTests } from "@/lib/rate-limits/ephemeral-fetch-queue";
import type { RateLimitUsageResponse } from "@/lib/rate-limits/rate-limit-envelope";
import { rateLimitProviderState } from "./profile-usage-fixtures";

// Mirrors `use-profile-usage-comparison.test.tsx`'s mocking approach:
// `useProfileUsagePresentation` calls straight through to
// `useProfileUsageComparison` with no new host surface, so the same
// two-real-`HostClient`-scopes-over-spyable-messengers pattern applies here.
const scopesRef = vi.hoisted(() => ({
  byHostId: new Map<string | null, RunTargetHost>(),
}));
const providerStateRef = vi.hoisted(() => ({
  providers: [] as ReadonlyArray<ProviderCliState>,
}));
vi.mock("@/hooks/rate-limits/use-run-target-host", () => ({
  useRunTargetHost: (runTargetHostId: string | null) => {
    const scope = scopesRef.byHostId.get(runTargetHostId);
    if (scope === undefined) {
      throw new Error(
        `no test scope configured for ${String(runTargetHostId)}`,
      );
    }
    return scope;
  },
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: { providers: providerStateRef.providers },
  }),
}));

import { useProfileUsagePresentation } from "@/hooks/rate-limits/use-profile-usage-presentation";

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  overrides: Partial<ProviderProfile>,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
    ...overrides,
  };
}

type RateLimitUsageHandler = (
  params: unknown,
) => RateLimitUsageResponse | Promise<RateLimitUsageResponse>;

function buildHostScope(
  hostId: string,
  queryClient: QueryClient,
  handler: RateLimitUsageHandler,
  isReady: boolean,
): {
  readonly scope: RunTargetHost;
} {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.getRateLimitUsage": (params) => handler(params),
      },
    }),
  });
  client.bind({ ...mockLocalHostEntry, hostId });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const scope: RunTargetHost = {
    hostId,
    client,
    isReady,
    queueScope: {
      hostId,
      queryClient,
      request: (_hostId, method, params) => client.request(method, params),
    },
  };
  return { scope };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function goodResponse(): RateLimitUsageResponse {
  return {
    totalTokens: 0,
    remainingTokens: 0,
    providerRateLimits: {
      provider: "claude-code" as const,
      available: true as const,
      subscriptionType: "max" as const,
      fiveHour: { usedPercent: 10, resetsAt: null, durationMinutes: 300 },
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [],
      extraUsage: null,
    },
  };
}

describe("useProfileUsagePresentation", () => {
  beforeEach(() => {
    __resetRateLimitQueueForTests();
    scopesRef.byHostId.clear();
    providerStateRef.providers = [
      rateLimitProviderState("claude-code", "authenticated"),
    ];
  });
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
    scopesRef.byHostId.clear();
    providerStateRef.providers = [];
  });

  it("issues zero host.getRateLimitUsage calls purely from mounting (cache-only observation)", () => {
    const queryClient = new QueryClient();
    const defaultRequest = vi.fn(goodResponse);
    const { scope } = buildHostScope(
      "default-host",
      queryClient,
      defaultRequest,
      true,
    );
    scopesRef.byHostId.set(null, scope);

    const ambient = profile("ambient-1", "ambient", "Terminal account", {});
    const managed = profile("work-1", "managed", "Work", {});

    renderHook(
      () =>
        useProfileUsagePresentation({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [ambient, managed],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    expect(defaultRequest).not.toHaveBeenCalled();
  });

  it("reflects the underlying comparison's readiness", () => {
    const queryClient = new QueryClient();
    const notReadyScope: RunTargetHost = {
      hostId: "tab-host",
      client: null,
      isReady: false,
      queueScope: null,
    };
    scopesRef.byHostId.set("tab-host", notReadyScope);

    const managed = profile("p-a", "managed", "A", {});
    const { result } = renderHook(
      () =>
        useProfileUsagePresentation({
          runTargetHostId: "tab-host",
          providerId: "claude-code",
          profiles: [managed],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    expect(result.current.isHostReady).toBe(false);
  });

  it("preserves profile order/identity and projects each detail state to the matching projection kind", () => {
    const queryClient = new QueryClient();
    const { scope } = buildHostScope(
      "default-host",
      queryClient,
      goodResponse,
      true,
    );
    scopesRef.byHostId.set(null, scope);

    const neverChecked = profile("p-never", "managed", "Never", {
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      usageUpdatedAt: null,
    });
    const semanticOnly = profile("p-semantic", "managed", "Semantic", {
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: null,
      usageUpdatedAt: Date.now(),
    });
    const freshProfile = profile("p-fresh", "managed", "Fresh", {
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      usageUpdatedAt: Date.now(),
    });

    // Seed the fresh profile's exact cache key as if a prior observer/refresh
    // already wrote it - the passive observer must reflect it without itself
    // fetching.
    const freshKey = queryKeys.hostMethod<
      HostRpcRegistry,
      "host.getRateLimitUsage"
    >("default-host", "host.getRateLimitUsage", {
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "claude-code",
      profileId: "p-fresh",
    });
    queryClient.setQueryData(freshKey, {
      latest: goodResponse().providerRateLimits,
      lastGood: goodResponse().providerRateLimits,
      lastGoodAt: Date.now(),
      lastFailureAt: null,
    });

    const { result } = renderHook(
      () =>
        useProfileUsagePresentation({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [neverChecked, semanticOnly, freshProfile],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    expect(Array.from(result.current.entries.keys())).toEqual([
      "p-never",
      "p-semantic",
      "p-fresh",
    ]);
    expect(result.current.entries.get("p-never")?.projection.kind).toBe(
      "not_checked",
    );
    expect(result.current.entries.get("p-semantic")?.projection).toMatchObject({
      kind: "semantic_only",
      severity: "running_low",
    });
    expect(result.current.entries.get("p-fresh")?.projection.kind).toBe(
      "detail",
    );
  });

  it("scopes a refresh initiated on one profile to exactly that profile's entry, never a sibling's", async () => {
    const queryClient = new QueryClient();
    const order: string[] = [];
    const releaseFirstRef: { current: (() => void) | null } = { current: null };
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstRef.current = resolve;
    });
    const { scope } = buildHostScope(
      "default-host",
      queryClient,
      (params) => {
        const profileId = (params as { readonly profileId: string }).profileId;
        order.push(`start:${profileId}`);
        if (profileId === "p-a") {
          return firstGate.then(() => {
            order.push(`end:${profileId}`);
            return goodResponse();
          });
        }
        order.push(`end:${profileId}`);
        return goodResponse();
      },
      true,
    );
    scopesRef.byHostId.set(null, scope);

    const profileA = profile("p-a", "managed", "A", {});
    const profileB = profile("p-b", "managed", "B", {});

    const { result } = renderHook(
      () =>
        useProfileUsagePresentation({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [profileA, profileB],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    expect(result.current.entries.get("p-a")?.refreshStatus).toBe("idle");
    expect(result.current.entries.get("p-b")?.refreshStatus).toBe("idle");

    const refreshA = result.current.entries.get("p-a")?.refresh();
    await waitFor(() => expect(order).toEqual(["start:p-a"]));

    // The shared ephemeralProcess queue is now draining, so the raw
    // comparison would mark p-b "queued" too - but p-b's own refresh was
    // never invoked through this presentation hook, so its entry must stay
    // "idle" while only p-a reads as pending.
    expect(result.current.entries.get("p-a")?.refreshStatus).toBe("refreshing");
    expect(result.current.entries.get("p-b")?.refreshStatus).toBe("idle");

    releaseFirstRef.current?.();
    await refreshA;

    await waitFor(() =>
      expect(result.current.entries.get("p-a")?.refreshStatus).toBe("idle"),
    );
    expect(result.current.entries.get("p-b")?.refreshStatus).toBe("idle");
    expect(order).toEqual(["start:p-a", "end:p-a"]);
  });

  it("addresses a refresh to exactly the invoked profile via the ephemeralProcess queue", async () => {
    const queryClient = new QueryClient();
    const calls: Array<unknown> = [];
    const { scope } = buildHostScope(
      "default-host",
      queryClient,
      (params) => {
        calls.push(params);
        return goodResponse();
      },
      true,
    );
    scopesRef.byHostId.set(null, scope);

    const profileA = profile("p-a", "managed", "A", {});
    const profileB = profile("p-b", "managed", "B", {});

    const { result } = renderHook(
      () =>
        useProfileUsagePresentation({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [profileA, profileB],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    await result.current.entries.get("p-a")?.refresh();

    expect(calls).toEqual([
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "claude-code",
        profileId: "p-a",
      },
    ]);
  });
});
