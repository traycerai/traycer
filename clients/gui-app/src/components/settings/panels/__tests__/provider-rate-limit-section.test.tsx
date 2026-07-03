import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
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
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
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
  },
  sevenDay: {
    usedPercent: 55,
    resetsAt: CLAUDE_SEVEN_DAY_RESETS_AT,
  },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  modelScoped: [],
  extraUsage: null,
};

describe("ProviderRateLimitForProvider", () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.isPending = false;
    mocks.isError = false;
    mocks.isFetching = false;
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

    expect(screen.getByText("5-hour")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("12% / 100%")).toBeTruthy();
    expect(screen.getByText("55% / 100%")).toBeTruthy();
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

  it("colors a window's bar amber above 70% used and red above 90% used", () => {
    mocks.data = {
      providerRateLimits: {
        ...CLAUDE_RATE_LIMITS,
        fiveHour: { usedPercent: 75, resetsAt: CLAUDE_FIVE_HOUR_RESETS_AT },
        sevenDay: { usedPercent: 95, resetsAt: CLAUDE_SEVEN_DAY_RESETS_AT },
      },
    };
    const { container } = render(
      <ProviderRateLimitForProvider providerId="claude-code" />,
    );

    expect(container.querySelectorAll(".bg-amber-500").length).toBeGreaterThan(
      0,
    );
    expect(
      container.querySelectorAll(".bg-destructive").length,
    ).toBeGreaterThan(0);
  });

  it("keeps the bar at the default color at or below 70% used", () => {
    mocks.data = { providerRateLimits: CLAUDE_RATE_LIMITS };
    const { container } = render(
      <ProviderRateLimitForProvider providerId="claude-code" />,
    );

    expect(container.querySelectorAll(".bg-amber-500").length).toBe(0);
    expect(container.querySelectorAll(".bg-destructive").length).toBe(0);
    expect(container.querySelectorAll(".bg-primary").length).toBeGreaterThan(0);
  });
});
