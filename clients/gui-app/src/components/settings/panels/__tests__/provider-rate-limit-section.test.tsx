import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { envelopeFromRateLimits } from "@/lib/rate-limits/__tests__/rate-limit-envelope-fixtures";
import { formatResetFullDateTime } from "@/lib/relative-time";

type TurnRefreshCall = {
  readonly providerId: string | null;
  readonly hostId: string | null;
};

const mocks = vi.hoisted(
  (): {
    data: ProviderRateLimitEnvelope | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    isFetching: boolean;
    refetch: Mock<() => Promise<Record<string, never>>>;
    targetPhase: "queued" | "fetching" | null;
    targetForced: boolean;
    followUpExhausted: boolean;
    enqueue: Mock<(...args: unknown[]) => Promise<unknown>>;
    hostId: string;
    turnRefreshCalls: TurnRefreshCall[];
    queueScope: { hostId: string };
    refreshProviders: Mock<() => Promise<void>>;
    refreshProfileStatus: Mock<(...args: unknown[]) => Promise<unknown>>;
    refreshOnMount: Mock<(...args: unknown[]) => void>;
  } => ({
    data: undefined,
    isPending: false,
    isError: false,
    error: undefined,
    isFetching: false,
    refetch: vi.fn(() => Promise.resolve({})),
    targetPhase: null,
    targetForced: false,
    followUpExhausted: false,
    enqueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
    hostId: "host-1",
    turnRefreshCalls: [],
    queueScope: { hostId: "host-b" },
    refreshProviders: vi.fn(() => Promise.resolve()),
    refreshProfileStatus: vi.fn((..._args: unknown[]) => Promise.resolve()),
    refreshOnMount: vi.fn(),
  }),
);

/**
 * The DISPATCHED-but-unheard shape: our response budget elapsed while the host
 * kept running the probe. `fatalDetails: null` is what separates it from a
 * TERMINAL pre-dispatch failure, which shares this class.
 */
function stillRunningRead(): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "no response inside the budget",
    requestId: "req-1",
    method: "host.getRateLimitUsage",
    fatalDetails: null,
  });
}

// A fresh, cold-start envelope wrapping a single response - matches what the
// production `mapResponseToProviderRateLimitEnvelope` wrapper would produce
// for a provider's first successful pull.
function envelope(data: ProviderRateLimits): ProviderRateLimitEnvelope {
  return envelopeFromRateLimits(data, Date.now());
}

