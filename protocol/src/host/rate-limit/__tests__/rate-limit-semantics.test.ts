import { describe, expect, it } from "vitest";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
  RateLimitUnavailableReason,
} from "../schemas";
import { rateLimitUnavailableReasonSchemaV2 } from "../schemas";
import {
  classifyProviderRateLimits,
  classifyProviderRateLimitWindow,
  isTransientProviderRateLimitFailure,
  isTransientRateLimitUnavailableReason,
  liveProviderRateLimitWindows,
} from "../semantics";

const NOW = 1_000_000;

function window(
  usedPercent: number,
  durationMinutes: number | null,
  resetsAt: number | null,
): ProviderRateLimitWindow {
  return { usedPercent, durationMinutes, resetsAt };
}

function claude(
  fiveHour: ProviderRateLimitWindow | null,
  sevenDay: ProviderRateLimitWindow | null,
): ProviderRateLimits {
  return {
    provider: "claude-code",
    available: true,
    subscriptionType: null,
    fiveHour,
    sevenDay,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    modelScoped: [],
    extraUsage: null,
  };
}

function codex(
  primary: ProviderRateLimitWindow | null,
  rateLimitReachedType: string | null,
): ProviderRateLimits {
  return {
    provider: "codex",
    available: true,
    planType: null,
    limitId: null,
    limitName: null,
    primary,
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType,
  };
}

describe("classifyProviderRateLimitWindow", () => {
  it("warns short windows at 80% and long or undated windows at 95%", () => {
    expect(classifyProviderRateLimitWindow(window(79, 300, null))).toBe(
      "healthy",
    );
    expect(classifyProviderRateLimitWindow(window(80, 300, null))).toBe(
      "running_low",
    );
    expect(classifyProviderRateLimitWindow(window(94, 10_080, null))).toBe(
      "healthy",
    );
    expect(classifyProviderRateLimitWindow(window(95, 10_080, null))).toBe(
      "running_low",
    );
    expect(classifyProviderRateLimitWindow(window(94, null, null))).toBe(
      "healthy",
    );
    expect(classifyProviderRateLimitWindow(window(95, null, null))).toBe(
      "running_low",
    );
  });

  it("reports Limited at 100% for every duration", () => {
    expect(classifyProviderRateLimitWindow(window(100, 300, null))).toBe(
      "limited",
    );
    expect(classifyProviderRateLimitWindow(window(100, null, null))).toBe(
      "limited",
    );
  });
});

describe("classifyProviderRateLimits", () => {
  it("uses the most severe live window in a mixed snapshot", () => {
    expect(
      classifyProviderRateLimits(
        claude(window(80, 300, NOW + 1), window(96, 10_080, NOW + 1)),
        NOW,
      ),
    ).toBe("running_low");
  });

  it("ignores expired windows and becomes Unknown when all have expired", () => {
    const mixed = claude(
      window(100, 300, NOW - 1),
      window(40, 10_080, NOW + 1),
    );
    expect(liveProviderRateLimitWindows(mixed, NOW)).toEqual([
      window(40, 10_080, NOW + 1),
    ]);
    expect(classifyProviderRateLimits(mixed, NOW)).toBe("healthy");
    expect(
      classifyProviderRateLimits(
        claude(window(100, 300, NOW), window(96, 10_080, NOW - 1)),
        NOW,
      ),
    ).toBe("unknown");
  });

  it("returns Unknown for missing or unavailable detail", () => {
    expect(classifyProviderRateLimits(claude(null, null), NOW)).toBe("unknown");
    expect(
      classifyProviderRateLimits(
        { provider: "claude-code", available: false, reason: "timeout" },
        NOW,
      ),
    ).toBe("unknown");
  });

  it("honors a provider-authoritative hard-limit signal", () => {
    expect(
      classifyProviderRateLimits(
        codex(window(12, 300, NOW + 1), "primary"),
        NOW,
      ),
    ).toBe("limited");
  });

  it("discards an authoritative signal from a fully expired capture", () => {
    expect(
      classifyProviderRateLimits(
        codex(window(100, 300, NOW - 1), "primary"),
        NOW,
      ),
    ).toBe("unknown");
  });

  it("treats an OpenCode rate-limited window as limited even at a low percent", () => {
    expect(
      classifyProviderRateLimits(
        {
          provider: "opencode",
          available: true,
          credentialGeneration: "gen-1",
          fiveHour: {
            status: "rate-limited",
            usedPercent: 12,
            resetsAt: NOW + 1,
            durationMinutes: 300,
          },
          weekly: {
            status: "ok",
            usedPercent: 8,
            resetsAt: NOW + 1,
            durationMinutes: 10_080,
          },
          monthly: {
            status: "ok",
            usedPercent: 4,
            resetsAt: NOW + 1,
            durationMinutes: null,
          },
        },
        NOW,
      ),
    ).toBe("limited");
  });

  it("does not treat an expired OpenCode rate-limited window as limited", () => {
    expect(
      classifyProviderRateLimits(
        {
          provider: "opencode",
          available: true,
          credentialGeneration: "gen-1",
          fiveHour: {
            status: "rate-limited",
            usedPercent: 12,
            resetsAt: NOW - 1,
            durationMinutes: 300,
          },
          weekly: {
            status: "ok",
            usedPercent: 8,
            resetsAt: NOW - 1,
            durationMinutes: 10_080,
          },
          monthly: {
            status: "ok",
            usedPercent: 4,
            resetsAt: NOW - 1,
            durationMinutes: null,
          },
        },
        NOW,
      ),
    ).toBe("unknown");
  });
});

// The distinction is load-bearing on both sides of the wire (see
// `isTransientRateLimitUnavailableReason`'s doc comment): `usage_fetch_failed`
// / `timeout` / `connection_failed` describe a failed ATTEMPT and must not
// replace a previously retained reading; every other reason is authoritative.
// Iterating the live v2 enum (rather than a fixed local list) means a reason
// added to the enum later is automatically exercised here too - it cannot go
// silently unclassified.
const TRANSIENT_REASONS: ReadonlySet<RateLimitUnavailableReason> = new Set([
  "usage_fetch_failed",
  "timeout",
  "connection_failed",
]);

describe("isTransientRateLimitUnavailableReason / isTransientProviderRateLimitFailure", () => {
  it("classifies every value of the v2 reason enum", () => {
    // Positive control: a loop over an empty/miscollected list would pass
    // vacuously and prove nothing - guard against that before trusting the
    // loop below.
    expect(rateLimitUnavailableReasonSchemaV2.options.length).toBeGreaterThan(
      0,
    );
    for (const reason of rateLimitUnavailableReasonSchemaV2.options) {
      expect(isTransientRateLimitUnavailableReason(reason)).toBe(
        TRANSIENT_REASONS.has(reason),
      );
    }
  });

  it("mirrors the same classification at the snapshot level for every unavailable reason", () => {
    for (const reason of rateLimitUnavailableReasonSchemaV2.options) {
      const rateLimits: ProviderRateLimits = {
        provider: "claude-code",
        available: false,
        reason,
      };
      expect(isTransientProviderRateLimitFailure(rateLimits)).toBe(
        TRANSIENT_REASONS.has(reason),
      );
    }
  });

  it("is never transient for an available: true snapshot - it IS the reading", () => {
    expect(
      isTransientProviderRateLimitFailure(claude(window(10, 300, null), null)),
    ).toBe(false);
  });
});
