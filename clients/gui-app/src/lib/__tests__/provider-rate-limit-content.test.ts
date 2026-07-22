import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import { envelopeFromRateLimits } from "@/lib/rate-limits/__tests__/rate-limit-envelope-fixtures";
import {
  formatUnavailableReason,
  resolvePopoverProviderRateLimitState,
  resolveProviderPlanLabel,
  resolveProviderRateLimitViewState,
} from "@/lib/provider-rate-limit-content";

const READY: ProviderRateLimits = {
  provider: "kilocode",
  available: true,
  creditBalance: 10,
  passState: null,
};

const ANOTHER_READY: ProviderRateLimits = {
  provider: "kilocode",
  available: true,
  creditBalance: 25,
  passState: null,
};

const UNAVAILABLE: ProviderRateLimits = {
  provider: "codex",
  available: false,
  reason: "cli_not_found",
};

/** A fresh, cold-start envelope wrapping a single response - no previous fetch. */
function envelopeOf(data: ProviderRateLimits) {
  return envelopeFromRateLimits(data, 1_000);
}

describe("formatUnavailableReason", () => {
  it("maps the Droid org-plan gate to plain language", () => {
    expect(formatUnavailableReason("insufficient_permissions")).toBe(
      "this account doesn't have permission to view usage",
    );
  });

  it("maps the CLI-missing reason", () => {
    expect(formatUnavailableReason("cli_not_found")).toBe(
      "the CLI isn't installed",
    );
  });

  it("maps the transient usage-fetch-failed reason to retry-oriented copy, distinct from the account-capability wording", () => {
    expect(formatUnavailableReason("usage_fetch_failed")).toBe(
      "failed to fetch usage",
    );
    expect(formatUnavailableReason("usage_fetch_failed")).not.toBe(
      formatUnavailableReason("rate_limits_not_available"),
    );
  });
});

describe("resolveProviderRateLimitViewState", () => {
  it("is loading while the first fetch is in flight with no data", () => {
    const state = resolveProviderRateLimitViewState({
      isPending: true,
      isFetching: true,
      isError: false,
      envelope: undefined,
    });
    expect(state).toEqual({ kind: "loading" });
  });

  it("is empty on a cold cache with no envelope yet (disabled queue-owned observer)", () => {
    const state = resolveProviderRateLimitViewState({
      isPending: true,
      isFetching: false,
      isError: false,
      envelope: null,
    });
    expect(state).toEqual({ kind: "empty" });
  });

  it("retains cached data when a later refresh attempt throws, marked degraded with no specific reason", () => {
    const state = resolveProviderRateLimitViewState({
      isPending: false,
      isFetching: false,
      isError: true,
      envelope: envelopeOf(READY),
    });
    expect(state).toEqual({
      kind: "data",
      data: READY,
      degraded: true,
      degradedReason: null,
      lastGoodAt: 1000,
    });
  });

  it("is error when a refresh throws before any successful reading", () => {
    const state = resolveProviderRateLimitViewState({
      isPending: false,
      isFetching: false,
      isError: true,
      envelope: undefined,
    });
    expect(state).toEqual({ kind: "error" });
  });

  it("is data for a fresh available snapshot", () => {
    const state = resolveProviderRateLimitViewState({
      isPending: false,
      isFetching: false,
      isError: false,
      envelope: envelopeOf(READY),
    });
    expect(state).toEqual({
      kind: "data",
      data: READY,
      degraded: false,
      degradedReason: null,
      lastGoodAt: 1000,
    });
  });

  it("is data for an authoritative unavailable reason (replaces, not retained), with no stale treatment or timestamp", () => {
    const state = resolveProviderRateLimitViewState({
      isPending: false,
      isFetching: false,
      isError: false,
      envelope: envelopeOf(UNAVAILABLE),
    });
    expect(state).toEqual({
      kind: "data",
      data: UNAVAILABLE,
      degraded: false,
      degradedReason: null,
      lastGoodAt: null,
    });
  });

  it.each(["usage_fetch_failed", "timeout", "connection_failed"] as const)(
    "retains the last good reading through a transient failure (%s), marked degraded with the original lastGoodAt",
    (reason) => {
      const state = resolveProviderRateLimitViewState({
        isPending: false,
        isFetching: false,
        isError: false,
        envelope: {
          latest: { provider: "codex", available: false, reason },
          lastGood: ANOTHER_READY,
          lastGoodAt: 1_000,
          lastFailureAt: 2_000,
        },
      });
      expect(state).toEqual({
        kind: "data",
        data: ANOTHER_READY,
        degraded: true,
        degradedReason: reason,
        lastGoodAt: 1000,
      });
    },
  );

  it("shows the transient reason itself when there's no lastGood yet (cold-after-reload), with no stale treatment", () => {
    const transient: ProviderRateLimits = {
      provider: "codex",
      available: false,
      reason: "usage_fetch_failed",
    };
    const state = resolveProviderRateLimitViewState({
      isPending: false,
      isFetching: false,
      isError: false,
      envelope: {
        latest: transient,
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: 1_000,
      },
    });
    expect(state).toEqual({
      kind: "data",
      data: transient,
      degraded: false,
      degradedReason: null,
      lastGoodAt: null,
    });
  });
});

