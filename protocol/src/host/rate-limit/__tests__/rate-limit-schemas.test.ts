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
  it("parses an available codex snapshot", () => {
    const codex = {
      provider: "codex" as const,
      available: true as const,
      planType: "plus",
      primary: { usedPercent: 42, resetsAt: 1735689600000 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: "10.00" },
      individualLimit: null,
      rateLimitReachedType: null,
    };
    expect(providerRateLimitsSchema.parse(codex)).toEqual(codex);
  });

  it("parses an available claude-code snapshot", () => {
    const claudeCode = {
      provider: "claude-code" as const,
      available: true as const,
      subscriptionType: "max",
      fiveHour: { usedPercent: 10, resetsAt: null },
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [{ displayName: "Opus", usedPercent: 5, resetsAt: null }],
      extraUsage: null,
    };
    expect(providerRateLimitsSchema.parse(claudeCode)).toEqual(claudeCode);
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
        primary: null,
        secondary: null,
        credits: null,
        individualLimit: null,
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
