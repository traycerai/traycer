import { describe, expect, it } from "vitest";
import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import {
  buildProviderRateLimitEnvelope,
  envelopeDegradedReason,
  isTransientUnavailableReason,
  resolveRetainedProviderRateLimits,
  type ProviderRateLimitEnvelope,
  type RateLimitUsageResponse,
} from "@/lib/rate-limits/rate-limit-envelope";

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

const OTHER_GOOD: ProviderRateLimits = {
  ...GOOD,
  fiveHour: { usedPercent: 40, resetsAt: null, durationMinutes: 300 },
};

function response(
  providerRateLimits: ProviderRateLimits | null,
): RateLimitUsageResponse {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits };
}

function unavailable(reason: RateLimitUnavailableReason): ProviderRateLimits {
  return { provider: "claude-code", available: false, reason };
}

describe("isTransientUnavailableReason", () => {
  it("treats usage_fetch_failed, timeout, and connection_failed as transient", () => {
    expect(isTransientUnavailableReason("usage_fetch_failed")).toBe(true);
    expect(isTransientUnavailableReason("timeout")).toBe(true);
    expect(isTransientUnavailableReason("connection_failed")).toBe(true);
  });

  it("treats every other reason as authoritative", () => {
    expect(isTransientUnavailableReason("rate_limits_not_available")).toBe(
      false,
    );
    expect(isTransientUnavailableReason("cli_not_found")).toBe(false);
    expect(isTransientUnavailableReason("insufficient_permissions")).toBe(
      false,
    );
    expect(isTransientUnavailableReason("sdk_incompatible")).toBe(false);
    expect(isTransientUnavailableReason("unsupported_provider")).toBe(false);
    expect(isTransientUnavailableReason("invalid_response")).toBe(false);
  });
});

describe("buildProviderRateLimitEnvelope", () => {
  it("cold start (no previous envelope): a good reading becomes latest and lastGood", () => {
    const envelope = buildProviderRateLimitEnvelope(
      undefined,
      response(GOOD),
      1_000,
    );
    expect(envelope).toEqual({
      latest: GOOD,
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: null,
    });
  });

  it.each(["usage_fetch_failed", "timeout", "connection_failed"] as const)(
    "retains a prior lastGood across a transient failure (%s), advancing lastFailureAt only",
    (reason) => {
      const previous: ProviderRateLimitEnvelope = {
        latest: GOOD,
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: null,
      };
      const envelope = buildProviderRateLimitEnvelope(
        previous,
        response(unavailable(reason)),
        2_000,
      );
      expect(envelope).toEqual({
        latest: unavailable(reason),
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: 2_000,
      });
    },
  );

  it("cold-after-reload: a transient failure with no previous envelope has nothing to retain", () => {
    const envelope = buildProviderRateLimitEnvelope(
      undefined,
      response(unavailable("usage_fetch_failed")),
      1_000,
    );
    expect(envelope).toEqual({
      latest: unavailable("usage_fetch_failed"),
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: 1_000,
    });
  });

  it("an authoritative reason (rate_limits_not_available) replaces the picture entirely, clearing any retained lastGood", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: GOOD,
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: 500,
    };
    const envelope = buildProviderRateLimitEnvelope(
      previous,
      response(unavailable("rate_limits_not_available")),
      2_000,
    );
    expect(envelope).toEqual({
      latest: unavailable("rate_limits_not_available"),
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
  });

  it("a fresh good reading replaces an older lastGood and clears lastFailureAt tracking forward, keeping only the new lastGoodAt", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: unavailable("usage_fetch_failed"),
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: 1_500,
    };
    const envelope = buildProviderRateLimitEnvelope(
      previous,
      response(OTHER_GOOD),
      2_000,
    );
    expect(envelope).toEqual({
      latest: OTHER_GOOD,
      lastGood: OTHER_GOOD,
      lastGoodAt: 2_000,
      // lastFailureAt is preserved (still true that a failure happened at
      // some point) until either another failure or an authoritative
      // unavailable reason updates it again.
      lastFailureAt: 1_500,
    });
  });

  it("treats a null provider snapshot (aperture-only response) like an authoritative reset", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: GOOD,
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: null,
    };
    const envelope = buildProviderRateLimitEnvelope(
      previous,
      response(null),
      2_000,
    );
    expect(envelope).toEqual({
      latest: null,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
  });
});

describe("resolveRetainedProviderRateLimits", () => {
  it("is null for a null envelope (cold, no fetch has ever landed)", () => {
    expect(resolveRetainedProviderRateLimits(null)).toBeNull();
  });

  it("is null when the envelope carries no provider snapshot", () => {
    expect(
      resolveRetainedProviderRateLimits({
        latest: null,
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: null,
      }),
    ).toBeNull();
  });

  it("returns the fresh reading when latest is available", () => {
    expect(
      resolveRetainedProviderRateLimits({
        latest: GOOD,
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: null,
      }),
    ).toEqual(GOOD);
  });

  it("returns the retained lastGood for a transient failure with one present", () => {
    expect(
      resolveRetainedProviderRateLimits({
        latest: unavailable("timeout"),
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: 2_000,
      }),
    ).toEqual(GOOD);
  });

  it("returns the raw unavailable arm for a transient failure with no lastGood (cold-after-reload)", () => {
    const latest = unavailable("connection_failed");
    expect(
      resolveRetainedProviderRateLimits({
        latest,
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: 1_000,
      }),
    ).toEqual(latest);
  });

  it("returns the raw unavailable arm for an authoritative reason, never the retained lastGood", () => {
    const latest = unavailable("rate_limits_not_available");
    expect(
      resolveRetainedProviderRateLimits({
        latest,
        // Shouldn't normally coexist (an authoritative reason clears
        // lastGood per buildProviderRateLimitEnvelope), but proves the
        // resolver itself never substitutes lastGood for a non-transient
        // reason even if one were somehow present.
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: null,
      }),
    ).toEqual(latest);
  });
});

describe("envelopeDegradedReason", () => {
  it("is null for a null envelope", () => {
    expect(envelopeDegradedReason(null)).toBeNull();
  });

  it("is null when latest is a fresh good reading", () => {
    expect(
      envelopeDegradedReason({
        latest: GOOD,
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: null,
      }),
    ).toBeNull();
  });

  it("is the transient reason when a lastGood is being shown in its place", () => {
    expect(
      envelopeDegradedReason({
        latest: unavailable("usage_fetch_failed"),
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: 2_000,
      }),
    ).toBe("usage_fetch_failed");
  });

  it("is null for an authoritative reason (that replaces, never dims)", () => {
    expect(
      envelopeDegradedReason({
        latest: unavailable("rate_limits_not_available"),
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: null,
      }),
    ).toBeNull();
  });

  it("is null for a transient reason with no lastGood to dim", () => {
    expect(
      envelopeDegradedReason({
        latest: unavailable("timeout"),
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: 1_000,
      }),
    ).toBeNull();
  });
});
