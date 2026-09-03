import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProviderRateLimitTanstackOptions } from "@/hooks/host/provider-rate-limit-query-options";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type {
  RateLimitFetchEligibility,
  RateLimitFetchLane,
  RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

interface MockQueryResult {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isError: boolean;
}

interface RecordedRequest {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
}

interface RecordedBatch {
  readonly requests: ReadonlyArray<RecordedRequest>;
  readonly options: ProviderRateLimitTanstackOptions;
}

interface MockState {
  results: Map<RateLimitProviderId, MockQueryResult>;
  batches: RecordedBatch[];
  windowedProviders: ReadonlyArray<ConfiguredRateLimitProvider>;
}

const mocks = vi.hoisted<MockState>(() => ({
  results: new Map(),
  batches: [],
  windowedProviders: [],
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => null,
}));

vi.mock(
  "@/hooks/rate-limits/use-configured-rate-limit-providers",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-configured-rate-limit-providers")
      >();
    return {
      ...actual,
      useConfiguredRateLimitProviders: () => mocks.windowedProviders,
      useVisibleRateLimitProviders: () => mocks.windowedProviders,
    };
  },
);

vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", () => ({
  resolveRateLimitProfileId: () => null,
}));

// Records EACH batch's `options` and `requests`, in call order, so a test can
// assert per-batch (which lane a provider landed in, and what options that
// exact batch carried) rather than only the flattened final segment list.
function mockUseHostQueriesImpl(args: {
  readonly requests: ReadonlyArray<{
    readonly params: {
      readonly providerId: RateLimitProviderId;
      readonly profileId: string | null;
    };
  }>;
  readonly options: ProviderRateLimitTanstackOptions;
}) {
  mocks.batches.push({
    requests: args.requests.map((request) => ({
      providerId: request.params.providerId,
      profileId: request.params.profileId,
    })),
    options: args.options,
  });
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

import {
  useStatusBarRateLimitSegments,
  useStatusBarWindowedProviders,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";

const PROFILE_SELECTION = {
  activeChatSettings: null,
  lastProfileByHarness: {},
};

function renderSegments(providers: ReadonlyArray<ConfiguredRateLimitProvider>) {
  return renderHook(() =>
    useStatusBarRateLimitSegments({
      providers,
      profileSelection: PROFILE_SELECTION,
    }),
  );
}

function renderWindowedProviders() {
  return renderHook(() => useStatusBarWindowedProviders());
}

function configuredProvider(input: {
  readonly providerId: RateLimitProviderId;
  readonly lane: RateLimitFetchLane;
  readonly fetchEligibility?: RateLimitFetchEligibility;
  readonly profiles?: ReadonlyArray<ProviderProfile>;
}): ConfiguredRateLimitProvider {
  return {
    providerId: input.providerId,
    lane: input.lane,
    profiles: input.profiles ?? [],
    fetchEligibility: input.fetchEligibility ?? {
      ambient: true,
      managedProfiles: true,
    },
  };
}

function rlWindow(input: {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes?: number | null;
}): ProviderRateLimitWindow {
  return {
    usedPercent: input.usedPercent,
    resetsAt: input.resetsAt,
    durationMinutes: input.durationMinutes ?? null,
  };
}

/** A Codex `extraWindows` entry, shaped by hand since the wire exports no name for it. */
interface CodexExtraWindowFixture {
  readonly limitId: string;
  readonly limitName: string | null;
  readonly primary: ProviderRateLimitWindow | null;
  readonly secondary: ProviderRateLimitWindow | null;
}

function codexRateLimits(overrides: {
  readonly primary?: ProviderRateLimitWindow | null;
  readonly secondary?: ProviderRateLimitWindow | null;
  readonly extraWindows?: ReadonlyArray<CodexExtraWindowFixture>;
}): AvailableProviderRateLimits {
  return {
    provider: "codex",
    available: true,
    planType: null,
    limitId: null,
    limitName: null,
    primary: overrides.primary ?? null,
    secondary: overrides.secondary ?? null,
    extraWindows: [...(overrides.extraWindows ?? [])],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
}

/** A Claude Code model-scoped window - the display name is its only identity. */
interface ClaudeModelScopedWindowFixture {
  readonly displayName: string;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes: number | null;
}

function claudeCodeRateLimits(overrides: {
  readonly fiveHour?: ProviderRateLimitWindow | null;
  readonly sevenDay?: ProviderRateLimitWindow | null;
  readonly modelScoped?: ReadonlyArray<ClaudeModelScopedWindowFixture>;
}): AvailableProviderRateLimits {
  return {
    provider: "claude-code",
    available: true,
    subscriptionType: null,
    fiveHour: overrides.fiveHour ?? null,
    sevenDay: overrides.sevenDay ?? null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    modelScoped: [...(overrides.modelScoped ?? [])],
    extraUsage: null,
  };
}

function cursorRateLimits(overrides: {
  readonly cursorModels: ProviderRateLimitWindow | null;
  readonly otherModels: ProviderRateLimitWindow | null;
}): AvailableProviderRateLimits {
  return {
    provider: "cursor",
    available: true,
    cycleStart: 1_000_000,
    cycleEnd: 2_000_000,
    cursorModels: overrides.cursorModels,
    otherModels: overrides.otherModels,
    includedLimitUsd: 20,
    usedUsd: 7.6,
    remainingUsd: 12.4,
    bonusUsedUsd: null,
    onDemandLimitType: null,
    onDemandLimitUsd: null,
    onDemandUsedUsd: null,
    onDemandRemainingUsd: null,
    displayMessage: null,
  };
}

function grokRateLimits(overrides: {
  readonly periodType: string | null;
  readonly period: ProviderRateLimitWindow | null;
}): AvailableProviderRateLimits {
  return {
    provider: "grok",
    available: true,
    subscriptionTier: "premium",
    periodType: overrides.periodType,
    periodStart: 1_000_000,
    periodEnd: 2_000_000,
    period: overrides.period,
    monthlyLimit: null,
    onDemandCap: null,
    onDemandUsed: null,
    prepaidBalance: null,
  };
}

function opencodeRateLimits(overrides: {
  readonly fiveHour: ProviderRateLimitWindow & {
    readonly status: "ok" | "rate-limited";
  };
  readonly weekly: ProviderRateLimitWindow & {
    readonly status: "ok" | "rate-limited";
  };
  readonly monthly: ProviderRateLimitWindow & {
    readonly status: "ok" | "rate-limited";
  };
}): AvailableProviderRateLimits {
  return {
    provider: "opencode",
    available: true,
    credentialGeneration: "gen-1",
    fiveHour: overrides.fiveHour,
    weekly: overrides.weekly,
    monthly: overrides.monthly,
  };
}

function unavailableRateLimits(input: {
  readonly provider: RateLimitProviderId;
  readonly reason: RateLimitUnavailableReason;
}): ProviderRateLimits {
  return { provider: input.provider, available: false, reason: input.reason };
}

function freshEnvelope(
  rateLimits: ProviderRateLimits,
): ProviderRateLimitEnvelope {
  return {
    latest: rateLimits,
    lastGood: rateLimits.available ? rateLimits : null,
    lastGoodAt: rateLimits.available ? Date.now() : null,
    lastFailureAt: null,
  };
}

function setResult(
  providerId: RateLimitProviderId,
  result: MockQueryResult,
): void {
  mocks.results.set(providerId, result);
}

function opencodeWindow(usedPercent: number): ProviderRateLimitWindow & {
  readonly status: "ok" | "rate-limited";
} {
  return { usedPercent, resetsAt: null, durationMinutes: null, status: "ok" };
}

beforeEach(() => {
  mocks.results = new Map();
  mocks.batches = [];
  mocks.windowedProviders = [];
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
});

describe("useStatusBarRateLimitSegments", () => {
  it("drops a window whose key is in the hidden-window deny-list but keeps its siblings", () => {
    setResult("codex", {
      data: freshEnvelope(
        codexRateLimits({
          primary: rlWindow({ usedPercent: 40, resetsAt: null }),
          secondary: rlWindow({ usedPercent: 20, resetsAt: null }),
        }),
      ),
      isError: false,
    });
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          hiddenWindowKeys: ["codex:primary"],
        },
      },
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({
      kind: "segments",
      segments: [
        expect.objectContaining({
          providerId: "codex",
          windows: [expect.objectContaining({ windowKey: "codex:secondary" })],
        }),
      ],
    });
  });

  it("drops a whole provider that is in the hidden-provider deny-list", () => {
    setResult("codex", {
      data: freshEnvelope(
        codexRateLimits({
          primary: rlWindow({ usedPercent: 40, resetsAt: null }),
        }),
      ),
      isError: false,
    });
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          hiddenProviders: ["codex"],
        },
      },
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({ kind: "hidden" });
  });

  it("drops a window whose reset instant has already passed, keeping a live sibling", () => {
    const now = Date.now();
    setResult("codex", {
      data: freshEnvelope(
        codexRateLimits({
          primary: rlWindow({ usedPercent: 50, resetsAt: now - 60_000 }),
          secondary: rlWindow({ usedPercent: 20, resetsAt: now + 1_000_000 }),
        }),
      ),
      isError: false,
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({
      kind: "segments",
      segments: [
        expect.objectContaining({
          windows: [expect.objectContaining({ windowKey: "codex:secondary" })],
        }),
      ],
    });
    expect(
      (result.current.cluster.kind === "segments"
        ? result.current.cluster.segments[0]?.tightest
        : null
      )?.windowKey,
    ).toBe("codex:secondary");
  });

  it("treats a null resetsAt as always live", () => {
    setResult("codex", {
      data: freshEnvelope(
        codexRateLimits({
          primary: rlWindow({ usedPercent: 50, resetsAt: null }),
        }),
      ),
      isError: false,
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({
      kind: "segments",
      segments: [
        expect.objectContaining({
          windows: [expect.objectContaining({ windowKey: "codex:primary" })],
        }),
      ],
    });
  });

  describe("tightest window", () => {
    it("prefers the higher used percentage", () => {
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 40, resetsAt: null }),
            secondary: rlWindow({ usedPercent: 90, resetsAt: null }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(
        (result.current.cluster.kind === "segments"
          ? result.current.cluster.segments[0]?.tightest
          : null
        )?.windowKey,
      ).toBe("codex:secondary");
    });

    it("breaks an equal percentage tie on the sooner reset", () => {
      const now = Date.now();
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 50, resetsAt: now + 500_000 }),
            secondary: rlWindow({ usedPercent: 50, resetsAt: now + 100_000 }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(
        (result.current.cluster.kind === "segments"
          ? result.current.cluster.segments[0]?.tightest
          : null
        )?.windowKey,
      ).toBe("codex:secondary");
    });

    it("prefers a window with a known reset over one with none, at an equal percentage", () => {
      const now = Date.now();
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 50, resetsAt: null }),
            secondary: rlWindow({ usedPercent: 50, resetsAt: now + 100_000 }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(
        (result.current.cluster.kind === "segments"
          ? result.current.cluster.segments[0]?.tightest
          : null
        )?.windowKey,
      ).toBe("codex:secondary");
    });

    it("keeps the catalog-order-first window on a full tie", () => {
      const now = Date.now();
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 50, resetsAt: now + 100_000 }),
            secondary: rlWindow({ usedPercent: 50, resetsAt: now + 100_000 }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(
        (result.current.cluster.kind === "segments"
          ? result.current.cluster.segments[0]?.tightest
          : null
        )?.windowKey,
      ).toBe("codex:primary");
    });
  });

  it("is degraded with the wire reason when the envelope's latest is a transient failure retaining lastGood", () => {
    setResult("codex", {
      data: {
        latest: unavailableRateLimits({
          provider: "codex",
          reason: "usage_fetch_failed",
        }),
        lastGood: codexRateLimits({
          primary: rlWindow({ usedPercent: 65, resetsAt: null }),
        }),
        lastGoodAt: Date.now() - 90_000,
        lastFailureAt: Date.now() - 1_000,
      },
      isError: false,
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({
      kind: "segments",
      segments: [
        expect.objectContaining({
          state: "degraded",
          reason: "usage_fetch_failed",
        }),
      ],
    });
  });

  it("is degraded with a null reason when the query itself errored over retained data", () => {
    setResult("codex", {
      data: freshEnvelope(
        codexRateLimits({
          primary: rlWindow({ usedPercent: 65, resetsAt: null }),
        }),
      ),
      isError: true,
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({
      kind: "segments",
      segments: [expect.objectContaining({ state: "degraded", reason: null })],
    });
  });

  it("is cold when the envelope is undefined", () => {
    setResult("codex", { data: undefined, isError: false });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({
      kind: "segments",
      segments: [expect.objectContaining({ state: "cold", reason: null })],
    });
  });

  it("is unavailable with the wire reason when the retained reading says available: false", () => {
    setResult("codex", {
      data: freshEnvelope(
        unavailableRateLimits({ provider: "codex", reason: "cli_not_found" }),
      ),
      isError: false,
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(result.current.cluster).toEqual({
      kind: "segments",
      segments: [
        expect.objectContaining({
          state: "unavailable",
          reason: "cli_not_found",
        }),
      ],
    });
  });

  it("orders segments codex-before-claude-code-before-opencode regardless of input or batch order", () => {
    setResult("claude-code", {
      data: freshEnvelope(
        claudeCodeRateLimits({
          fiveHour: rlWindow({ usedPercent: 10, resetsAt: null }),
        }),
      ),
      isError: false,
    });
    setResult("codex", {
      data: freshEnvelope(
        codexRateLimits({
          primary: rlWindow({ usedPercent: 20, resetsAt: null }),
        }),
      ),
      isError: false,
    });
    // opencode (httpFetch) lands in a different batch entirely from the two
    // ephemeralProcess providers above - the sort has to run across batches.
    setResult("opencode", {
      data: freshEnvelope(
        opencodeRateLimits({
          fiveHour: opencodeWindow(5),
          weekly: opencodeWindow(5),
          monthly: opencodeWindow(5),
        }),
      ),
      isError: false,
    });

    const { result } = renderSegments([
      configuredProvider({ providerId: "opencode", lane: "httpFetch" }),
      configuredProvider({
        providerId: "claude-code",
        lane: "ephemeralProcess",
      }),
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ]);

    expect(
      result.current.cluster.kind === "segments"
        ? result.current.cluster.segments.map((segment) => segment.providerId)
        : [],
    ).toEqual(["codex", "claude-code", "opencode"]);
  });

  describe("provider fixture coverage", () => {
    it("carries a Claude Code model-scoped window's windowKey, label, and labelIsDuration through the hook", () => {
      const resetsAt = Date.now() + 1_000_000;
      setResult("claude-code", {
        data: freshEnvelope(
          claudeCodeRateLimits({
            modelScoped: [
              {
                displayName: "Fable",
                usedPercent: 57,
                resetsAt,
                durationMinutes: null,
              },
            ],
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({
          providerId: "claude-code",
          lane: "ephemeralProcess",
        }),
      ]);

      expect(result.current.cluster).toEqual({
        kind: "segments",
        segments: [
          expect.objectContaining({
            providerId: "claude-code",
            windows: [
              expect.objectContaining({
                windowKey: "claude-code:model:Fable",
                label: "Fable",
                labelIsDuration: false,
                kind: "model",
              }),
            ],
          }),
        ],
      });
    });

    it("carries a named Codex extra window's label and labelIsDuration through the hook", () => {
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            extraWindows: [
              {
                limitId: "gpt-5-codex",
                limitName: "GPT-5 Codex",
                primary: rlWindow({
                  usedPercent: 9,
                  resetsAt: null,
                  durationMinutes: 300,
                }),
                secondary: null,
              },
            ],
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(result.current.cluster).toEqual({
        kind: "segments",
        segments: [
          expect.objectContaining({
            providerId: "codex",
            windows: [
              expect.objectContaining({
                windowKey: "codex:extra:gpt-5-codex:primary",
                label: "GPT-5 Codex 5h",
                labelIsDuration: false,
              }),
            ],
          }),
        ],
      });
    });

    it("carries both Cursor buckets, which the wire requires to share one reset instant", () => {
      const resetsAt = Date.now() + 2_000_000;
      setResult("cursor", {
        data: freshEnvelope(
          cursorRateLimits({
            cursorModels: rlWindow({ usedPercent: 38, resetsAt }),
            otherModels: rlWindow({ usedPercent: 4, resetsAt }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "cursor", lane: "httpFetch" }),
      ]);

      expect(result.current.cluster).toEqual({
        kind: "segments",
        segments: [
          expect.objectContaining({
            providerId: "cursor",
            windows: [
              expect.objectContaining({
                windowKey: "cursor:cursorModels",
                label: "Cursor models",
                labelIsDuration: false,
                resetsAt,
              }),
              expect.objectContaining({
                windowKey: "cursor:otherModels",
                label: "Other models",
                labelIsDuration: false,
                resetsAt,
              }),
            ],
          }),
        ],
      });
    });

    it("carries grok's billing period, named for the periodType it reports", () => {
      setResult("grok", {
        data: freshEnvelope(
          grokRateLimits({
            periodType: "monthly",
            period: rlWindow({
              usedPercent: 44,
              resetsAt: Date.now() + 2_000_000,
            }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "grok", lane: "httpFetch" }),
      ]);

      expect(result.current.cluster).toEqual({
        kind: "segments",
        segments: [
          expect.objectContaining({
            providerId: "grok",
            windows: [
              expect.objectContaining({
                windowKey: "grok:period",
                label: "monthly",
                labelIsDuration: false,
              }),
            ],
          }),
        ],
      });
    });
  });

  describe("lane split", () => {
    // `resolveTarget` reads `provider.lane` straight off the fixture instead
    // of re-deriving it, so each `configuredProvider({ lane: ... })` below is
    // live input to which batch a target lands in - not dead decoration. Keep
    // every fixture's `lane` truthful to what it claims to be.
    it("keeps every batch single-lane: the ephemeralProcess batch is always passive, the eligible httpFetch batch polls, an ineligible httpFetch target lands in its own third disabled batch", () => {
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 10, resetsAt: null }),
          }),
        ),
        isError: false,
      });
      setResult("opencode", {
        data: freshEnvelope(
          opencodeRateLimits({
            fiveHour: opencodeWindow(5),
            weekly: opencodeWindow(5),
            monthly: opencodeWindow(5),
          }),
        ),
        isError: false,
      });

      renderSegments([
        configuredProvider({
          providerId: "codex",
          lane: "ephemeralProcess",
          fetchEligibility: { ambient: true, managedProfiles: true },
        }),
        configuredProvider({
          providerId: "opencode",
          lane: "httpFetch",
          fetchEligibility: { ambient: true, managedProfiles: true },
        }),
        configuredProvider({
          providerId: "cursor",
          lane: "httpFetch",
          fetchEligibility: { ambient: false, managedProfiles: false },
        }),
      ]);

      expect(mocks.batches).toHaveLength(3);
      const codexBatch = mocks.batches.find((batch) =>
        batch.requests.some((request) => request.providerId === "codex"),
      );
      const opencodeBatch = mocks.batches.find((batch) =>
        batch.requests.some((request) => request.providerId === "opencode"),
      );
      const cursorBatch = mocks.batches.find((batch) =>
        batch.requests.some((request) => request.providerId === "cursor"),
      );

      expect(codexBatch).toBeDefined();
      expect(codexBatch?.requests.map((request) => request.providerId)).toEqual(
        ["codex"],
      );
      expect(codexBatch?.options.enabled).toBe(false);
      expect(codexBatch?.options.poll).toBe(false);
      expect(codexBatch?.options).not.toBeNull();

      expect(opencodeBatch).toBeDefined();
      expect(
        opencodeBatch?.requests.map((request) => request.providerId),
      ).toEqual(["opencode"]);
      expect(opencodeBatch?.options.enabled).toBe(true);
      expect(opencodeBatch?.options.poll).toBe(true);
      expect(opencodeBatch?.options).not.toBeNull();

      expect(cursorBatch).toBeDefined();
      expect(
        cursorBatch?.requests.map((request) => request.providerId),
      ).toEqual(["cursor"]);
      expect(cursorBatch?.options.enabled).toBe(false);
      expect(cursorBatch?.options.poll).toBe(false);
      expect(cursorBatch?.options).not.toBeNull();

      // Every batch is single-lane: no batch's requests mix providerIds from
      // more than one of the three groups above.
      expect(codexBatch).not.toBe(opencodeBatch);
      expect(opencodeBatch).not.toBe(cursorBatch);
      expect(codexBatch).not.toBe(cursorBatch);
    });
  });

  it("includes only fetch-eligible ephemeralProcess targets in mountTargets, never an httpFetch one", () => {
    setResult("codex", {
      data: freshEnvelope(
        codexRateLimits({
          primary: rlWindow({ usedPercent: 10, resetsAt: null }),
        }),
      ),
      isError: false,
    });
    setResult("claude-code", { data: undefined, isError: false });
    setResult("opencode", {
      data: freshEnvelope(
        opencodeRateLimits({
          fiveHour: opencodeWindow(5),
          weekly: opencodeWindow(5),
          monthly: opencodeWindow(5),
        }),
      ),
      isError: false,
    });

    const { result } = renderSegments([
      configuredProvider({
        providerId: "codex",
        lane: "ephemeralProcess",
        fetchEligibility: { ambient: true, managedProfiles: true },
      }),
      configuredProvider({
        providerId: "claude-code",
        lane: "ephemeralProcess",
        fetchEligibility: { ambient: false, managedProfiles: false },
      }),
      configuredProvider({
        providerId: "opencode",
        lane: "httpFetch",
        fetchEligibility: { ambient: true, managedProfiles: true },
      }),
    ]);

    expect(
      result.current.mountTargets.map((target) => target.providerId),
    ).toEqual(["codex"]);
  });

  describe("cluster empty states", () => {
    it("is no-providers with zero configured providers", () => {
      const { result } = renderSegments([]);
      expect(result.current.cluster).toEqual({ kind: "no-providers" });
    });

    it("is hidden when every provider is hidden", () => {
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 10, resetsAt: null }),
          }),
        ),
        isError: false,
      });
      useLayoutStore.setState({
        statusBar: {
          ...DEFAULT_STATUS_BAR_LAYOUT,
          rateLimits: {
            ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
            hiddenProviders: ["codex"],
          },
        },
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(result.current.cluster).toEqual({ kind: "hidden" });
    });

    it("is hidden when every window of every provider is hidden", () => {
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 10, resetsAt: null }),
          }),
        ),
        isError: false,
      });
      useLayoutStore.setState({
        statusBar: {
          ...DEFAULT_STATUS_BAR_LAYOUT,
          rateLimits: {
            ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
            hiddenWindowKeys: ["codex:primary"],
          },
        },
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(result.current.cluster).toEqual({ kind: "hidden" });
    });

    it("is segments otherwise", () => {
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 10, resetsAt: null }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(result.current.cluster.kind).toBe("segments");
    });
  });
});

describe("useStatusBarWindowedProviders", () => {
  it("never includes a credit provider even when configured", () => {
    mocks.windowedProviders = [
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      configuredProvider({ providerId: "openrouter", lane: "httpFetch" }),
      configuredProvider({ providerId: "kilocode", lane: "httpFetch" }),
      configuredProvider({ providerId: "huggingface", lane: "httpFetch" }),
    ];

    const { result } = renderWindowedProviders();

    expect(result.current.map((provider) => provider.providerId)).toEqual([
      "codex",
    ]);
  });

  it("orders providers by ORDERED_PROVIDERS, codex before claude-code, regardless of input order", () => {
    mocks.windowedProviders = [
      configuredProvider({
        providerId: "claude-code",
        lane: "ephemeralProcess",
      }),
      configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
    ];

    const { result } = renderWindowedProviders();

    expect(result.current.map((provider) => provider.providerId)).toEqual([
      "codex",
      "claude-code",
    ]);
  });
});
