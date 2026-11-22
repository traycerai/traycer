import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import { NO_EPISODE } from "@/lib/rate-limits/rate-limit-envelope";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

interface MockQueryResult {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isError: boolean;
}

interface MockState {
  providers: ProvidersListResponse["providers"];
  results: Map<RateLimitProviderId, MockQueryResult>;
  /** Whether the host has answered with a list at all. */
  answered: boolean;
}

const mocks = vi.hoisted<MockState>(() => ({
  providers: [],
  results: new Map(),
  answered: true,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: mocks.answered ? { providers: mocks.providers } : undefined,
  }),
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
  // The SPINE, a separate export.
  useHostRuntimeClient: () => null,
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
  useRateLimitAccountInventory,
  useVisibleRateLimitProviders,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";

const NOW = Date.now();

function auth(status: ProviderAuthStatus): ProviderCliState["auth"] {
  return { status, badgeText: null, label: null, detail: null };
}

function providerState(args: {
  readonly providerId: ProviderId;
  readonly status: ProviderAuthStatus;
  readonly enabled: boolean;
  readonly authPending: boolean;
  readonly availabilityPending: boolean;
  readonly usageReporting: boolean | undefined;
}): ProvidersListResponse["providers"][number] {
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
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    profiles: [],
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    ...(args.usageReporting === undefined
      ? {}
      : { usageReporting: args.usageReporting }),
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
    credentialGeneration: null,
    episode: NO_EPISODE,
  };
}

