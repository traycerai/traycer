import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
  RateLimitUsageResponseV12,
} from "@traycer/protocol/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

interface MockQueryResult {
  readonly data: RateLimitUsageResponseV12 | undefined;
  readonly isError: boolean;
}

type MockState = {
  configured: ReadonlyArray<{
    readonly providerId: RateLimitProviderId;
    readonly lane: "httpFetch" | "ephemeralProcess";
  }>;
  results: Map<RateLimitProviderId, MockQueryResult>;
};

const mocks = vi.hoisted<MockState>(() => ({
  configured: [],
  results: new Map(),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));
vi.mock("@/hooks/rate-limits/use-configured-rate-limit-providers", () => ({
  useConfiguredRateLimitProviders: () => mocks.configured,
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
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

import { useHeaderRateLimitBars } from "@/hooks/rate-limits/use-header-rate-limit-bars";

function rlWindow(usedPercent: number): ProviderRateLimitWindow {
  return { usedPercent, resetsAt: null, durationMinutes: null };
}

function response(
  providerRateLimits: ProviderRateLimits,
): RateLimitUsageResponseV12 {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits };
}

function setProvider(
  providerId: RateLimitProviderId,
  lane: "httpFetch" | "ephemeralProcess",
  result: MockQueryResult,
): void {
  mocks.configured = [...mocks.configured, { providerId, lane }];
  mocks.results.set(providerId, result);
}

function codexFixture(overrides: {
  readonly primary?: ProviderRateLimitWindow | null;
  readonly secondary?: ProviderRateLimitWindow | null;
  readonly extraWindows?: Array<{
    limitId: string;
    limitName: string | null;
    primary: ProviderRateLimitWindow | null;
    secondary: ProviderRateLimitWindow | null;
  }>;
}): ProviderRateLimits {
  return {
    provider: "codex",
    available: true,
    planType: null,
    limitId: null,
    limitName: null,
    primary: overrides.primary ?? null,
    secondary: overrides.secondary ?? null,
    extraWindows: overrides.extraWindows ?? [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
}

function claudeCodeFixture(overrides: {
  readonly fiveHour?: ProviderRateLimitWindow | null;
  readonly sevenDay?: ProviderRateLimitWindow | null;
  readonly sevenDayOpus?: ProviderRateLimitWindow | null;
  readonly sevenDaySonnet?: ProviderRateLimitWindow | null;
  readonly modelScoped?: Array<
    { displayName: string } & ProviderRateLimitWindow
  >;
}): ProviderRateLimits {
  return {
    provider: "claude-code",
    available: true,
    subscriptionType: null,
    fiveHour: overrides.fiveHour ?? null,
    sevenDay: overrides.sevenDay ?? null,
    sevenDayOpus: overrides.sevenDayOpus ?? null,
    sevenDaySonnet: overrides.sevenDaySonnet ?? null,
    modelScoped: overrides.modelScoped ?? [],
    extraUsage: null,
  };
}

function openRouterFixture(overrides: {
  readonly limit: number | null;
  readonly limitRemaining: number | null;
}): ProviderRateLimits {
  return {
    provider: "openrouter",
    available: true,
    limit: overrides.limit,
    limitRemaining: overrides.limitRemaining,
    dailySpend: null,
    weeklySpend: null,
    monthlySpend: null,
    totalCredits: null,
    totalUsage: null,
    balance: null,
  };
}

function kiloCodeFixture(): ProviderRateLimits {
  return {
    provider: "kilocode",
    available: true,
    creditBalance: 42,
    passState: null,
  };
}

function unavailableFixture(): ProviderRateLimits {
  return { provider: "codex", available: false, reason: "cli_not_found" };
}

beforeEach(() => {
  mocks.configured = [];
  mocks.results = new Map();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useHeaderRateLimitBars", () => {
  it("returns no bars when zero providers are configured", () => {
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([]);
  });

  it("returns no bars for a configured provider with no data yet (cold load)", () => {
    setProvider("codex", "ephemeralProcess", {
      data: undefined,
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([]);
  });

  it("shows each provider's 5h window when both Codex and Claude Code are configured, codex first", () => {
    // Insert Claude first to prove the codex-before-claude order is fixed (from
    // GLYPH_PROVIDER_IDS / PROVIDER_ID_ORDER), not just insertion order.
    setProvider("claude-code", "ephemeralProcess", {
      data: response(
        claudeCodeFixture({ fiveHour: rlWindow(70), sevenDay: rlWindow(10) }),
      ),
      isError: false,
    });
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({ primary: rlWindow(40), secondary: rlWindow(20) }),
      ),
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 40,
        severity: "blue",
        degraded: false,
      },
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 70,
        severity: "yellow",
        degraded: false,
      },
    ]);
  });

  it("fills both bars from Codex's 5h + Weekly windows when only Codex is configured", () => {
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({ primary: rlWindow(88), secondary: rlWindow(30) }),
      ),
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 88,
        severity: "red",
        degraded: false,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 30,
        severity: "blue",
        degraded: false,
      },
    ]);
  });

  it("fills both bars from Claude Code's 5h + Weekly windows when only Claude Code is configured", () => {
    setProvider("claude-code", "ephemeralProcess", {
      data: response(
        claudeCodeFixture({ fiveHour: rlWindow(12), sevenDay: rlWindow(64) }),
      ),
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 12,
        severity: "blue",
        degraded: false,
      },
      {
        providerId: "claude-code",
        windowLabel: "Weekly",
        usedPercent: 64,
        severity: "yellow",
        degraded: false,
      },
    ]);
  });

  it("returns no bars when a single provider is missing one of its two windows (partial load)", () => {
    // Partial-load policy: the glyph fills both slots or shows the placeholder.
    // Claude's 5h has loaded but its Weekly window is absent -> [] (placeholder),
    // not a lone real bar.
    setProvider("claude-code", "ephemeralProcess", {
      data: response(
        claudeCodeFixture({ fiveHour: rlWindow(20), sevenDay: null }),
      ),
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([]);
  });

  it("returns no bars when both are configured but one is still cold (partial load)", () => {
    // Codex loaded, Claude Code still cold -> can't fill both slots -> [].
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({ primary: rlWindow(50), secondary: rlWindow(10) }),
      ),
      isError: false,
    });
    setProvider("claude-code", "ephemeralProcess", {
      data: undefined,
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([]);
  });

  it("never contributes bars for OpenRouter / Kilo Code (popover-only providers)", () => {
    setProvider("openrouter", "httpFetch", {
      data: response(openRouterFixture({ limit: 200, limitRemaining: 50 })),
      isError: false,
    });
    setProvider("kilocode", "httpFetch", {
      data: response(kiloCodeFixture()),
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([]);
  });

  it("returns no bars for the unavailable arm", () => {
    setProvider("codex", "ephemeralProcess", {
      data: response(unavailableFixture()),
      isError: false,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([]);
  });

  it("marks both of a single provider's bars degraded when the latest poll errored", () => {
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({ primary: rlWindow(65), secondary: rlWindow(15) }),
      ),
      isError: true,
    });
    const { result } = renderHook(() => useHeaderRateLimitBars());
    expect(result.current).toEqual([
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 65,
        severity: "yellow",
        degraded: true,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 15,
        severity: "blue",
        degraded: true,
      },
    ]);
  });
});
