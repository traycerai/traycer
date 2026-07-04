import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import { formatResetDateTime } from "@/lib/relative-time";

const mocks = vi.hoisted(() => ({
  data: undefined as
    { providerRateLimits: ProviderRateLimits | null } | undefined,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(() => Promise.resolve({})),
  draining: false,
  enqueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

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
  useRefreshProviderRateLimitsOnMount: () => {},
}));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));
vi.mock("@/hooks/rate-limits/use-is-rate-limit-queue-draining", () => ({
  useIsRateLimitQueueDraining: () => mocks.draining,
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  enqueueRateLimitFetch: (...args: unknown[]) => mocks.enqueue(...args),
}));

import { ProviderRateLimitForProvider } from "../provider-rate-limit-section";

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
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing for a provider without native rate limits", () => {
    const { container } = render(
      <ProviderRateLimitForProvider providerId="traycer" />,
    );
    expect(container.firstChild).toBe(null);
  });

  it("renders the card with a loading state before data arrives", () => {
    mocks.isPending = true;
    mocks.isFetching = true;
    render(<ProviderRateLimitForProvider providerId="claude-code" />);
    expect(screen.getByText("Rate limits")).toBeTruthy();
    expect(screen.getByText("Loading rate limits")).toBeTruthy();
  });

  it("renders nothing (not an eternal spinner) while pending but not fetching", () => {
    // A query that's `enabled: false` (e.g. an unreachable host) stays
    // `isPending: true` forever without ever fetching - the card must not
    // show a permanent loading spinner for that state.
    mocks.isPending = true;
    mocks.isFetching = false;
    render(<ProviderRateLimitForProvider providerId="claude-code" />);
    expect(screen.getByText("Rate limits")).toBeTruthy();
    expect(screen.queryByText("Loading rate limits")).toBeNull();
  });

  it("renders the Claude Code rate-limit detail once loaded", () => {
    mocks.data = { providerRateLimits: CLAUDE_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="claude-code" />);

    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("12% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("55% used")).toBeTruthy();
  });

  it("does not show a subscription-plan badge (the provider auth badge above already shows it)", () => {
    mocks.data = { providerRateLimits: CLAUDE_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="claude-code" />);
    expect(screen.queryByText("Max")).toBeNull();
  });

  it("shows an exact reset date/time for the weekly window, and a relative countdown for the 5-hour one", () => {
    mocks.data = { providerRateLimits: CLAUDE_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="claude-code" />);

    expect(
      screen.getByText(
        `Resets ${formatResetDateTime(CLAUDE_SEVEN_DAY_RESETS_AT)}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Resets in /)).toBeTruthy();
  });

  it("colors a window's bar yellow at/above 60% used and red above 85% used", () => {
    // The Settings card now shares the same four-tier severity scale as the
    // popover (item 6 feedback: "different UX looks weird").
    mocks.data = {
      providerRateLimits: {
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
      },
    };
    const { container } = render(
      <ProviderRateLimitForProvider providerId="claude-code" />,
    );

    expect(container.querySelectorAll(".bg-yellow-500").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelectorAll(".bg-red-500").length).toBeGreaterThan(0);
  });

  it("keeps the bar blue below the yellow threshold", () => {
    mocks.data = { providerRateLimits: CLAUDE_RATE_LIMITS };
    const { container } = render(
      <ProviderRateLimitForProvider providerId="claude-code" />,
    );

    expect(container.querySelectorAll(".bg-yellow-500").length).toBe(0);
    expect(container.querySelectorAll(".bg-red-500").length).toBe(0);
    expect(container.querySelectorAll(".bg-blue-500").length).toBeGreaterThan(
      0,
    );
  });

  it("renders the Codex rate-limit detail once loaded", () => {
    mocks.data = { providerRateLimits: CODEX_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="codex" />);

    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("42% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("80% used")).toBeTruthy();
  });

  it("maps a rateLimitReachedType token to a destructive badge", () => {
    mocks.data = { providerRateLimits: CODEX_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="codex" />);

    expect(screen.getByText("Rate limit reached")).toBeTruthy();
  });

  it("does not show a plan badge (the provider auth badge above already shows it)", () => {
    mocks.data = { providerRateLimits: CODEX_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="codex" />);

    expect(screen.queryByText("Plus")).toBeNull();
  });

  it("renders the credits row", () => {
    mocks.data = { providerRateLimits: CODEX_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="codex" />);

    expect(screen.getByText("Credits")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
  });

  it("renders the spend-control row with used/limit and an absolute reset time", () => {
    mocks.data = { providerRateLimits: CODEX_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="codex" />);

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
    mocks.data = { providerRateLimits: CODEX_RATE_LIMITS };
    render(<ProviderRateLimitForProvider providerId="codex" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh rate limits" }),
    );

    expect(mocks.enqueue).toHaveBeenCalledWith("codex", expect.anything(), {
      force: true,
    });
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("keeps the refresh button disabled while the shared queue is draining, even once this provider's own isFetching has settled", () => {
    mocks.data = { providerRateLimits: CODEX_RATE_LIMITS };
    mocks.isFetching = false;
    mocks.draining = true;
    render(<ProviderRateLimitForProvider providerId="codex" />);

    expect(
      screen.getByRole("button", { name: "Refresh rate limits" }),
    ).toHaveProperty("disabled", true);
  });
});
