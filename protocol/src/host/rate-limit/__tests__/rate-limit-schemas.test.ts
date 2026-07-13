import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import { hostGetRateLimitUsageDowngradeV2ToV1 } from "@traycer/protocol/host/rate-limit/contracts";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providerRateLimitsSchema,
  providersConsumeRateLimitResetCreditRequestSchema,
  providersConsumeRateLimitResetCreditResponseSchema,
  rateLimitUnavailableReasonSchemaV1,
  rateLimitUnavailableReasonSchemaV2,
  rateLimitUsageRequestSchemaV12,
  rateLimitUsageResponseSchemaV12,
  rateLimitUsageResponseSchemaV20,
} from "@traycer/protocol/host/rate-limit/schemas";

describe("providers.consumeRateLimitResetCredit schemas", () => {
  it("accepts a profile-scoped idempotent Codex reset request and every upstream outcome", () => {
    expect(
      providersConsumeRateLimitResetCreditRequestSchema.parse({
        providerId: "codex",
        profileId: "personal",
        idempotencyKey: "reset-attempt-1",
      }),
    ).toEqual({
      providerId: "codex",
      profileId: "personal",
      idempotencyKey: "reset-attempt-1",
    });

    expect(
      providersConsumeRateLimitResetCreditRequestSchema.parse({
        providerId: "codex",
        profileId: null,
        idempotencyKey: "reset-attempt-ambient",
      }),
    ).toEqual({
      providerId: "codex",
      profileId: null,
      idempotencyKey: "reset-attempt-ambient",
    });

    ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"].forEach(
      (outcome) => {
        expect(
          providersConsumeRateLimitResetCreditResponseSchema.parse({ outcome }),
        ).toEqual({ outcome });
      },
    );
  });

  it("rejects another provider and an empty idempotency key", () => {
    expect(
      providersConsumeRateLimitResetCreditRequestSchema.safeParse({
        providerId: "claude-code",
        profileId: null,
        idempotencyKey: "attempt",
      }).success,
    ).toBe(false);
    expect(
      providersConsumeRateLimitResetCreditRequestSchema.safeParse({
        providerId: "codex",
        profileId: null,
        idempotencyKey: "",
      }).success,
    ).toBe(false);
  });
});

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
      primary: {
        usedPercent: 42,
        resetsAt: 1735689600000,
        durationMinutes: 300,
      },
      secondary: null,
      extraWindows: [
        {
          limitId: "plus-secondary",
          limitName: "Plus (weekly)",
          primary: {
            usedPercent: 12,
            resetsAt: 1735776000000,
            durationMinutes: 10080,
          },
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
        {
          displayName: "Opus",
          usedPercent: 5,
          resetsAt: null,
          durationMinutes: null,
        },
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

// `host.getRateLimitUsage` major 2.0 - splits the conflated
// `rate_limits_not_available` reason by adding `usage_fetch_failed` (v2-only).
// The v1 reason enum is frozen (see `rateLimitUnavailableReasonSchemaV1` in
// `rate-limit/schemas.ts`), so the still-installed v1.2 response schema must
// keep rejecting the new value - the downgrade bridge below is the only
// place that ever translates it back to something a v1.2 client accepts.
describe("rateLimitUnavailableReasonSchemaV1 / rateLimitUnavailableReasonSchemaV2", () => {
  it("keeps the v1 enum rejecting usage_fetch_failed", () => {
    expect(
      rateLimitUnavailableReasonSchemaV1.safeParse("usage_fetch_failed")
        .success,
    ).toBe(false);
  });

  it("accepts every frozen v1 reason on both the v1 and v2 enums", () => {
    for (const reason of rateLimitUnavailableReasonSchemaV1.options) {
      expect(rateLimitUnavailableReasonSchemaV1.safeParse(reason).success).toBe(
        true,
      );
      expect(rateLimitUnavailableReasonSchemaV2.safeParse(reason).success).toBe(
        true,
      );
    }
  });

  it("only the v2 enum accepts usage_fetch_failed", () => {
    expect(
      rateLimitUnavailableReasonSchemaV2.safeParse("usage_fetch_failed")
        .success,
    ).toBe(true);
  });
});

describe("host.getRateLimitUsage v2.0 -> v1.2 downgrade bridge", () => {
  const availableArms = [
    {
      provider: "codex" as const,
      available: true as const,
      planType: "plus",
      limitId: "plus-primary",
      limitName: "Plus",
      primary: {
        usedPercent: 42,
        resetsAt: 1735689600000,
        durationMinutes: 300,
      },
      secondary: null,
      extraWindows: [],
      credits: null,
      individualLimit: null,
      resetCredits: null,
      rateLimitReachedType: null,
    },
    {
      provider: "claude-code" as const,
      available: true as const,
      subscriptionType: "max",
      fiveHour: { usedPercent: 10, resetsAt: null, durationMinutes: 300 },
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [],
      extraUsage: null,
    },
    {
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
    },
    {
      provider: "kilocode" as const,
      available: true as const,
      creditBalance: 25.5,
      passState: "active",
    },
  ];

  it("maps usage_fetch_failed down to rate_limits_not_available", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: {
        provider: "claude-code" as const,
        available: false as const,
        reason: "usage_fetch_failed" as const,
      },
    };
    expect(
      hostGetRateLimitUsageDowngradeV2ToV1.downgradeResponse(response),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "claude-code",
          available: false,
          reason: "rate_limits_not_available",
        },
      },
    });
  });

  it("passes every other v1 reason through byte-identical", () => {
    for (const reason of rateLimitUnavailableReasonSchemaV1.options) {
      const response = {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "codex" as const,
          available: false as const,
          reason,
        },
      };
      expect(
        hostGetRateLimitUsageDowngradeV2ToV1.downgradeResponse(response),
      ).toEqual({ ok: true, value: response });
    }
  });

  it("passes every available:true provider arm through byte-identical", () => {
    for (const providerRateLimits of availableArms) {
      const response = {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits,
      };
      expect(
        hostGetRateLimitUsageDowngradeV2ToV1.downgradeResponse(response),
      ).toEqual({ ok: true, value: response });
    }
  });

  it("passes providerRateLimits: null through unchanged", () => {
    const response = {
      totalTokens: 100,
      remainingTokens: 50,
      providerRateLimits: null,
    };
    expect(
      hostGetRateLimitUsageDowngradeV2ToV1.downgradeResponse(response),
    ).toEqual({ ok: true, value: response });
  });

  it("downgrades the request as the identity", () => {
    const request = rateLimitUsageRequestSchemaV12.parse({
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "claude-code",
    });
    expect(
      hostGetRateLimitUsageDowngradeV2ToV1.downgradeRequest(request),
    ).toEqual({ ok: true, value: request });
  });

  it("downgrades usage_fetch_failed through the host registry", () => {
    const response = rateLimitUsageResponseSchemaV20.parse({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: {
        provider: "claude-code",
        available: false,
        reason: "usage_fetch_failed",
      },
    });
    expect(
      downgradeResponseAcrossMajors(
        hostRpcRegistry["host.getRateLimitUsage"],
        2,
        1,
        response,
      ),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "claude-code",
          available: false,
          reason: "rate_limits_not_available",
        },
      },
    });
  });

  it("rejects usage_fetch_failed in the v1.2 response schema directly", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: {
        provider: "claude-code",
        available: false,
        reason: "usage_fetch_failed",
      },
    };
    expect(rateLimitUsageResponseSchemaV12.safeParse(response).success).toBe(
      false,
    );
  });

  it("registers host.getRateLimitUsage major 2.0 in the host registry", () => {
    expect(
      hostRpcRegistry["host.getRateLimitUsage"][2].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(
      hostRpcRegistry["host.getRateLimitUsage"][1].versions[2].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 2 });
  });
});
