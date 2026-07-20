import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
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

// `useProfileUsageComparison` builds its target-host scope through
// `useRunTargetHost`, which is separately covered by
// `use-run-target-host.test.tsx` (default vs tab vs unreachable-host
// resolution). Here we mock it to hand back scopes built from two real
// `HostClient`s over independently-spyable `MockHostMessenger`s, so these
// tests can assert exactly which host's transport received a request without
// standing up real WebSocket connections.
const scopesRef = vi.hoisted(() => ({
  byHostId: new Map<string | null, RunTargetHost>(),
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

import { useProfileUsageComparison } from "@/hooks/rate-limits/use-profile-usage-comparison";

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
): {
  readonly scope: RunTargetHost;
  readonly requestSpy: RateLimitUsageHandler;
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
    isReady: true,
    queueScope: {
      hostId,
      queryClient,
      request: (_hostId, method, params) => client.request(method, params),
    },
  };
  return { scope, requestSpy: handler };
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

describe("useProfileUsageComparison", () => {
  beforeEach(() => {
    __resetRateLimitQueueForTests();
    scopesRef.byHostId.clear();
  });
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
    scopesRef.byHostId.clear();
  });

  it("issues zero host.getRateLimitUsage calls purely from mounting (cache-only observation)", () => {
    const queryClient = new QueryClient();
    const defaultRequest = vi.fn(goodResponse);
    const { scope } = buildHostScope(
      "default-host",
      queryClient,
      defaultRequest,
    );
    scopesRef.byHostId.set(null, scope);

    const ambient = profile("ambient-1", "ambient", "Terminal account", {});
    const managed = profile("work-1", "managed", "Work", {});

    renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [ambient, managed],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    expect(defaultRequest).not.toHaveBeenCalled();
  });

  it("resolves never-checked vs semantic-only vs fresh from the cheap host summary and cached envelope", () => {
    const queryClient = new QueryClient();
    const { scope } = buildHostScope("default-host", queryClient, goodResponse);
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
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [neverChecked, semanticOnly, freshProfile],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    expect(result.current.entries.get("p-never")?.detail.kind).toBe(
      "never-checked",
    );
    expect(result.current.entries.get("p-semantic")?.detail).toEqual({
      kind: "semantic-only",
      status: "near_limit",
    });
    expect(result.current.entries.get("p-fresh")?.detail.kind).toBe("fresh");
  });

  it("addresses the ambient profile with the ambient null identity, not the wire kind sentinel", () => {
    const queryClient = new QueryClient();
    const { scope } = buildHostScope("default-host", queryClient, goodResponse);
    scopesRef.byHostId.set(null, scope);

    const ambientKey = queryKeys.hostMethod<
      HostRpcRegistry,
      "host.getRateLimitUsage"
    >("default-host", "host.getRateLimitUsage", {
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "claude-code",
      profileId: null,
    });
    queryClient.setQueryData(ambientKey, {
      latest: goodResponse().providerRateLimits,
      lastGood: goodResponse().providerRateLimits,
      lastGoodAt: Date.now(),
      lastFailureAt: null,
    });

    const ambient = profile(
      "ambient-sentinel-id",
      "ambient",
      "Terminal account",
      {},
    );

    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [ambient],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    // Keyed by the ambient commit id (null), not the wire `profileId` sentinel.
    expect(result.current.entries.has(null)).toBe(true);
    expect(result.current.entries.has("ambient-sentinel-id")).toBe(false);
    expect(result.current.entries.get(null)?.detail.kind).toBe("fresh");
  });

  it("routes an explicit refresh to exactly the previewed profile via the ephemeralProcess queue, and never to a sibling profile", async () => {
    const queryClient = new QueryClient();
    const calls: Array<unknown> = [];
    const { scope } = buildHostScope("default-host", queryClient, (params) => {
      calls.push(params);
      return goodResponse();
    });
    scopesRef.byHostId.set(null, scope);

    const profileA = profile("p-a", "managed", "A", {});
    const profileB = profile("p-b", "managed", "B", {});

    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
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

  it("ensureFresh fetches once for a cold profile, then no-ops on still-fresh cache while a forced refresh still fires", async () => {
    const queryClient = new QueryClient();
    const calls: Array<unknown> = [];
    const { scope } = buildHostScope("default-host", queryClient, (params) => {
      calls.push(params);
      return goodResponse();
    });
    scopesRef.byHostId.set(null, scope);

    const profileA = profile("p-a", "managed", "A", {});

    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [profileA],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    // Cold cache: the automatic check spends its one request.
    await result.current.entries.get("p-a")?.ensureFresh();
    expect(calls).toHaveLength(1);

    // Fresh cache: the non-forced path must NOT re-spawn a subprocess - this
    // is what makes the banner's automatic check burst-safe when several
    // composers nominate the same probe target.
    await result.current.entries.get("p-a")?.ensureFresh();
    expect(calls).toHaveLength(1);

    // A user-initiated refresh bypasses the freshness floor as before.
    await result.current.entries.get("p-a")?.refresh();
    expect(calls).toHaveLength(2);
  });

  it("routes an explicit refresh for the httpFetch lane through the profile's own passive query, addressing exactly that profile", async () => {
    const queryClient = new QueryClient();
    const calls: Array<unknown> = [];
    const { scope } = buildHostScope("default-host", queryClient, (params) => {
      calls.push(params);
      return { totalTokens: 0, remainingTokens: 0, providerRateLimits: null };
    });
    scopesRef.byHostId.set(null, scope);

    const profileA = profile("p-a", "managed", "A", {});
    const profileB = profile("p-b", "managed", "B", {});

    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "openrouter",
          profiles: [profileA, profileB],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    await result.current.entries.get("p-a")?.refresh();

    expect(calls).toEqual([
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "openrouter",
        profileId: "p-a",
      },
    ]);
  });

  it("targets the explicit tab host and never touches the default host's client or cache", async () => {
    const queryClient = new QueryClient();
    const defaultRequest = vi.fn(goodResponse);
    const tabCalls: Array<unknown> = [];
    const { scope: defaultScope } = buildHostScope(
      "default-host",
      queryClient,
      defaultRequest,
    );
    const { scope: tabScope } = buildHostScope(
      "tab-host",
      queryClient,
      (params) => {
        tabCalls.push(params);
        return goodResponse();
      },
    );
    scopesRef.byHostId.set(null, defaultScope);
    scopesRef.byHostId.set("tab-host", tabScope);

    const managed = profile("p-tab", "managed", "Tab profile", {});

    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: "tab-host",
          providerId: "claude-code",
          profiles: [managed],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    expect(result.current.hostId).toBe("tab-host");
    await result.current.entries.get("p-tab")?.refresh();

    expect(defaultRequest).not.toHaveBeenCalled();
    expect(tabCalls).toEqual([
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "claude-code",
        profileId: "p-tab",
      },
    ]);
    expect(
      queryClient.getQueryData(
        queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
          "tab-host",
          "host.getRateLimitUsage",
          {
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            providerId: "claude-code",
            profileId: "p-tab",
          },
        ),
      ),
    ).toBeDefined();
    expect(
      queryClient.getQueryData(
        queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
          "default-host",
          "host.getRateLimitUsage",
          {
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            providerId: "claude-code",
            profileId: "p-tab",
          },
        ),
      ),
    ).toBeUndefined();
  });

  it("serializes two profiles' ephemeralProcess refreshes through the shared queue, one at a time", async () => {
    const queryClient = new QueryClient();
    const order: string[] = [];
    const releaseFirstRef: { current: (() => void) | null } = { current: null };
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstRef.current = resolve;
    });
    const { scope } = buildHostScope("default-host", queryClient, (params) => {
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
    });
    scopesRef.byHostId.set(null, scope);

    const profileA = profile("p-a", "managed", "A", {});
    const profileB = profile("p-b", "managed", "B", {});

    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [profileA, profileB],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    const refreshA = result.current.entries.get("p-a")?.refresh();
    const refreshB = result.current.entries.get("p-b")?.refresh();

    await waitFor(() => expect(order).toEqual(["start:p-a"]));
    // p-b's own fetch has not started yet (it is waiting its turn behind p-a
    // in the shared serial queue), so it reads as queued, not refreshing.
    await waitFor(() =>
      expect(result.current.entries.get("p-b")?.refreshStatus).toBe("queued"),
    );
    expect(result.current.entries.get("p-a")?.refreshStatus).toBe("refreshing");

    releaseFirstRef.current?.();
    await refreshA;
    await refreshB;

    expect(order).toEqual(["start:p-a", "end:p-a", "start:p-b", "end:p-b"]);
    await waitFor(() =>
      expect(result.current.entries.get("p-b")?.refreshStatus).toBe("idle"),
    );
  });

  it("retains the last-good reading (dimmed) after a refresh resolves with a transient failure", async () => {
    const queryClient = new QueryClient();
    let resolveWithFailure = false;
    const { scope } = buildHostScope("default-host", queryClient, () =>
      resolveWithFailure
        ? {
            totalTokens: 0,
            remainingTokens: 0,
            providerRateLimits: {
              provider: "claude-code" as const,
              available: false as const,
              reason: "usage_fetch_failed" as const,
            },
          }
        : goodResponse(),
    );
    scopesRef.byHostId.set(null, scope);

    const managed = profile("p-a", "managed", "A", {});
    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [managed],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    await result.current.entries.get("p-a")?.refresh();
    await waitFor(() =>
      expect(result.current.entries.get("p-a")?.detail.kind).toBe("fresh"),
    );

    resolveWithFailure = true;
    await result.current.entries.get("p-a")?.refresh();
    await waitFor(() =>
      expect(result.current.entries.get("p-a")?.detail.kind).toBe(
        "failed-with-last-good",
      ),
    );
    const detail = result.current.entries.get("p-a")?.detail;
    if (detail?.kind !== "failed-with-last-good") {
      throw new Error("expected failed-with-last-good");
    }
    expect(detail.usage.provider).toBe("claude-code");
  });

  it("surfaces a rejected host refresh while retaining the last-good reading", async () => {
    const queryClient = new QueryClient();
    let rejectRequest = false;
    const { scope } = buildHostScope("default-host", queryClient, () => {
      if (rejectRequest) throw new Error("host transport failed");
      return goodResponse();
    });
    scopesRef.byHostId.set(null, scope);

    const managed = profile("p-a", "managed", "A", {});
    const { result } = renderHook(
      () =>
        useProfileUsageComparison({
          runTargetHostId: null,
          providerId: "claude-code",
          profiles: [managed],
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    await result.current.entries.get("p-a")?.refresh();
    await waitFor(() =>
      expect(result.current.entries.get("p-a")?.detail.kind).toBe("fresh"),
    );

    rejectRequest = true;
    await result.current.entries.get("p-a")?.refresh();
    await waitFor(() =>
      expect(result.current.entries.get("p-a")?.detail.kind).toBe(
        "failed-with-last-good",
      ),
    );
  });
});
