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
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

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
  /** Keyed by `providerId` or, for one account's reading, `providerId:profileId`. */
  results: Map<string, MockQueryResult>;
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
      mocks.results.get(
        `${request.params.providerId}:${request.params.profileId ?? ""}`,
      ) ??
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
  type StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { SAMPLE_ACCOUNT_LABEL } from "@/components/sample-workspace/sample-workspace-scene";

const PROFILE_SELECTION: RateLimitProfileSelection = {
  shownProfiles: {},
  lastProfileByHarness: {},
};

function renderSegments(providers: ReadonlyArray<ConfiguredRateLimitProvider>) {
  return renderSegmentsFor(providers, PROFILE_SELECTION, false);
}

function renderSegmentsFor(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  profileSelection: RateLimitProfileSelection,
  sample: boolean,
) {
  return renderHook(() => {
    // The batches describe ONE render. The hook samples the clock through
    // `useSampledNow`, whose cold start notifies its first subscriber and so
    // re-renders it once; a per-batch assertion that counted across renders
    // would double, and the doubling would be about the clock, not the lanes.
    mocks.batches = [];
    return useStatusBarRateLimitSegments({
      providers,
      profileSelection,
      mode: "live",
      editing: false,
      sample,
    });
  });
}

function renderSampleSegments(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  profileSelection: RateLimitProfileSelection,
) {
  return renderSegmentsFor(providers, profileSelection, true);
}

function profileFixture(
  profileId: string,
  kind: ProviderProfile["kind"],
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label: kind === "ambient" ? "Terminal" : profileId,
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
    accentColor: null,
    ambientDriftNotice: null,
  };
}

/** Codex with an ambient login and two managed accounts, host order. */
function codexWithAccounts(): ConfiguredRateLimitProvider {
  return configuredProvider({
    providerId: "codex",
    lane: "ephemeralProcess",
    profiles: [
      profileFixture("ambient", "ambient"),
      profileFixture("personal", "managed"),
      profileFixture("work", "managed"),
    ],
  });
}