beforeEach(() => {
  mocks.providers = [];
  mocks.results = new Map();
  mocks.answered = true;
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
        usageReporting: true,
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
        usageReporting: true,
      }),
    ];
    mocks.results.set("codex", {
      data: envelope(codexLimits()),
      isError: false,
    });

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        authStatus: "unavailable",
        usageReportingConfirmed: true,
        profiles: [],
        fetchEligibility: { ambient: false, managedProfiles: true },
      },
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
        usageReporting: true,
      }),
    ];

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        authStatus: "authenticated",
        usageReportingConfirmed: true,
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
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
        usageReporting: true,
      }),
    ];
    mocks.results.set("codex", { data: undefined, isError: true });

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        authStatus: "unavailable",
        usageReportingConfirmed: true,
        profiles: [],
        fetchEligibility: { ambient: false, managedProfiles: true },
      },
    ]);
  });

  it("includes an enabled usage-reporting provider with no cache state", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "unavailable",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: true,
      }),
    ];

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current.map((provider) => provider.providerId)).toEqual([
      "codex",
    ]);
  });

  it("keeps an enabled reporting provider visible when the fetch map has no lane", () => {
    const providerId: ProviderId = "qwen";
    mocks.providers = [
      {
        ...providerState({
          providerId: "codex",
          status: "authenticated",
          enabled: true,
          authPending: false,
          availabilityPending: false,
          usageReporting: true,
        }),
        providerId,
      },
    ];

    const visible = renderHook(() => useVisibleRateLimitProviders());
    const configured = renderHook(() => useConfiguredRateLimitProviders());

    expect(visible.result.current).toEqual([
      {
        providerId: "qwen",
        lane: null,
        authStatus: "authenticated",
        usageReportingConfirmed: true,
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ]);
    expect(configured.result.current).toEqual([]);
  });

  it("keeps a signed-out provider visible from its last cached usage without making it poll-eligible", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "unauthenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: true,
      }),
    ];
    mocks.results.set("codex", {
      data: envelope(codexLimits()),
      isError: false,
    });

    const visible = renderHook(() => useVisibleRateLimitProviders());
    const configured = renderHook(() => useConfiguredRateLimitProviders());

    expect(visible.result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        authStatus: "unauthenticated",
        usageReportingConfirmed: true,
        profiles: [],
        fetchEligibility: { ambient: false, managedProfiles: true },
      },
    ]);
    expect(configured.result.current).toEqual([]);
  });

  it("keeps an authenticated managed profile visible and queue-eligible while excluding its unauthenticated ambient target", () => {
    const ambient: ProviderProfile = {
      profileId: "ambient",
      enabled: true,
      kind: "ambient",
      authType: "oauth",
      label: "Terminal",
      auth: auth("unauthenticated"),
      identity: null,
      usageUpdatedAt: null,
      rateLimitStatus: "unknown",
      rateLimitLimitedScopes: null,
      duplicateOfProfileId: null,
      accentColor: null,
      ambientDriftNotice: null,
    };
    const managed: ProviderProfile = {
      ...ambient,
      profileId: "work-profile",
      kind: "managed",
      label: "Work",
      auth: auth("authenticated"),
    };
    mocks.providers = [
      {
        ...providerState({
          providerId: "codex",
          status: "unauthenticated",
          enabled: true,
          authPending: true,
          availabilityPending: false,
          usageReporting: true,
        }),
        profiles: [ambient, managed],
      },
    ];

    const visible = renderHook(() => useVisibleRateLimitProviders());
    const configured = renderHook(() => useConfiguredRateLimitProviders());

    expect(visible.result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        authStatus: "unauthenticated",
        usageReportingConfirmed: true,
        profiles: [ambient, managed],
        fetchEligibility: { ambient: false, managedProfiles: true },
      },
    ]);
    expect(configured.result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [ambient, managed],
        fetchEligibility: { ambient: false, managedProfiles: true },
      },
    ]);
  });

  it("preserves every profile when usage reports limits unavailable", () => {
    const profiles: ProviderProfile[] = [
      {
        profileId: "unavailable-account",
        enabled: true,
        kind: "managed",
        authType: "oauth",
        label: "Unavailable account",
        auth: auth("authenticated"),
        identity: null,
        usageUpdatedAt: null,
        rateLimitStatus: "unknown",
        rateLimitLimitedScopes: null,
        duplicateOfProfileId: null,
        accentColor: null,
        ambientDriftNotice: null,
      },
      {
        profileId: "sibling-account",
        enabled: true,
        kind: "managed",
        authType: "oauth",
        label: "Sibling account",
        auth: auth("authenticated"),
        identity: null,
        usageUpdatedAt: null,
        rateLimitStatus: "unknown",
        rateLimitLimitedScopes: null,
        duplicateOfProfileId: null,
        accentColor: null,
        ambientDriftNotice: null,
      },
    ];
    mocks.providers = [
      {
        ...providerState({
          providerId: "opencode",
          status: "authenticated",
          enabled: true,
          authPending: false,
          availabilityPending: false,
          usageReporting: true,
        }),
        profiles,
      },
    ];
    mocks.results.set("opencode", {
      data: {
        latest: {
          provider: "opencode",
          available: false,
          reason: "rate_limits_not_available",
        },
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: NOW,
        credentialGeneration: null,
        episode: NO_EPISODE,
      },
      isError: false,
    });

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      {
        providerId: "opencode",
        lane: "httpFetch",
        authStatus: "authenticated",
        usageReportingConfirmed: true,
        profiles,
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ]);
  });

  it("excludes explicitly false and disabled providers", () => {
    mocks.providers = [
      providerState({
        providerId: "qwen",
        status: "authenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: false,
      }),
      {
        ...providerState({
          providerId: "codex",
          status: "authenticated",
          enabled: false,
          authPending: false,
          availabilityPending: false,
          usageReporting: true,
        }),
      },
    ];

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([]);
  });

  it("uses enum membership and marks usage reporting unconfirmed for old hosts", () => {
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "authenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: undefined,
      }),
      providerState({
        providerId: "qwen",
        status: "authenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: undefined,
      }),
    ];

    const visible = renderHook(() => useVisibleRateLimitProviders());
    const configured = renderHook(() => useConfiguredRateLimitProviders());

    expect(visible.result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        authStatus: "authenticated",
        usageReportingConfirmed: false,
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ]);
    expect(configured.result.current).toEqual([
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ]);
  });

  it("keeps OpenCode visible for insufficient_permissions", () => {
    mocks.providers = [
      providerState({
        providerId: "opencode",
        status: "authenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: true,
      }),
    ];
    mocks.results.set("opencode", {
      data: {
        latest: {
          provider: "opencode",
          available: false,
          reason: "insufficient_permissions",
        },
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: NOW,
        credentialGeneration: null,
        episode: NO_EPISODE,
      },
      isError: false,
    });

    const { result } = renderHook(() => useVisibleRateLimitProviders());

    expect(result.current).toEqual([
      {
        providerId: "opencode",
        lane: "httpFetch",
        authStatus: "authenticated",
        usageReportingConfirmed: true,
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ]);
  });
});

