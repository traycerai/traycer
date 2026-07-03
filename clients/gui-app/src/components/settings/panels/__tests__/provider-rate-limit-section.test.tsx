import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host";

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

const CLAUDE_RATE_LIMITS: ProviderRateLimits = {
  provider: "claude-code",
  available: true,
  // The SDK reports this as a lowercase token ("max") - the view title-cases
  // it for display ("Max").
  subscriptionType: "max",
  fiveHour: {
    usedPercent: 12,
    resetsAt: Date.now() + 60 * 60 * 1000,
  },
  sevenDay: {
    usedPercent: 55,
    resetsAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
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

    expect(screen.getByText("Max")).toBeTruthy();
    expect(screen.getByText("5-hour")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("12% / 100%")).toBeTruthy();
    expect(screen.getByText("55% / 100%")).toBeTruthy();
  });
});
