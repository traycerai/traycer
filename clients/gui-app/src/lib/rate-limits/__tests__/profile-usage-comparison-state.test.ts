import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import {
  deriveProfileUsageDetailState,
  deriveProfileUsageRefreshStatus,
} from "@/lib/rate-limits/profile-usage-comparison-state";

const GOOD: ProviderRateLimits = {
  provider: "claude-code",
  available: true,
  subscriptionType: "max",
  fiveHour: { usedPercent: 10, resetsAt: null, durationMinutes: 300 },
  sevenDay: null,
  sevenDayOpus: null,
  sevenDaySonnet: null,
  modelScoped: [],
  extraUsage: null,
};

function envelope(
  overrides: Partial<ProviderRateLimitEnvelope>,
): ProviderRateLimitEnvelope {
  return {
    latest: null,
    lastGood: null,
    lastGoodAt: null,
    lastFailureAt: null,
    ...overrides,
  };
}

const NOW = 1_000_000;

describe("deriveProfileUsageDetailState", () => {
  it("returns never-checked when no envelope has ever been cached and the host summary reports no warning", () => {
    const state = deriveProfileUsageDetailState(
      undefined,
      { rateLimitStatus: "ok", usageUpdatedAt: null },
      NOW,
    );
    expect(state).toEqual({ kind: "never-checked" });
  });

  it("returns never-checked for an unknown host summary status even when usageUpdatedAt is set", () => {
    const state = deriveProfileUsageDetailState(
      undefined,
      { rateLimitStatus: "unknown", usageUpdatedAt: NOW - 1 },
      NOW,
    );
    expect(state).toEqual({ kind: "never-checked" });
  });

  it("returns semantic-only, without fabricating a percentage, when the cache has no envelope but the host summary already knows the profile is near its limit", () => {
    const state = deriveProfileUsageDetailState(
      undefined,
      { rateLimitStatus: "near_limit", usageUpdatedAt: NOW - 1 },
      NOW,
    );
    expect(state).toEqual({ kind: "semantic-only", status: "near_limit" });
  });

  it("returns semantic-only for a hard-limited host summary", () => {
    const state = deriveProfileUsageDetailState(
      undefined,
      { rateLimitStatus: "hard_limit", usageUpdatedAt: NOW - 1 },
      NOW,
    );
    expect(state).toEqual({ kind: "semantic-only", status: "hard_limit" });
  });

  it("returns fresh for a recently retained good reading", () => {
    const state = deriveProfileUsageDetailState(
      envelope({ latest: GOOD, lastGood: GOOD, lastGoodAt: NOW - 1000 }),
      { rateLimitStatus: "ok", usageUpdatedAt: NOW - 1000 },
      NOW,
    );
    expect(state).toEqual({ kind: "fresh", usage: GOOD, asOf: NOW - 1000 });
  });

  it("returns stale once the retained reading is older than the freshness floor", () => {
    const asOf = NOW - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1;
    const state = deriveProfileUsageDetailState(
      envelope({ latest: GOOD, lastGood: GOOD, lastGoodAt: asOf }),
      { rateLimitStatus: "ok", usageUpdatedAt: asOf },
      NOW,
    );
    expect(state).toEqual({ kind: "stale", usage: GOOD, asOf });
  });

  it("returns failed-with-last-good when the latest attempt is a transient failure but a prior reading is retained", () => {
    const asOf = NOW - 5000;
    const failedAt = NOW - 100;
    const state = deriveProfileUsageDetailState(
      envelope({
        latest: {
          provider: "claude-code",
          available: false,
          reason: "usage_fetch_failed",
        },
        lastGood: GOOD,
        lastGoodAt: asOf,
        lastFailureAt: failedAt,
      }),
      { rateLimitStatus: "ok", usageUpdatedAt: asOf },
      NOW,
    );
    expect(state).toEqual({
      kind: "failed-with-last-good",
      usage: GOOD,
      asOf,
      failedAt,
    });
  });

  it("returns failed-no-last-good when the latest attempt is an authoritative failure and nothing is retained", () => {
    const failedAt = NOW - 100;
    const state = deriveProfileUsageDetailState(
      envelope({
        latest: {
          provider: "claude-code",
          available: false,
          reason: "cli_not_found",
        },
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: failedAt,
      }),
      { rateLimitStatus: "ok", usageUpdatedAt: null },
      NOW,
    );
    expect(state).toEqual({ kind: "failed-no-last-good", failedAt });
  });

  it("returns failed-no-last-good when a transient failure has never once succeeded", () => {
    const state = deriveProfileUsageDetailState(
      envelope({
        latest: {
          provider: "claude-code",
          available: false,
          reason: "timeout",
        },
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: NOW,
      }),
      { rateLimitStatus: "ok", usageUpdatedAt: null },
      NOW,
    );
    expect(state).toEqual({ kind: "failed-no-last-good", failedAt: NOW });
  });
});

describe("deriveProfileUsageRefreshStatus", () => {
  it("is refreshing whenever this profile's own query is fetching, regardless of lane", () => {
    expect(
      deriveProfileUsageRefreshStatus({
        isFetchingThisProfile: true,
        queueDraining: false,
        lane: "httpFetch",
      }),
    ).toBe("refreshing");
    expect(
      deriveProfileUsageRefreshStatus({
        isFetchingThisProfile: true,
        queueDraining: false,
        lane: "ephemeralProcess",
      }),
    ).toBe("refreshing");
  });

  it("is queued for the ephemeralProcess lane when the shared queue is draining but this profile's own fetch has not started", () => {
    expect(
      deriveProfileUsageRefreshStatus({
        isFetchingThisProfile: false,
        queueDraining: true,
        lane: "ephemeralProcess",
      }),
    ).toBe("queued");
  });

  it("is never queued for the httpFetch lane, which has no shared queue", () => {
    expect(
      deriveProfileUsageRefreshStatus({
        isFetchingThisProfile: false,
        queueDraining: true,
        lane: "httpFetch",
      }),
    ).toBe("idle");
  });

  it("is idle when nothing is fetching or draining", () => {
    expect(
      deriveProfileUsageRefreshStatus({
        isFetchingThisProfile: false,
        queueDraining: false,
        lane: "ephemeralProcess",
      }),
    ).toBe("idle");
    expect(
      deriveProfileUsageRefreshStatus({
        isFetchingThisProfile: false,
        queueDraining: false,
        lane: null,
      }),
    ).toBe("idle");
  });
});
