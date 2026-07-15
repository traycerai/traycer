import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";

interface MockQueryResult {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isError: boolean;
}

type MockState = {
  configured: ReadonlyArray<{
    readonly providerId: RateLimitProviderId;
    readonly lane: "httpFetch" | "ephemeralProcess";
  }>;
  results: Map<RateLimitProviderId, MockQueryResult>;
  profileIds: Map<RateLimitProviderId, string | null>;
  requests: ReadonlyArray<{
    readonly providerId: RateLimitProviderId;
    readonly profileId: string | null;
  }>;
};

const mocks = vi.hoisted<MockState>(() => ({
  configured: [],
  results: new Map(),
  profileIds: new Map(),
  requests: [],
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));
vi.mock("@/hooks/rate-limits/use-configured-rate-limit-providers", () => ({
  useConfiguredRateLimitProviders: () => mocks.configured,
  useVisibleRateLimitProviders: () => mocks.configured,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", () => ({
  resolveRateLimitProfileId: (
    _selection: unknown,
    providerId: RateLimitProviderId,
  ) => mocks.profileIds.get(providerId) ?? null,
}));
// Production calls `useHostQueriesWithResponseMap` (not the plain
// `useHostQueries`) - see that hook's own doc comment - so this mock exports
// both names with equivalent behavior; the extra `mapResponse` field
// production passes is irrelevant to this fixture-backed double.
function mockUseHostQueriesImpl(args: {
  readonly requests: ReadonlyArray<{
    readonly params: {
      readonly providerId: RateLimitProviderId;
      readonly profileId: string | null;
    };
  }>;
}) {
  mocks.requests = args.requests.map((request) => ({
    providerId: request.params.providerId,
    profileId: request.params.profileId,
  }));
  return args.requests.map(
    (request) =>
      mocks.results.get(request.params.providerId) ?? {
        data: undefined,
        isError: false,
      },
  );
}
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: mockUseHostQueriesImpl,
  useHostQueriesWithResponseMap: mockUseHostQueriesImpl,
}));

import { useHeaderRateLimitBars } from "@/hooks/rate-limits/use-header-rate-limit-bars";

const PROFILE_SELECTION = {
  activeChatSettings: null,
  lastProfileByHarness: {},
};

function renderHeaderRateLimitBars() {
  return renderHook(() => useHeaderRateLimitBars(PROFILE_SELECTION));
}

function rlWindow(
  usedPercent: number,
  durationMinutes: number | null,
): ProviderRateLimitWindow {
  return { usedPercent, resetsAt: null, durationMinutes };
}

