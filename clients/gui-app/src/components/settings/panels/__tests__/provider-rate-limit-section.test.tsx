import {
  act,
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
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { NO_EPISODE } from "@/lib/rate-limits/rate-limit-envelope";
import { envelopeFromRateLimits } from "@/lib/rate-limits/__tests__/rate-limit-envelope-fixtures";
import { formatResetFullDateTime } from "@/lib/relative-time";
import { useLayoutStore } from "@/stores/layout/layout-store";

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
    fetchProviderRateLimits: Mock<(...args: unknown[]) => Promise<unknown>>;
    hostId: string;
    turnRefreshCalls: TurnRefreshCall[];
    fetchScope: { hostId: string };
    refreshOnMount: Mock<(...args: unknown[]) => void>;
  } => ({
    data: undefined,
    isPending: false,
    isError: false,
    error: undefined,
    isFetching: false,
    refetch: vi.fn(() => Promise.resolve({})),
    fetchProviderRateLimits: vi.fn((..._args: unknown[]) => Promise.resolve()),
    hostId: "host-1",
    turnRefreshCalls: [],
    fetchScope: { hostId: "host-b" },
    refreshOnMount: vi.fn(),
  }),
);

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
vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => mocks.fetchScope,
}));
vi.mock("@/lib/rate-limits/provider-rate-limit-fetch", () => ({
  fetchProviderRateLimits: (...args: unknown[]) =>
    mocks.fetchProviderRateLimits(...args),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

import {
  NO_NOTICES,
  NO_OVERRIDES,
  NO_REVIEW,
  PersonalPageContext,
} from "@/components/settings/personal/personal-page-context";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import {
  EmbeddedProviderRateLimitForProvider,
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
    mocks.fetchProviderRateLimits = vi.fn((..._args: unknown[]) =>
      Promise.resolve(),
    );
    mocks.hostId = "host-1";
    mocks.turnRefreshCalls = [];
    mocks.refreshOnMount.mockClear();
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
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
    expect(screen.getByText("Rate limits")).toBeTruthy();
    expect(screen.getByText("Loading usage limits")).toBeTruthy();
  });

  it("heads the live card with the host that reported it, and offers no other host", () => {
    mocks.data = envelope(CLAUDE_RATE_LIMITS);
    render(
      <PersonalPageContext.Provider
        value={{
          section: "providers",
          pick: PERSONAL_PICK,
          state: { kind: "unknown" },
          line: null,
          hostName: "Studio",
          localOverrides: NO_OVERRIDES,
          hostId: "host-1",
          client: null,
          notices: NO_NOTICES,
          review: NO_REVIEW,
        }}
      >
        <ProviderRateLimitForProvider
          providerId="claude-code"
          profileId={null}
          usageUpdatedAt={null}
          fetchEligible
        />
      </PersonalPageContext.Provider>,
    );

    expect(screen.getByText("Rate limits")).toBeTruthy();
    expect(screen.getByText(/as reported by Studio/)).toBeTruthy();
    expect(screen.queryByText(/Use another host/)).toBeNull();
    expect(screen.queryByText("Usage limits")).toBeNull();
  });

  it("names this computer in the heading when the page carries no host name", () => {
    render(
      <EmbeddedProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );

    expect(screen.getByText(/as reported by this computer/)).toBeTruthy();
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
    expect(screen.getByText("Rate limits")).toBeTruthy();
    expect(screen.queryByText("Loading usage limits")).toBeNull();
  });

  it("words the Settings › Providers rows by Layout's Used / Remaining setting, the same as the strip and the popover", () => {
    mocks.data = envelope(CLAUDE_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
        fetchEligible
      />,
    );
    expect(screen.getByText("12% used")).toBeTruthy();
    expect(screen.getByText("55% used")).toBeTruthy();

    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("usageLimits", { amount: "remaining" });
    });
    expect(screen.getByText("88% remaining")).toBeTruthy();
    expect(screen.getByText("45% remaining")).toBeTruthy();
    expect(screen.queryByText("12% used")).toBeNull();
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

    expect(container.querySelectorAll(".bg-info").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".bg-warning").length).toBeGreaterThan(0);
    expect(
      container.querySelectorAll(".bg-destructive").length,
    ).toBeGreaterThan(0);
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

    expect(container.querySelectorAll(".bg-warning").length).toBe(0);
    expect(container.querySelectorAll(".bg-destructive").length).toBe(0);
    expect(container.querySelectorAll(".bg-info").length).toBeGreaterThan(0);
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
      credentialGeneration: null,
      episode: NO_EPISODE,
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

  it("routes a Codex (ephemeralProcess) manual refresh through fetchProviderRateLimits with force:true, not a bare query.refetch()", () => {
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

    expect(mocks.fetchProviderRateLimits).toHaveBeenCalledWith(
      mocks.fetchScope,
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: null,
      },
      { force: true },
    );
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  // `isRefreshing` (and so the button's disabled state) is now a direct
  // read of this target's OWN `query.isFetching` - there is no more
  // lane-wide phase to fold in, so a background fetch on an unrelated
  // provider (a different cache key entirely) cannot reach this button.
  it("disables the refresh button while this target's own query is fetching", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isFetching = true;
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

  it("leaves the refresh button enabled once this target's own query settles", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isFetching = false;
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