function segmentIdentities(
  cluster: StatusBarRateLimitCluster,
): ReadonlyArray<readonly [string, string | null]> {
  return cluster.kind === "segments"
    ? cluster.segments.map(
        (segment) => [segment.providerId, segment.profileId] as const,
      )
    : [];
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
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

describe("useStatusBarRateLimitSegments", () => {
  describe("per-provider limit selection", () => {
    function codexSelection(selection: {
      readonly limitKeys: ReadonlyArray<string>;
    }): void {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        providerLimits: { codex: selection },
      });
    }

    function codexSegment(result: {
      readonly current: { readonly cluster: StatusBarRateLimitCluster };
    }) {
      const cluster = result.current.cluster;
      if (cluster.kind !== "segments") throw new Error(cluster.kind);
      return cluster.segments[0];
    }

    function windowKeys(
      windows: ReadonlyArray<{ readonly windowKey: string }>,
    ): ReadonlyArray<string> {
      return windows.map((window) => window.windowKey);
    }

    beforeEach(() => {
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 40, resetsAt: null }),
            secondary: rlWindow({ usedPercent: 20, resetsAt: null }),
          }),
        ),
        isError: false,
      });
    });

    it("shows the tightest alone by default, with every live window still listed", () => {
      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      const segment = codexSegment(result);
      expect(windowKeys(segment.windows)).toEqual([
        "codex:primary",
        "codex:secondary",
      ]);
      expect(windowKeys(segment.shown)).toEqual(["codex:primary"]);
      expect(segment.tightest?.windowKey).toBe("codex:primary");
    });

    it("shows the explicit picks alone when there are any, judged by the tightest of THOSE", () => {
      codexSelection({ limitKeys: ["codex:secondary"] });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      const segment = codexSegment(result);
      expect(windowKeys(segment.shown)).toEqual(["codex:secondary"]);
      expect(segment.tightest?.windowKey).toBe("codex:secondary");
    });

    // The two cases this used to cover - a union of the automatic entry with a
    // pick, and the tightest being drawn once when it is also picked - were
    // both about a selection that said `automatic: true` AND named a window.
    // That selection no longer exists: an empty pick list IS Automatic
    // (R1-15), so there is one list to draw and no union to de-duplicate. What
    // survives of the pair is the ORDER claim, which is the filter's own.
    it("draws explicit picks in catalog order rather than pick order", () => {
      codexSelection({ limitKeys: ["codex:secondary", "codex:primary"] });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(windowKeys(codexSegment(result).shown)).toEqual([
        "codex:primary",
        "codex:secondary",
      ]);
    });

    it("ignores a pick the provider is not reporting while another pick is live", () => {
      codexSelection({
        limitKeys: ["codex:extra:gone:primary", "codex:secondary"],
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(windowKeys(codexSegment(result).shown)).toEqual([
        "codex:secondary",
      ]);
    });

    // A provider whose every pick has gone stale is still judged rather than
    // vanishing from the strip with nothing in Settings saying why.
    it("falls back to the tightest when no pick is live", () => {
      codexSelection({
        limitKeys: ["codex:extra:gone:primary"],
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      const segment = codexSegment(result);
      expect(windowKeys(segment.shown)).toEqual(["codex:primary"]);
      expect(segment.tightest?.windowKey).toBe("codex:primary");
    });

    it("re-resolves automatic against the live windows, so an expired tightest gives way", () => {
      const now = Date.now();
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 90, resetsAt: now - 60_000 }),
            secondary: rlWindow({ usedPercent: 20, resetsAt: now + 1_000_000 }),
          }),
        ),
        isError: false,
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(windowKeys(codexSegment(result).shown)).toEqual([
        "codex:secondary",
      ]);
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
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      hiddenProviders: ["codex"],
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

  describe("accounts", () => {
    function codexReading(usedPercent: number): MockQueryResult {
      return {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent, resetsAt: null }),
          }),
        ),
        isError: false,
      };
    }

    it("draws one segment per checked account, in profile order with ambient last, each on its own reading", () => {
      mocks.results.set("codex:work", codexReading(70));
      mocks.results.set("codex:", codexReading(10));
      mocks.results.set("codex:personal", codexReading(40));

      const { result } = renderSegmentsFor(
        [codexWithAccounts()],
        {
          shownProfiles: { codex: [null, "work"] },
          lastProfileByHarness: {},
        },
        false,
      );

      expect(segmentIdentities(result.current.cluster)).toEqual([
        ["codex", "work"],
        ["codex", null],
      ]);
      const segments =
        result.current.cluster.kind === "segments"
          ? result.current.cluster.segments
          : [];
      expect(segments.map((segment) => segment.tightest?.usedPercent)).toEqual([
        70, 10,
      ]);
      // Each carries the profile's own identity mark, the ambient row's too.
      expect(segments.map((segment) => segment.account?.label)).toEqual([
        "work",
        "Terminal",
      ]);
      // And each is its own query, mount target and refresh target.
      expect(mocks.batches[0].requests).toEqual([
        { providerId: "codex", profileId: "work" },
        { providerId: "codex", profileId: null },
      ]);
      expect(
        result.current.refresh.ephemeralTargets.map(
          (target) => target.profileId,
        ),
      ).toEqual(["work", null]);
      expect(
        result.current.mountTargets.map((target) => target.profileId),
      ).toEqual(["work", null]);
    });

    it("draws one last-used segment when nothing is checked, and skips a checked id that no longer exists", () => {
      mocks.results.set("codex:personal", codexReading(40));

      const nothingChecked = renderSegmentsFor(
        [codexWithAccounts()],
        {
          shownProfiles: {},
          lastProfileByHarness: { codex: "personal" },
        },
        false,
      );
      expect(segmentIdentities(nothingChecked.result.current.cluster)).toEqual([
        ["codex", "personal"],
      ]);
      nothingChecked.unmount();

      const stale = renderSegmentsFor(
        [codexWithAccounts()],
        {
          shownProfiles: { codex: ["removed", "personal"] },
          lastProfileByHarness: {},
        },
        false,
      );
      expect(segmentIdentities(stale.result.current.cluster)).toEqual([
        ["codex", "personal"],
      ]);
    });

    it("carries no identity mark for a provider with fewer than two profiles", () => {
      mocks.results.set("codex:work", codexReading(40));
      const { result } = renderSegmentsFor(
        [
          configuredProvider({
            providerId: "codex",
            lane: "ephemeralProcess",
            profiles: [profileFixture("work", "managed")],
          }),
        ],
        { shownProfiles: { codex: ["work"] }, lastProfileByHarness: {} },
        false,
      );
      const segments =
        result.current.cluster.kind === "segments"
          ? result.current.cluster.segments
          : [];
      expect(segments.map((segment) => segment.profileId)).toEqual(["work"]);
      expect(segments.map((segment) => segment.account)).toEqual([null]);
    });

    it("keeps one provider's accounts in resolved order across the http lane's eligibility split", () => {
      // Two OpenCode accounts, both checked, the FIRST signed out: it lands
      // in the observed batch while the second polls, and the recombination
      // must put them back as resolved - not eligible-first.
      const signedOut: ProviderProfile = {
        ...profileFixture("first", "managed"),
        auth: {
          status: "unauthenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
      };
      const provider = configuredProvider({
        providerId: "opencode",
        lane: "httpFetch",
        profiles: [signedOut, profileFixture("second", "managed")],
      });
      const reading: MockQueryResult = {
        data: freshEnvelope(
          opencodeRateLimits({
            fiveHour: opencodeWindow(5),
            weekly: opencodeWindow(5),
            monthly: opencodeWindow(5),
          }),
        ),
        isError: false,
      };
      mocks.results.set("opencode:first", reading);
      mocks.results.set("opencode:second", reading);

      const { result } = renderSegmentsFor(
        [provider],
        {
          shownProfiles: { opencode: ["first", "second"] },
          lastProfileByHarness: {},
        },
        false,
      );

      // The split happened: one target per http batch.
      expect(
        mocks.batches
          .filter((batch) => batch.requests.length === 1)
          .map((batch) => batch.requests[0].profileId),
      ).toEqual(["second", "first"]);
      // And the strip still draws them as resolved.
      expect(segmentIdentities(result.current.cluster)).toEqual([
        ["opencode", "first"],
        ["opencode", "second"],
      ]);
    });

    it("swaps the whole set when the selection changes host", () => {
      mocks.results.set("codex:work", codexReading(70));
      mocks.results.set("codex:personal", codexReading(40));
      const hostA: RateLimitProfileSelection = {
        shownProfiles: { codex: ["work"] },
        lastProfileByHarness: {},
      };
      const hostB: RateLimitProfileSelection = {
        shownProfiles: { codex: ["personal"] },
        lastProfileByHarness: {},
      };
      const { result, rerender } = renderHook(
        (props: { readonly selection: RateLimitProfileSelection }) =>
          useStatusBarRateLimitSegments({
            providers: [codexWithAccounts()],
            profileSelection: props.selection,
            mode: "live",
            editing: false,
            sample: false,
          }),
        { initialProps: { selection: hostA } },
      );
      expect(segmentIdentities(result.current.cluster)).toEqual([
        ["codex", "work"],
      ]);
      rerender({ selection: hostB });
      expect(segmentIdentities(result.current.cluster)).toEqual([
        ["codex", "personal"],
      ]);
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
            periodType: "USAGE_PERIOD_TYPE_MONTHLY",
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
                // The strip's word for the MONTHLY period type. The payload
                // states no duration, so the label comes from the catalog's
                // period-type table, which carries the compact vocabulary.
                label: "mo",
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
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        hiddenProviders: ["codex"],
      });

      const { result } = renderSegments([
        configuredProvider({ providerId: "codex", lane: "ephemeralProcess" }),
      ]);

      expect(result.current.cluster).toEqual({ kind: "hidden" });
    });

    it("is hidden when every window of every provider has expired", () => {
      const now = Date.now();
      setResult("codex", {
        data: freshEnvelope(
          codexRateLimits({
            primary: rlWindow({ usedPercent: 10, resetsAt: now - 60_000 }),
          }),
        ),
        isError: false,
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

describe("useStatusBarRateLimitSegments - sample scene", () => {
  function claudeSegment(result: {
    readonly current: { readonly cluster: StatusBarRateLimitCluster };
  }) {
    const cluster = result.current.cluster;
    if (cluster.kind !== "segments") throw new Error(cluster.kind);
    return cluster.segments[0];
  }

  function windowKeys(
    windows: ReadonlyArray<{ readonly windowKey: string }>,
  ): ReadonlyArray<string> {
    return windows.map((window) => window.windowKey);
  }

  function claudeSelection(limitKeys: ReadonlyArray<string>): void {
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      providerLimits: { "claude-code": { limitKeys } },
    });
  }

  it.each<{ readonly name: string; readonly picks: ReadonlyArray<string> }>([
    {
      name: "a weekly key",
      picks: ["claude-code:sevenDay"],
    },
    {
      name: "two windows",
      picks: ["claude-code:fiveHour", "claude-code:sevenDayOpus"],
    },
  ])(
    "shows exactly the picked windows, under the keys it picked, when the selection names $name",
    ({ picks }) => {
      claudeSelection(picks);

      const { result } = renderSampleSegments(
        [
          configuredProvider({
            providerId: "claude-code",
            lane: "ephemeralProcess",
          }),
        ],
        PROFILE_SELECTION,
      );

      expect(windowKeys(claudeSegment(result).shown)).toEqual(picks);
    },
  );

  it("falls back to the tightest sample window when the selection is Automatic", () => {
    const { result } = renderSampleSegments(
      [
        configuredProvider({
          providerId: "claude-code",
          lane: "ephemeralProcess",
        }),
      ],
      PROFILE_SELECTION,
    );

    // The first segment reads sample slots 0-3 (35%, 78%, 84%, 35%), so the
    // Opus window at 84% is the one the sample scene makes tightest.
    expect(windowKeys(claudeSegment(result).shown)).toEqual([
      "claude-code:sevenDayOpus",
    ]);
  });

  it("relabels a real account to the sample label", () => {
    const selection: RateLimitProfileSelection = {
      shownProfiles: { codex: ["personal"] },
      lastProfileByHarness: {},
    };

    const { result } = renderSampleSegments([codexWithAccounts()], selection);

    const cluster = result.current.cluster;
    if (cluster.kind !== "segments") throw new Error(cluster.kind);
    expect(cluster.segments[0]?.profileId).toBe("personal");
    expect(cluster.segments[0]?.account).toMatchObject({
      profileId: "personal",
      label: SAMPLE_ACCOUNT_LABEL,
    });
  });

  it("draws no segment for a provider with no sample windows, never its real reading or account", () => {
    setResult("antigravity", {
      data: freshEnvelope({
        provider: "antigravity",
        available: true,
        planName: "Google AI Pro",
        groups: [
          {
            displayName: "Gemini Models",
            description: null,
            windows: [
              {
                usedPercent: 91,
                resetsAt: Date.now() + 3_600_000,
                durationMinutes: 300,
                bucketId: "gemini-5h",
                windowKind: "5h",
              },
            ],
          },
        ],
      }),
      isError: false,
    });
    const selection: RateLimitProfileSelection = {
      shownProfiles: { antigravity: ["real-account"] },
      lastProfileByHarness: {},
    };

    const { result } = renderSampleSegments(
      [
        configuredProvider({
          providerId: "claude-code",
          lane: "ephemeralProcess",
        }),
        configuredProvider({
          providerId: "antigravity",
          lane: "httpFetch",
          profiles: [
            profileFixture("ambient", "ambient"),
            profileFixture("real-account", "managed"),
          ],
        }),
      ],
      selection,
    );

    expect(segmentIdentities(result.current.cluster)).toEqual([
      ["claude-code", null],
    ]);
  });

  it("reports live even when the query behind it is cold", () => {
    const { result } = renderSampleSegments(
      [
        configuredProvider({
          providerId: "claude-code",
          lane: "ephemeralProcess",
        }),
      ],
      PROFILE_SELECTION,
    );

    const segment = claudeSegment(result);
    expect(segment.state).toBe("live");
    expect(segment.reason).toBeNull();
  });

  it("leaves a cold provider cold when the sample scene is off", () => {
    const { result } = renderSegments([
      configuredProvider({
        providerId: "claude-code",
        lane: "ephemeralProcess",
      }),
    ]);

    const segment = claudeSegment(result);
    expect(segment.state).toBe("cold");
    expect(segment.windows).toEqual([]);
  });
});
