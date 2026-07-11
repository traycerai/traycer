import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { envelopeFromRateLimits } from "@/lib/rate-limits/__tests__/rate-limit-envelope-fixtures";
import { formatResetDateTime } from "@/lib/relative-time";

const mocks = vi.hoisted(() => ({
  data: undefined as ProviderRateLimitEnvelope | undefined,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(() => Promise.resolve({})),
  draining: false,
  queueScope: { hostId: "host-b" },
  enqueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
  refreshProviders: vi.fn(() => Promise.resolve()),
  refreshOnMount: vi.fn(),
}));

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
    isFetching: mocks.isFetching,
    refetch: mocks.refetch,
  }),
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-turn", () => ({
  useRefreshProviderRateLimitsOnTurn: () => {},
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: (...args: unknown[]) => {
    mocks.refreshOnMount(...args);
  },
}));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));
vi.mock("@/hooks/rate-limits/use-is-rate-limit-queue-draining", () => ({
  useIsRateLimitQueueDraining: () => mocks.draining,
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
    mocks.isFetching = false;
    mocks.draining = false;
    mocks.enqueue = vi.fn((..._args: unknown[]) => Promise.resolve());
    mocks.refreshProviders.mockClear();
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
      />,
    );

    expect(container.firstElementChild?.className).toContain("border-t");
    expect(container.firstElementChild?.className).not.toContain("rounded-lg");
    expect(
      screen.queryByRole("button", { name: "Refresh usage limits" }),
    ).toBeNull();
    expect(mocks.refreshOnMount).toHaveBeenCalledWith(
      "codex",
      "work-profile",
      123,
    );
  });

  it("renders nothing for a provider without native usage limits", () => {
    const { container } = render(
      <ProviderRateLimitForProvider
        providerId="traycer"
        profileId={null}
        usageUpdatedAt={null}
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
      />,
    );
    expect(screen.getByText("Usage limits")).toBeTruthy();
    expect(screen.getByText("Loading usage limits")).toBeTruthy();
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
      />,
    );

    expect(
      screen.getByText(
        `Resets ${formatResetDateTime(CLAUDE_SEVEN_DAY_RESETS_AT)}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Resets in /)).toBeTruthy();
  });

  it("keeps usage blue through 85% and red above 85% used", () => {
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
    });
    const { container } = render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
      />,
    );

    expect(container.querySelectorAll(".bg-yellow-500").length).toBe(0);
    expect(container.querySelectorAll(".bg-blue-500").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelectorAll(".bg-red-500").length).toBeGreaterThan(0);
  });

  it("keeps the bar blue below the red threshold", () => {
    mocks.data = envelope(CLAUDE_RATE_LIMITS);
    const { container } = render(
      <ProviderRateLimitForProvider
        providerId="claude-code"
        profileId={null}
        usageUpdatedAt={null}
      />,
    );

    expect(container.querySelectorAll(".bg-yellow-500").length).toBe(0);
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
      />,
    );

    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("42% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("80% used")).toBeTruthy();
  });

  it("maps a rateLimitReachedType token to a destructive badge", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
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
    // correctly reads as an absolute weekday/time, not "Resets in ...".
    expect(
      spendLimitScope.getByText(/^Resets [A-Za-z]{3} \d{1,2}:\d{2}\s?[AP]M$/i),
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

  it("combines the selected host's profile-status and managed-profile usage refresh", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    render(
      <ProviderProfilesRefreshButton
        providerId="codex"
        profileId="work-profile"
        usageUpdatedAt={null}
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
  });

  it("keeps the refresh button disabled while the shared queue is draining, even once this provider's own isFetching has settled", () => {
    mocks.data = envelope(CODEX_RATE_LIMITS);
    mocks.isFetching = false;
    mocks.draining = true;
    render(
      <ProviderRateLimitForProvider
        providerId="codex"
        profileId={null}
        usageUpdatedAt={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Refresh usage limits" }),
    ).toHaveProperty("disabled", true);
  });
});