describe("useRateLimitAccountInventory", () => {
  it("retains the same mapped account profiles as usage-reporting capability changes", () => {
    const profiles: ProviderProfile[] = [
      {
        profileId: "terminal",
        enabled: true,
        kind: "ambient",
        authType: "oauth",
        label: "Terminal",
        auth: auth("authenticated"),
        identity: null,
        usageUpdatedAt: null,
        rateLimitStatus: "unknown",
        rateLimitLimitedScopes: null,
        duplicateOfProfileId: null,
        accentColor: null,
        ambientDriftNotice: null,
      },
      {
        profileId: "work-profile",
        enabled: true,
        kind: "managed",
        authType: "oauth",
        label: "Work",
        auth: auth("authenticated"),
        identity: null,
        usageUpdatedAt: null,
        rateLimitStatus: "unknown",
        rateLimitLimitedScopes: null,
        duplicateOfProfileId: null,
        accentColor: null,
        ambientDriftNotice: null,
      },
    ];
    const setCapability = (usageReporting: boolean | undefined): void => {
      mocks.providers = [
        {
          ...providerState({
            providerId: "codex",
            status: "authenticated",
            enabled: true,
            authPending: false,
            availabilityPending: false,
            usageReporting,
          }),
          profiles,
        },
      ];
    };
    setCapability(true);

    const { result, rerender } = renderHook(() => ({
      visible: useVisibleRateLimitProviders(),
      inventory: useRateLimitAccountInventory(),
    }));
    const expectedInventoryProvider = {
      providerId: "codex",
      lane: "ephemeralProcess",
      profiles,
      fetchEligibility: { ambient: true, managedProfiles: true },
    };
    expect(
      result.current.visible.map((provider) => provider.providerId),
    ).toEqual(["codex"]);
    expect(result.current.inventory.providers).toEqual([
      expectedInventoryProvider,
    ]);

    for (const usageReporting of [false, undefined]) {
      setCapability(usageReporting);
      rerender();
      if (usageReporting === false) {
        expect(result.current.visible).toEqual([]);
      } else {
        expect(
          result.current.visible.map((provider) => provider.providerId),
        ).toEqual(["codex"]);
        expect(result.current.visible[0]?.usageReportingConfirmed).toBe(false);
      }
      expect(result.current.inventory.providers).toEqual([
        expectedInventoryProvider,
      ]);
    }

    setCapability(true);
    rerender();
    expect(
      result.current.visible.map((provider) => provider.providerId),
    ).toEqual(["codex"]);
    expect(result.current.inventory.providers).toEqual([
      expectedInventoryProvider,
    ]);
  });

  it("says nothing while the host has not answered", () => {
    mocks.answered = false;
    mocks.providers = [
      providerState({
        providerId: "codex",
        status: "authenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: true,
      }),
    ];

    const { result } = renderHook(() => useRateLimitAccountInventory());

    // The query has no data, so this host has reported nothing - which is a
    // different fact from a host that has reported no accounts, and the only
    // one that distinguishes them. A caller that ends an account's state on an
    // empty list has to read this.
    expect(result.current).toEqual({ answered: false, providers: [] });
  });

  it("answers with no accounts when the host has none", () => {
    const { result } = renderHook(() => useRateLimitAccountInventory());

    expect(result.current).toEqual({ answered: true, providers: [] });
  });

  it("keeps usage-reporting provider visibility independent from account inventory", () => {
    mocks.providers = [
      providerState({
        providerId: "opencode",
        status: "authenticated",
        enabled: true,
        authPending: false,
        availabilityPending: false,
        usageReporting: true,
      }),
    ];
    // An account-level unavailable snapshot does not affect provider display
    // eligibility or the host's account inventory.
    mocks.results.set("opencode", {
      data: {
        latest: {
          provider: "opencode",
          available: false,
          reason: "rate_limits_not_available",
        },
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: NOW,
        credentialGeneration: null,
        episode: NO_EPISODE,
      },
      isError: false,
    });

    const visible = renderHook(() => useVisibleRateLimitProviders());
    const inventory = renderHook(() => useRateLimitAccountInventory());

    expect(
      visible.result.current.map((provider) => provider.providerId),
    ).toEqual(["opencode"]);
    expect(inventory.result.current.answered).toBe(true);
    expect(
      inventory.result.current.providers.map((provider) => provider.providerId),
    ).toEqual(["opencode"]);
  });
});