// A fresh, cold-start envelope wrapping a single available reading - matches
// what production's `mapResponseToProviderRateLimitEnvelope` would produce
// for a provider's first successful pull.
function response(
  providerRateLimits: ProviderRateLimits,
): ProviderRateLimitEnvelope {
  return {
    latest: providerRateLimits,
    lastGood: providerRateLimits.available ? providerRateLimits : null,
    lastGoodAt: providerRateLimits.available ? Date.now() : null,
    lastFailureAt: null,
  };
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
}): AvailableProviderRateLimits {
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
  mocks.profileIds = new Map();
  mocks.requests = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useHeaderRateLimitBars", () => {
  it("returns no bars when zero providers are configured", () => {
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([]);
  });

  it("returns no bars for a configured provider with no data yet (cold load)", () => {
    setProvider("codex", "ephemeralProcess", {
      data: undefined,
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([]);
  });

  it("shows each provider's 5h window when both Codex and Claude Code are configured, codex first", () => {
    // Insert Claude first to prove the codex-before-claude order is fixed (from
    // GLYPH_PROVIDER_IDS / PROVIDER_ID_ORDER), not just insertion order.
    setProvider("claude-code", "ephemeralProcess", {
      data: response(
        claudeCodeFixture({
          fiveHour: rlWindow(70, 300),
          sevenDay: rlWindow(10, 10_080),
        }),
      ),
      isError: false,
    });
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({
          primary: rlWindow(40, 300),
          secondary: rlWindow(20, 10_080),
        }),
      ),
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 40,
        severity: "healthy",
        degraded: false,
      },
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 70,
        severity: "healthy",
        degraded: false,
      },
    ]);
  });

  it("queries each glyph provider with its resolved active or remembered profile", () => {
    mocks.profileIds = new Map([
      ["codex", "codex-work"],
      ["claude-code", "claude-personal"],
    ]);
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({
          primary: rlWindow(40, 300),
          secondary: rlWindow(20, 10_080),
        }),
      ),
      isError: false,
    });
    setProvider("claude-code", "ephemeralProcess", {
      data: response(
        claudeCodeFixture({
          fiveHour: rlWindow(70, 300),
          sevenDay: rlWindow(10, 10_080),
        }),
      ),
      isError: false,
    });

    renderHeaderRateLimitBars();

    expect(mocks.requests).toEqual([
      { providerId: "codex", profileId: "codex-work" },
      { providerId: "claude-code", profileId: "claude-personal" },
    ]);
  });

  it("fills both bars from Codex's 5h + Weekly windows when only Codex is configured", () => {
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({
          primary: rlWindow(88, 300),
          secondary: rlWindow(30, 10_080),
        }),
      ),
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 88,
        severity: "running_low",
        degraded: false,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 30,
        severity: "healthy",
        degraded: false,
      },
    ]);
  });

  it("classifies a fully consumed glyph window as Limited", () => {
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({
          primary: rlWindow(100, 300),
          secondary: rlWindow(40, 10_080),
        }),
      ),
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current[0]?.severity).toBe("limited");
    expect(result.current[1]?.severity).toBe("healthy");
  });

  it("fills both bars from Claude Code's 5h + Weekly windows when only Claude Code is configured", () => {
    setProvider("claude-code", "ephemeralProcess", {
      data: response(
        claudeCodeFixture({
          fiveHour: rlWindow(12, 300),
          sevenDay: rlWindow(64, 10_080),
        }),
      ),
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 12,
        severity: "healthy",
        degraded: false,
      },
      {
        providerId: "claude-code",
        windowLabel: "Weekly",
        usedPercent: 64,
        severity: "healthy",
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
        claudeCodeFixture({ fiveHour: rlWindow(20, 300), sevenDay: null }),
      ),
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([]);
  });

  it("returns no bars when both are configured but one is still cold (partial load)", () => {
    // Codex loaded, Claude Code still cold -> can't fill both slots -> [].
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({
          primary: rlWindow(50, 300),
          secondary: rlWindow(10, 10_080),
        }),
      ),
      isError: false,
    });
    setProvider("claude-code", "ephemeralProcess", {
      data: undefined,
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
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
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([]);
  });

  it("returns no bars for the unavailable arm", () => {
    setProvider("codex", "ephemeralProcess", {
      data: response(unavailableFixture()),
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([]);
  });

  it("marks both of a single provider's bars degraded when the latest poll errored", () => {
    setProvider("codex", "ephemeralProcess", {
      data: response(
        codexFixture({
          primary: rlWindow(65, 300),
          secondary: rlWindow(15, 10_080),
        }),
      ),
      isError: true,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 65,
        severity: "healthy",
        degraded: true,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 15,
        severity: "healthy",
        degraded: true,
      },
    ]);
  });

  it("shows the retained last-good reading dimmed when the envelope's latest is a transient failure (not a thrown isError)", () => {
    // Distinct from the test above: `isError` is false here (the RPC itself
    // succeeded) - the envelope's own `latest` reports `usage_fetch_failed`
    // while `lastGood` retains an earlier good reading. The glyph should
    // still show that retained reading, marked degraded.
    setProvider("codex", "ephemeralProcess", {
      data: {
        latest: {
          provider: "codex",
          available: false,
          reason: "usage_fetch_failed",
        },
        lastGood: codexFixture({
          primary: rlWindow(65, 300),
          secondary: rlWindow(15, 10_080),
        }),
        lastGoodAt: Date.now() - 90_000,
        lastFailureAt: Date.now() - 1_000,
      },
      isError: false,
    });
    const { result } = renderHeaderRateLimitBars();
    expect(result.current).toEqual([
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 65,
        severity: "healthy",
        degraded: true,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 15,
        severity: "healthy",
        degraded: true,
      },
    ]);
  });
});