vi.mock("@/hooks/host/use-host-provider-rate-limits-query", () => ({
  useHostProviderRateLimitsQuery: () => ({
    data: mocks.data,
    isPending: mocks.isPending,
    isError: mocks.isError,
    error: mocks.error,
    isFetching: mocks.isFetching,
    refetch: mocks.refetch,
  }),
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-turn", () => ({
  useRefreshProviderRateLimitsOnTurn: (
    providerId: string | null,
    hostId: string | null,
  ) => {
    mocks.turnRefreshCalls.push({ providerId, hostId });
  },
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: (...args: unknown[]) => {
    mocks.refreshOnMount(...args);
  },
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mocks.hostId,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-queue-target-phase", () => ({
  useRateLimitQueueTargetPhase: () => mocks.targetPhase,
  useIsRateLimitQueueTargetForced: () => mocks.targetForced,
  useIsRateLimitReadFollowUpExhausted: () => mocks.followUpExhausted,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => mocks.queueScope,
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  enqueueRateLimitFetchForScope: (...args: unknown[]) => mocks.enqueue(...args),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => mocks.refreshProviders,
}));
vi.mock(
  "@/hooks/providers/use-providers-refresh-profile-status-mutation",
  () => ({
    useProvidersRefreshProfileStatusForClient: () => ({
      isPending: false,
      mutateAsync: (...args: unknown[]) => mocks.refreshProfileStatus(...args),
    }),
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

import {
  EmbeddedProviderRateLimitForProvider,
  ProviderProfilesRefreshButton,
  ProviderRateLimitForProvider,
} from "../provider-rate-limit-section";

const CLAUDE_FIVE_HOUR_RESETS_AT = Date.now() + 60 * 60 * 1000;
const CLAUDE_SEVEN_DAY_RESETS_AT = Date.now() + 2 * 24 * 60 * 60 * 1000;

const CLAUDE_RATE_LIMITS: ProviderRateLimits = {
  provider: "claude-code",
  available: true,
  // The SDK reports this as a lowercase token ("max"), but the settings card
  // no longer shows it - the provider auth badge above already does.
  subscriptionType: "max",
  fiveHour: {
    usedPercent: 12,
    resetsAt: CLAUDE_FIVE_HOUR_RESETS_AT,
    durationMinutes: 300,
  },
  sevenDay: {
    usedPercent: 55,
    resetsAt: CLAUDE_SEVEN_DAY_RESETS_AT,
    durationMinutes: 10080,
  },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  modelScoped: [],
  extraUsage: null,
};

const CODEX_PRIMARY_RESETS_AT = Date.now() + 3 * 60 * 60 * 1000;
const CODEX_SECONDARY_RESETS_AT = Date.now() + 4 * 24 * 60 * 60 * 1000;
const CODEX_SPEND_LIMIT_RESETS_AT = Date.now() + 5 * 24 * 60 * 60 * 1000;

const CODEX_RATE_LIMITS: ProviderRateLimits = {
  provider: "codex",
  available: true,
  // Real Codex `PlanType` values are lowercase tokens ("plus"), but the
  // settings card no longer shows it - the provider auth badge above
  // already does.
  planType: "plus",
  limitId: null,
  limitName: null,
  primary: {
    usedPercent: 42,
    resetsAt: CODEX_PRIMARY_RESETS_AT,
    durationMinutes: 300,
  },
  secondary: {
    usedPercent: 80,
    resetsAt: CODEX_SECONDARY_RESETS_AT,
    durationMinutes: 10080,
  },
  extraWindows: [],
  credits: {
    hasCredits: true,
    unlimited: false,
    balance: "$12.50",
  },
  individualLimit: {
    limit: "100.00",
    used: "42.00",
    remainingPercent: 58,
    resetsAt: CODEX_SPEND_LIMIT_RESETS_AT,
  },
  resetCredits: null,
  rateLimitReachedType: "rate_limit_reached",
};

describe("ProviderRateLimitForProvider", () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.isPending = false;
    mocks.isError = false;
    mocks.error = undefined;
    mocks.isFetching = false;
    mocks.targetPhase = null;
    mocks.targetForced = false;
    mocks.followUpExhausted = false;
    mocks.enqueue = vi.fn((..._args: unknown[]) => Promise.resolve());
    mocks.hostId = "host-1";
    mocks.turnRefreshCalls = [];
    mocks.refreshProviders.mockClear();
    mocks.refreshProfileStatus.mockClear();
    mocks.refreshOnMount.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the embedded variant as an integrated section without a nested card border", () => {
    const { container } = render(
      <EmbeddedProviderRateLimitForProvider
        providerId="codex"
        profileId="work-profile"
        usageUpdatedAt={123}
        fetchEligible
      />,
    );

    expect(container.firstElementChild?.className).toContain("border-t");
    expect(container.firstElementChild?.className).not.toContain("rounded-lg");
    expect(
      screen.queryByRole("button", { name: "Refresh usage limits" }),
    ).toBeNull();
    expect(mocks.refreshOnMount).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "work-profile",
      usageUpdatedAt: 123,
      hasCachedValue: false,
      fetchEligible: true,
      refetch: mocks.refetch,
    });
  });

  it("renders nothing for a provider without native usage limits", () => {
    const { container } = render(
      <ProviderRateLimitForProvider
        providerId="traycer"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );
    expect(container.firstChild).toBe(null);
  });

  it("renders the card with a loading state before data arrives", () => {
    mocks.isPending = true;
    mocks.isFetching = true;
    render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );
    expect(screen.getByText("Usage limits")).toBeTruthy();
    expect(screen.getByText("Loading usage limits")).toBeTruthy();
  });

  it("routes turn-completion refreshes through the current profile id", () => {
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId="work-profile"
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(mocks.turnRefreshCalls).toContainEqual({
      providerId: "codex",
      hostId: "work-profile",
    });
  });

  it("renders nothing (not an eternal spinner) while pending but not fetching", () => {
    // A query that's `enabled: false` (e.g. an unreachable host) stays
    // `isPending: true` forever without ever fetching - the card must not
    // show a permanent loading spinner for that state.
    mocks.isPending = true;
    mocks.isFetching = false;
    render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );
    expect(screen.getByText("Usage limits")).toBeTruthy();
    expect(screen.queryByText("Loading usage limits")).toBeNull();
  });

  it("renders the Claude Code rate-limit detail once loaded", () => {
    mocks.data = envelope(CLAUDE_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("12% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("55% used")).toBeTruthy();
  });

  it("does not show a subscription-plan badge (the provider auth badge above already shows it)", () => {
    mocks.data = envelope(CLAUDE_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );
    expect(screen.queryByText("Max")).toBeNull();
  });

  it("shows an exact reset date/time for the weekly window, and a relative countdown for the 5-hour one", () => {
    mocks.data = envelope(CLAUDE_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(
      screen.getByText(
        `Resets ${formatResetFullDateTime(CLAUDE_SEVEN_DAY_RESETS_AT)}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Resets in /)).toBeTruthy();
  });

  it("uses duration-aware Healthy, Running low, and Limited tones", () => {
    mocks.data = envelope({
      ...CLAUDE_RATE_LIMITS,
      fiveHour: {
        usedPercent: 75,
        resetsAt: CLAUDE_FIVE_HOUR_RESETS_AT,
        durationMinutes: 300,
      },
      sevenDay: {
        usedPercent: 95,
        resetsAt: CLAUDE_SEVEN_DAY_RESETS_AT,
        durationMinutes: 10080,
      },
      sevenDayOpus: {
        usedPercent: 100,
        resetsAt: CLAUDE_SEVEN_DAY_RESETS_AT,
        durationMinutes: 10080,
      },
    });
    const { container } = render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(container.querySelectorAll(".bg-blue-500").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelectorAll(".bg-amber-500").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelectorAll(".bg-red-500").length).toBeGreaterThan(0);
  });

  it("keeps bars Healthy below their duration-aware warning thresholds", () => {
    mocks.data = envelope(CLAUDE_RATE_LIMITS);
    const { container } = render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(container.querySelectorAll(".bg-amber-500").length).toBe(0);
    expect(container.querySelectorAll(".bg-red-500").length).toBe(0);
    expect(container.querySelectorAll(".bg-blue-500").length).toBeGreaterThan(
      0,
    );
  });

  it("renders the Codex rate-limit detail once loaded", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("42% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("80% used")).toBeTruthy();
  });

  it("keeps the last successful Codex reading when a later refresh fails, dimmed with a generic failed-refresh note", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isError = true;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("42% used")).toBeTruthy();
    expect(
      screen.queryByText("Couldn't load usage limits. Try refreshing."),
    ).toBeNull();
    expect(screen.getByText(/Updated Just now · refresh failed/)).toBeTruthy();
    expect(document.querySelectorAll(".opacity-60").length).toBeGreaterThan(0);
  });

  // A read we merely stopped waiting for is not a failed refresh: the host is
  // still running the probe and the queue has a delayed collection scheduled,
  // so the card keeps its reading undimmed rather than reporting a failure that
  // is about to resolve itself.
  it("does NOT report a refresh failure while the delayed collection is still coming", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isError = true;
    mocks.error = stillRunningRead();
    mocks.followUpExhausted = false;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("42% used")).toBeTruthy();
    expect(screen.queryByText(/refresh failed/)).toBeNull();
  });

  // ...but that reasoning expires. The queue allows ONE delayed collection; if
  // that also comes back unheard nothing is scheduled to collect the answer, so
  // continuing to hide it would leave this card vouching for a stale reading
  // with nothing coming to correct it.
  it("reports the failure once the follow-up budget is spent, with the SAME error", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isError = true;
    mocks.error = stillRunningRead();
    mocks.followUpExhausted = true;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("42% used")).toBeTruthy();
    expect(screen.getByText(/Updated Just now · refresh failed/)).toBeTruthy();
  });

  it("dims a retained reading and names the specific transient reason when the envelope itself carries usage_fetch_failed", () => {
    mocks.data = {
      latest: {
        provider: "codex",
        available: false,
        reason: "usage_fetch_failed",
      },
      lastGood: CODEX_RATE_LIMITS,
      lastGoodAt: Date.now(),
      lastFailureAt: Date.now(),
    };
    mocks.isError = false;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("42% used")).toBeTruthy();
    expect(
      screen.getByText(/Updated Just now · failed to fetch usage/),
    ).toBeTruthy();
    expect(screen.queryByText(/· refresh failed/)).toBeNull();
    expect(document.querySelectorAll(".opacity-60").length).toBeGreaterThan(0);
  });

  it("does not dim or show a stale note for a fresh reading", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isError = false;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.queryByText(/refresh failed/)).toBeNull();
    expect(screen.queryByText(/Updated Just now/)).toBeNull();
    expect(document.querySelectorAll(".opacity-60").length).toBe(0);
  });

  it("still replaces the picture (no stale treatment) for an authoritative unavailable reason", () => {
    mocks.data = envelope({
      provider: "codex",
      available: false,
      reason: "cli_not_found",
    });
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(
      screen.getByText("Usage limits unavailable - the CLI isn't installed"),
    ).toBeTruthy();
    expect(screen.queryByText("42% used")).toBeNull();
    expect(document.querySelectorAll(".opacity-60").length).toBe(0);
  });

  it("maps a rateLimitReachedType token to a destructive badge", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("Usage limit reached")).toBeTruthy();
  });

  it("does not show a plan badge (the provider auth badge above already shows it)", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.queryByText("Plus")).toBeNull();
  });

  it("renders the credits row", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText("Credits")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
  });

  it("renders the spend-control row with used/limit and an absolute reset time", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    // Scoped to the spend-limit row's own container: the current-session
    // window above it also renders a reset line, so an unscoped query would
    // match two elements.
    const spendLimitRow = screen
      .getByText("Spend limit")
      .closest("div.flex.flex-col.gap-1");
    expect(spendLimitRow).not.toBeNull();
    const spendLimitScope = within(spendLimitRow as HTMLElement);
    expect(spendLimitScope.getByText("42.00 / 100.00")).toBeTruthy();
    // Regression: `CodexSpendControlRow` used to hardcode `weekly={false}`,
    // always forcing a relative countdown regardless of the real reset time.
    // `CODEX_SPEND_LIMIT_RESETS_AT` is 5 days out, so the reset line now
    // correctly reads as an absolute calendar date/time, not "Resets in ...".
    expect(
      spendLimitScope.getByText(
        `Resets ${formatResetFullDateTime(CODEX_SPEND_LIMIT_RESETS_AT)}`,
      ),
    ).toBeTruthy();
    expect(spendLimitScope.queryByText(/^Resets in /)).toBeNull();
  });

  it("routes a Codex (ephemeralProcess) manual refresh through the shared queue with force:true, not a bare query.refetch()", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh usage limits" }),
    );

    expect(mocks.enqueue).toHaveBeenCalledWith(
      mocks.queueScope,
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      {
        force: true,
        profileId: null,
      },
    );
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("keeps the Terminal-only profile refresh on the existing bulk path", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderProfilesRefreshButton
        providerId="codex"
        profileId="work-profile"
        usageUpdatedAt={null}
        fetchEligible
        maintenanceAvailable={false}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Refresh profile statuses and usage limits",
      }),
    );

    expect(mocks.refreshProviders).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      mocks.queueScope,
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      {
        force: true,
        profileId: "work-profile",
      },
    );
    expect(mocks.refreshProfileStatus).not.toHaveBeenCalled();
  });

  it("routes managed profile maintenance through the dedicated host RPC", () => {
    render(
      <ProviderProfilesRefreshButton
        providerId="codex"
        profileId="work-profile"
        usageUpdatedAt={null}
        fetchEligible={false}
        maintenanceAvailable
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Refresh profile status and usage limits",
      }),
    );

    expect(mocks.refreshProfileStatus).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "work-profile",
    });
    expect(mocks.refreshProviders).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the refresh button disabled while THIS target is fetching, even once its own isFetching has settled", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isFetching = false;
    mocks.targetPhase = "fetching";
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(
      screen.getByRole("button", { name: "Refresh usage limits" }),
    ).toHaveProperty("disabled", true);
  });

  it("leaves the refresh button live while this target is merely QUEUED, so the click can promote it", () => {
    // An enqueue for an already-queued target sets `pending.force = true`;
    // disabling here would make that click impossible.
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isFetching = false;
    mocks.targetPhase = "queued";
    mocks.targetForced = false;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(
      screen.getByRole("button", { name: "Refresh usage limits" }),
    ).toHaveProperty("disabled", false);
  });

  it("DISABLES the refresh button once this card's queued target is already forced", () => {
    // The Settings card renders no "Queued…" label, so its spinner is the only
    // feedback a waiting user gets. `RefreshIconButton` caps its own spinner at
    // 10s, so a manual refresh stuck behind another target's probe would show
    // an idle, clickable button while the request was still pending - for up to
    // the lane's full response budget. Once forced there is nothing left for a
    // further click to promote, so pending is the honest state.
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isFetching = false;
    mocks.targetPhase = "queued";
    mocks.targetForced = true;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(
      screen.getByRole("button", { name: "Refresh usage limits" }),
    ).toHaveProperty("disabled", true);
  });

  it("leaves the refresh button live when this target is NOT in the queue, however busy the lane is", () => {
    // The card's control is gated by its own target only. It previously read
    // the lane-wide draining flag, so a background sweep of an unrelated
    // provider left this button disabled - and, because the trigger also
    // no-ops while disabled, unclickable for that sweep's full duration.
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isFetching = false;
    mocks.targetPhase = null;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(
      screen.getByRole("button", { name: "Refresh usage limits" }),
    ).toHaveProperty("disabled", false);
  });
});
