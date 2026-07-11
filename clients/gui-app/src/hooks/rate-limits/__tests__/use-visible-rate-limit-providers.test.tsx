import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  ProviderAuthStatus,
  ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

interface MockQueryResult {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isError: boolean;
}

interface MockState {
  providers: readonly ProviderCliState[];
  results: Map<RateLimitProviderId, MockQueryResult>;
}

const mocks = vi.hoisted<MockState>(() => ({
  providers: [],
  results: new Map(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: { providers: mocks.providers } }),
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueriesWithResponseMap: (args: {
    readonly requests: ReadonlyArray<{
      readonly params: { readonly providerId: RateLimitProviderId };
    }>;
  }) =>
    args.requests.map(
      (request) =>
        mocks.results.get(request.params.providerId) ?? {
          data: undefined,
          isError: false,
        },
    ),
}));

import {
  useConfiguredRateLimitProviders,
  useVisibleRateLimitProviders,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";

const NOW = Date.now();

function auth(status: ProviderAuthStatus): ProviderCliState["auth"] {
  return { status, badgeText: null, label: null, detail: null };
}

function providerState(args: {
  readonly providerId: RateLimitProviderId;
  readonly status: ProviderAuthStatus;
  readonly enabled: boolean;
  readonly authPending: boolean;
  readonly availabilityPending: boolean;
}): ProviderCliState {
  return {
    enabled: args.enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: args.authPending,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: args.availabilityPending,
    providerId: args.providerId,
    auth: auth(args.status),
    profiles: [],
  };
}

function codexLimits(): AvailableProviderRateLimits {
  return {
    provider: "codex",
    available: true,
    planType: "pro_5x",
    limitId: null,
    limitName: null,
    primary: {
      usedPercent: 12,
      resetsAt: NOW + 60 * 60 * 1000,
      durationMinutes: 300,
    },
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
}

function envelope(
  data: AvailableProviderRateLimits,
): ProviderRateLimitEnvelope {
  return {
    latest: data,
    lastGood: data,
    lastGoodAt: NOW - 60_000,
    lastFailureAt: null,
  };
}

beforeEach(() => {
  mocks.providers = [];
  mocks.results = new Map();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useVisibleRateLimitProviders", () => {
  it("keeps the strict configured hook gated by provider auth state", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "unavailable",
        enabled: true,
        authPending: false,
        availabilityPending: false,
      }),
    ];
    mocks.results.set("codex", {
      data: envelope(codexLimits()),
      isError: false,
    });

    const { result } = renderHook(() => useConfiguredRateLimitProviders());

    expect(result.current).toEqual([]);
  });

  it("includes a signed-in provider with cached usage data when account-status probing is unavailable", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "unavailable",
        enabled: true,
        authPending: false,
        availabilityPending: false,
      }),
    ];
    mocks.results.set("codex", {
      data: envelope(codexLimits()),
      isError: false,
    });

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      { providerId: "codex", lane: "ephemeralProcess", profiles: [] },
    ]);
  });

  it("includes a configured provider even when no usage cache entry exists", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "authenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
      }),
    ];

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      { providerId: "codex", lane: "ephemeralProcess", profiles: [] },
    ]);
  });

  it("includes a signed-in provider with a cached fetch error so the popover can show refreshable error state", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "unavailable",
        enabled: true,
        authPending: false,
        availabilityPending: false,
      }),
    ];
    mocks.results.set("codex", { data: undefined, isError: true });

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      { providerId: "codex", lane: "ephemeralProcess", profiles: [] },
    ]);
  });

  it("does not show an unconfigured provider before the usage cache has any state for it", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "unavailable",
        enabled: true,
        authPending: false,
        availabilityPending: false,
      }),
    ];

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([]);
  });

  it("does not keep showing a signed-out provider from stale cached usage", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "unauthenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
      }),
    ];
    mocks.results.set("codex", {
      data: envelope(codexLimits()),
      isError: false,
    });

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([]);
  });
});