describe("resolvePopoverProviderRateLimitState", () => {
  it("is a cold load while the first fetch is in flight with no data", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: true,
      isFetching: true,
      isError: false,
      envelope: undefined,
    });
    expect(state.kind).toBe("cold");
  });

  it("is cold while a disabled queue-owned observer is pending without fetching", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: true,
      isFetching: false,
      isError: false,
      envelope: null,
    });
    expect(state.kind).toBe("cold");
  });

  it("is an error when the first fetch failed with no data", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: true,
      envelope: undefined,
    });
    expect(state.kind).toBe("error");
  });

  it("surfaces the provider's own authoritative unavailable reason, not retained", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: false,
      envelope: envelopeOf(UNAVAILABLE),
    });
    expect(state).toEqual({ kind: "unavailable", reason: "cli_not_found" });
  });

  it("is ready and not degraded for a fresh available snapshot", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: false,
      envelope: envelopeOf(READY),
    });
    expect(state).toEqual({
      kind: "ready",
      data: READY,
      degraded: false,
      degradedReason: null,
    });
  });

  it("is ready but degraded (generic reason) when the query's own last fetch attempt threw over last-known-good data", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: true,
      envelope: envelopeOf(READY),
    });
    expect(state).toEqual({
      kind: "ready",
      data: READY,
      degraded: true,
      degradedReason: null,
    });
  });

  it.each(["usage_fetch_failed", "timeout", "connection_failed"] as const)(
    "is ready but degraded with the specific transient reason (%s) when the envelope retains a lastGood",
    (reason) => {
      const state = resolvePopoverProviderRateLimitState({
        isPending: false,
        isFetching: false,
        isError: false,
        envelope: {
          latest: { provider: "codex", available: false, reason },
          lastGood: ANOTHER_READY,
          lastGoodAt: 1_000,
          lastFailureAt: 2_000,
        },
      });
      expect(state).toEqual({
        kind: "ready",
        data: ANOTHER_READY,
        degraded: true,
        degradedReason: reason,
      });
    },
  );

  it("is unavailable (not ready-degraded) for a transient reason with no lastGood yet - nothing to dim", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: false,
      envelope: {
        latest: { provider: "codex", available: false, reason: "timeout" },
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: 1_000,
      },
    });
    expect(state).toEqual({ kind: "unavailable", reason: "timeout" });
  });
});

describe("resolveProviderPlanLabel", () => {
  it("title-cases Codex's planType", () => {
    expect(
      resolveProviderPlanLabel({
        provider: "codex",
        available: true,
        planType: "pro_5x",
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        extraWindows: [],
        credits: null,
        individualLimit: null,
        resetCredits: null,
        rateLimitReachedType: null,
      }),
    ).toBe("Pro 5x");
  });

  it("title-cases Claude Code's subscriptionType", () => {
    expect(
      resolveProviderPlanLabel({
        provider: "claude-code",
        available: true,
        subscriptionType: "max",
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        modelScoped: [],
        extraUsage: null,
      }),
    ).toBe("Max");
  });

  it("is null when a provider didn't report a plan/tier", () => {
    expect(
      resolveProviderPlanLabel({
        provider: "codex",
        available: true,
        planType: null,
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        extraWindows: [],
        credits: null,
        individualLimit: null,
        resetCredits: null,
        rateLimitReachedType: null,
      }),
    ).toBeNull();
  });

  it("is always null for providers with no plan/tier concept (OpenRouter, Kilo Code)", () => {
    expect(
      resolveProviderPlanLabel({
        provider: "openrouter",
        available: true,
        limit: null,
        limitRemaining: null,
        dailySpend: null,
        weeklySpend: null,
        monthlySpend: null,
        totalCredits: null,
        totalUsage: null,
        balance: null,
      }),
    ).toBeNull();
    expect(
      resolveProviderPlanLabel({
        provider: "kilocode",
        available: true,
        creditBalance: null,
        passState: null,
      }),
    ).toBeNull();
  });
});
