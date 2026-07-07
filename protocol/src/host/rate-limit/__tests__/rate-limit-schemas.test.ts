import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  providerRateLimitsSchema,
  rateLimitUsageRequestSchemaV12,
  rateLimitUsageResponseSchemaV12,
} from "@traycer/protocol/host/rate-limit/schemas";

// `providerRateLimitsSchema` is a plain `z.union`, not a `z.discriminatedUnion`,
// because its "unavailable" arm's `provider` field ranges over the full
// provider-id enum, which overlaps the `"codex"` / `"claude-code"` literals the
// other two arms use as their tag. A `z.discriminatedUnion` with that overlap
// throws a raw (non-`ZodError`) "Duplicate discriminator value" error the first
// time it's parsed - `safeParse` can't catch it, so these tests must call
// `.parse()`/`.safeParse()` for real to catch a regression back to
// `discriminatedUnion`.
describe("providerRateLimitsSchema", () => {
  it("parses an available codex snapshot with per-limit breakdown and reset credits", () => {
    const codex = {
      provider: "codex" as const,
      available: true as const,
      planType: "plus",
      limitId: "plus-primary",
      limitName: "Plus",
      primary: { usedPercent: 42, resetsAt: 1735689600000, durationMinutes: 300 },
      secondary: null,
      extraWindows: [
        {
          limitId: "plus-secondary",
          limitName: "Plus (weekly)",
          primary: { usedPercent: 12, resetsAt: 1735776000000, durationMinutes: 10080 },
          secondary: null,
        },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "10.00" },
      individualLimit: null,
      resetCredits: {
        availableCount: 2,
      },
      rateLimitReachedType: null,
    };
    expect(providerRateLimitsSchema.parse(codex)).toEqual(codex);
  });

  it("parses an available claude-code snapshot with window durations", () => {
    const claudeCode = {
      provider: "claude-code" as const,
      available: true as const,
      subscriptionType: "max",
      fiveHour: { usedPercent: 10, resetsAt: null, durationMinutes: 300 },
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [
        { displayName: "Opus", usedPercent: 5, resetsAt: null, durationMinutes: null },
      ],
      extraUsage: null,
    };
    expect(providerRateLimitsSchema.parse(claudeCode)).toEqual(claudeCode);
  });

  it("parses an available openrouter snapshot", () => {
    const openRouter = {
      provider: "openrouter" as const,
      available: true as const,
      limit: 100,
      limitRemaining: 40,
      dailySpend: 1.5,
      weeklySpend: 10.25,
      monthlySpend: 42,
      totalCredits: 100,
      totalUsage: 58,
      balance: 42,
    };
    expect(providerRateLimitsSchema.parse(openRouter)).toEqual(openRouter);
  });

  it("parses an available kilocode snapshot", () => {
    const kiloCode = {
      provider: "kilocode" as const,
      available: true as const,
      creditBalance: 25.5,
      passState: "active",
    };
    expect(providerRateLimitsSchema.parse(kiloCode)).toEqual(kiloCode);
  });

  it("parses an unavailable snapshot for a provider id shared with an available arm", () => {
    const unavailable = {
      provider: "codex" as const,
      available: false as const,
      reason: "timeout" as const,
    };
    expect(providerRateLimitsSchema.parse(unavailable)).toEqual(unavailable);

    const claudeUnavailable = {
      provider: "claude-code" as const,
      available: false as const,
      reason: "rate_limits_not_available" as const,
    };
    expect(providerRateLimitsSchema.parse(claudeUnavailable)).toEqual(
      claudeUnavailable,
    );
  });

  it("parses an unavailable snapshot with the insufficient_permissions reason", () => {
    const unavailable = {
      provider: "droid" as const,
      available: false as const,
      reason: "insufficient_permissions" as const,
    };
    expect(providerRateLimitsSchema.parse(unavailable)).toEqual(unavailable);
  });

  it("rejects a reason outside the closed unavailable-reason set", () => {
    const invalid = {
      provider: "codex" as const,
      available: false as const,
      reason: "not_logged_in",
    };
    expect(providerRateLimitsSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("rateLimitUsageRequestSchemaV12", () => {
  it("parses a request without providerId, leaving it undefined", () => {
    const request = rateLimitUsageRequestSchemaV12.parse({
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
    });
    expect(request.providerId).toBeUndefined();
  });

  it("preserves providerId when the request asks for a specific provider", () => {
    const request = rateLimitUsageRequestSchemaV12.parse({
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "codex",
    });
    expect(request.providerId).toBe("codex");
  });
});

describe("rateLimitUsageResponseSchemaV12", () => {
  it("parses a response carrying a provider rate-limit snapshot", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: {
        provider: "codex" as const,
        available: true as const,
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
      },
    };
    expect(rateLimitUsageResponseSchemaV12.parse(response)).toEqual(response);
  });

  it("parses a response with providerRateLimits: null (aperture-only call)", () => {
    const response = {
      totalTokens: 100,
      remainingTokens: 50,
      providerRateLimits: null,
    };
    expect(rateLimitUsageResponseSchemaV12.parse(response)).toEqual(response);
  });
});
