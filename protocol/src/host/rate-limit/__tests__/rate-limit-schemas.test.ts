import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import {
  hostGetRateLimitUsageDowngradeV2ToV1,
  hostGetRateLimitUsageDowngradeV3ToV1,
  hostGetRateLimitUsageDowngradeV3ToV2,
  hostGetRateLimitUsageDowngradeV4ToV1,
  hostGetRateLimitUsageDowngradeV4ToV2,
  hostGetRateLimitUsageDowngradeV4ToV3,
  hostGetRateLimitUsageUpgradeV20ToV21,
  hostGetRateLimitUsageUpgradeV21ToV30,
} from "@traycer/protocol/host/rate-limit/contracts";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providerRateLimitsSchema,
  providerRateLimitsSchemaV30,
  providersConsumeRateLimitResetCreditRequestSchema,
  providersConsumeRateLimitResetCreditResponseSchema,
  rateLimitUnavailableReasonSchemaV1,
  rateLimitUnavailableReasonSchemaV2,
  rateLimitUsageRequestSchemaV12,
  rateLimitUsageResponseSchemaV12,
  rateLimitUsageResponseSchemaV20,
  rateLimitUsageResponseSchemaV21,
  rateLimitUsageResponseSchemaV30,
} from "@traycer/protocol/host/rate-limit/schemas";

describe("providers.consumeRateLimitResetCredit schemas", () => {
  it("accepts a profile-scoped idempotent Codex reset request and every upstream outcome", () => {
    expect(
      providersConsumeRateLimitResetCreditRequestSchema.parse({
        providerId: "codex",
        profileId: "personal",
        idempotencyKey: "reset-attempt-1",
        creditId: "credit-1",
      }),
    ).toEqual({
      providerId: "codex",
      profileId: "personal",
      idempotencyKey: "reset-attempt-1",
      creditId: "credit-1",
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
      creditId: null,
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
    expect(
      providersConsumeRateLimitResetCreditRequestSchema.safeParse({
        providerId: "codex",
        profileId: null,
        idempotencyKey: "attempt",
        creditId: "",
      }).success,
    ).toBe(false);
  });
});

describe("host.getRateLimitUsage v2.1 reset-credit detail", () => {
  const detailedResponse = {
    totalTokens: 0,
    remainingTokens: 0,
    providerRateLimits: {
      provider: "codex" as const,
      available: true as const,
      planType: "plus",
      limitId: "codex",
      limitName: "Codex",
      primary: null,
      secondary: null,
      extraWindows: [],
      credits: null,
      individualLimit: null,
      resetCredits: {
        availableCount: 1,
        credits: [
          {
            id: "credit-1",
            resetType: "codexRateLimits" as const,
            status: "available" as const,
            grantedAt: 1735689600000,
            expiresAt: 1735776000000,
            title: "Manual reset",
            description: null,
          },
        ],
      },
      rateLimitReachedType: null,
    },
  };

  it("strips additive per-credit detail through the frozen v2.0 schema", () => {
    const response = rateLimitUsageResponseSchemaV21.parse(detailedResponse);
    expect(rateLimitUsageResponseSchemaV20.parse(response)).toEqual({
      ...detailedResponse,
      providerRateLimits: {
        ...detailedResponse.providerRateLimits,
        resetCredits: { availableCount: 1 },
      },
    });
  });

  it("fills a count-only v2 response with null detail when upgrading", () => {
    const response = rateLimitUsageResponseSchemaV20.parse({
      ...detailedResponse,
      providerRateLimits: {
        ...detailedResponse.providerRateLimits,
        resetCredits: { availableCount: 1 },
      },
    });
    expect(
      hostGetRateLimitUsageUpgradeV20ToV21.upgradeResponse(response),
    ).toEqual({
      ...detailedResponse,
      providerRateLimits: {
        ...detailedResponse.providerRateLimits,
        resetCredits: { availableCount: 1, credits: null },
      },
    });
  });

  it("downgrades v2.1 detail to v1.2 through the host registry", () => {
    expect(
      downgradeResponseAcrossMajors(
        hostRpcRegistry["host.getRateLimitUsage"],
        2,
        1,
        rateLimitUsageResponseSchemaV21.parse(detailedResponse),
      ),
    ).toEqual({
      ok: true,
      value: {
        ...detailedResponse,
        providerRateLimits: {
          ...detailedResponse.providerRateLimits,
          resetCredits: { availableCount: 1 },
        },
      },
    });
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
        credits: [
          {
            id: "credit-1",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: 1735689600000,
            expiresAt: 1735776000000,
            title: "Manual reset",
            description: null,
          },
        ],
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
    const response = rateLimitUsageResponseSchemaV21.parse({
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

// `host.getRateLimitUsage` major 3.0 - adds the grok available arm. Frozen
// v2.1 / v1.2 unions have no grok arm, so the 3 -> 2 and 3 -> 1 downgrade
// bridges degrade a grok-available snapshot to
// `{ provider: "grok", available: false, reason: "unsupported_provider" }`
// (the exact row a pre-grok host returns for grok) and reparse through the
// frozen response schema. 3 -> 1 also composes the existing
// `usage_fetch_failed` -> `rate_limits_not_available` mapping.
describe("host.getRateLimitUsage v3.0 -> v2.1 / v1.2 grok downgrade bridges", () => {
  const grokAvailableWithPeriod = {
    provider: "grok" as const,
    available: true as const,
    subscriptionTier: "SuperGrok",
    periodType: "USAGE_PERIOD_TYPE_WEEKLY",
    periodStart: 1753142400000,
    periodEnd: 1753747200000,
    period: {
      usedPercent: 12,
      resetsAt: 1753747200000,
      durationMinutes: 10080,
    },
    monthlyLimit: null,
    onDemandCap: 0,
    onDemandUsed: 0,
    prepaidBalance: 0,
  };

  const grokAvailablePeriodLess = {
    provider: "grok" as const,
    available: true as const,
    subscriptionTier: "SuperGrok",
    periodType: "USAGE_PERIOD_TYPE_WEEKLY",
    periodStart: 1753142400000,
    periodEnd: 1753747200000,
    period: null,
    monthlyLimit: null,
    onDemandCap: null,
    onDemandUsed: null,
    prepaidBalance: null,
  };

  const grokUnavailable = {
    provider: "grok" as const,
    available: false as const,
    reason: "unsupported_provider" as const,
  };

  const codexAvailable = {
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
  };

  it("parses a grok-available snapshot on the live union and rejects it on the frozen v2.1 schema", () => {
    expect(providerRateLimitsSchema.parse(grokAvailableWithPeriod)).toEqual(
      grokAvailableWithPeriod,
    );
    expect(providerRateLimitsSchema.parse(grokAvailablePeriodLess)).toEqual(
      grokAvailablePeriodLess,
    );
    expect(
      rateLimitUsageResponseSchemaV30.parse({
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: grokAvailableWithPeriod,
      }),
    ).toMatchObject({
      providerRateLimits: { provider: "grok", available: true },
    });
    // The frozen v2.1 response has no grok arm - without the bridge map a
    // reparse would fail, which is exactly why the bridge exists.
    expect(
      rateLimitUsageResponseSchemaV21.safeParse({
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: grokAvailableWithPeriod,
      }).success,
    ).toBe(false);
  });

  it("rejects a grok period whose reset disagrees with its period end", () => {
    expect(
      providerRateLimitsSchema.safeParse({
        ...grokAvailableWithPeriod,
        period: {
          ...grokAvailableWithPeriod.period,
          resetsAt: grokAvailableWithPeriod.periodEnd + 1,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a grok period with no reset when its period end is known", () => {
    expect(
      providerRateLimitsSchema.safeParse({
        ...grokAvailableWithPeriod,
        period: {
          ...grokAvailableWithPeriod.period,
          resetsAt: null,
        },
      }).success,
    ).toBe(false);
  });

  it("degrades a grok-available (with period) snapshot through the 3.0 -> 2.1 bridge", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokAvailableWithPeriod,
    };
    expect(
      hostGetRateLimitUsageDowngradeV3ToV2.downgradeResponse(response),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: grokUnavailable,
      },
    });
  });

  it("degrades a period-less grok-available snapshot through the 3.0 -> 2.1 bridge", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokAvailablePeriodLess,
    };
    expect(
      hostGetRateLimitUsageDowngradeV3ToV2.downgradeResponse(response),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: grokUnavailable,
      },
    });
  });

  it("passes non-grok available arms and null through the 3.0 -> 2.1 bridge unchanged", () => {
    const withCodex = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: codexAvailable,
    };
    expect(
      hostGetRateLimitUsageDowngradeV3ToV2.downgradeResponse(withCodex),
    ).toEqual({ ok: true, value: withCodex });

    const withNull = {
      totalTokens: 100,
      remainingTokens: 50,
      providerRateLimits: null,
    };
    expect(
      hostGetRateLimitUsageDowngradeV3ToV2.downgradeResponse(withNull),
    ).toEqual({ ok: true, value: withNull });
  });

  it("passes an already-unavailable grok snapshot through the 3.0 -> 2.1 bridge unchanged", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokUnavailable,
    };
    expect(
      hostGetRateLimitUsageDowngradeV3ToV2.downgradeResponse(response),
    ).toEqual({ ok: true, value: response });
  });

  it("downgrades the 3.0 -> 2.1 request as the identity", () => {
    const request = rateLimitUsageRequestSchemaV12.parse({
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "grok",
    });
    expect(
      hostGetRateLimitUsageDowngradeV3ToV2.downgradeRequest(request),
    ).toEqual({ ok: true, value: request });
  });

  it("degrades grok-available through the host registry major 3 -> 2 path", () => {
    const response = rateLimitUsageResponseSchemaV30.parse({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokAvailableWithPeriod,
    });
    expect(
      downgradeResponseAcrossMajors(
        hostRpcRegistry["host.getRateLimitUsage"],
        3,
        2,
        response,
      ),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: grokUnavailable,
      },
    });
  });

  it("degrades a grok-available snapshot through the 3.0 -> 1.2 bridge", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokAvailableWithPeriod,
    };
    expect(
      hostGetRateLimitUsageDowngradeV3ToV1.downgradeResponse(response),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: grokUnavailable,
      },
    });
  });

  it("maps usage_fetch_failed to rate_limits_not_available on the 3.0 -> 1.2 bridge", () => {
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: {
        provider: "codex" as const,
        available: false as const,
        reason: "usage_fetch_failed" as const,
      },
    };
    expect(
      hostGetRateLimitUsageDowngradeV3ToV1.downgradeResponse(response),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "codex",
          available: false,
          reason: "rate_limits_not_available",
        },
      },
    });
  });

  it("degrades grok-available through the host registry major 3 -> 1 path", () => {
    const response = rateLimitUsageResponseSchemaV30.parse({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokAvailablePeriodLess,
    });
    expect(
      downgradeResponseAcrossMajors(
        hostRpcRegistry["host.getRateLimitUsage"],
        3,
        1,
        response,
      ),
    ).toEqual({
      ok: true,
      value: {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: grokUnavailable,
      },
    });
  });

  it("maps usage_fetch_failed through the host registry major 3 -> 1 path", () => {
    const response = rateLimitUsageResponseSchemaV30.parse({
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
        3,
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

  it("upgrades a v2.1 response to v3.0 as the identity", () => {
    const response = rateLimitUsageResponseSchemaV21.parse({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: codexAvailable,
    });
    const upgraded =
      hostGetRateLimitUsageUpgradeV21ToV30.upgradeResponse(response);
    expect(upgraded).toEqual(response);
    expect(rateLimitUsageResponseSchemaV30.parse(upgraded)).toEqual(response);
  });

  it("registers host.getRateLimitUsage major 3.0 in the host registry", () => {
    expect(
      hostRpcRegistry["host.getRateLimitUsage"][3].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 3, minor: 0 });
    expect(
      hostRpcRegistry["host.getRateLimitUsage"][2].versions[1].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 1 });
  });
});

// ─── jcode: the v4.0 available arm ─────────────────────────────────────────
//
// `host.getRateLimitUsage@3.0` IS released (`host-v1.1.9`), and it served the
// LIVE union until the jcode work pinned it to `providerRateLimitsSchemaV30`.
// Without that pin the jcode available arm would have landed on an
// already-released response - and the registry's own validator proves the pin
// is load-bearing: reverting it makes the 3 -> 4 major bump non-breaking and
// `defineFloorAwareVersionedRpcRegistry` refuses to load at all.
describe("jcode rate-limit available arm and the 4.0 bridges", () => {
  // Local copies of the two cross-arm fixtures: the originals are scoped to the
  // v3.0 describe above, and the grok pair is needed here to prove the jcode
  // degrade does not take grok down with it.
  const grokAvailableWithPeriod = {
    provider: "grok" as const,
    available: true as const,
    subscriptionTier: "SuperGrok",
    periodType: "USAGE_PERIOD_TYPE_WEEKLY",
    periodStart: 1753142400000,
    periodEnd: 1753747200000,
    period: {
      usedPercent: 12,
      resetsAt: 1753747200000,
      durationMinutes: 10080,
    },
    monthlyLimit: null,
    onDemandCap: 0,
    onDemandUsed: 0,
    prepaidBalance: 0,
  };

  const grokUnavailable = {
    provider: "grok" as const,
    available: false as const,
    reason: "unsupported_provider" as const,
  };

  const codexAvailable = {
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
  };

  const jcodeAvailable = {
    provider: "jcode" as const,
    available: true as const,
    subProviders: [
      {
        // Percent CONSUMED, straight from jcode's `usage_percent`.
        subProviderId: "openrouter",
        limitName: "Credits",
        window: { usedPercent: 99.607, resetsAt: null, durationMinutes: null },
        hardLimitReached: false,
        error: null,
      },
      {
        // Only Antigravity and Copilot report a reset instant upstream.
        subProviderId: "copilot",
        limitName: "Premium requests",
        window: {
          usedPercent: 12,
          resetsAt: 1_700_000_000_000,
          durationMinutes: null,
        },
        hardLimitReached: false,
        error: null,
      },
      {
        // A failed fetch, NOT a healthy zero - distinguished by `error`.
        subProviderId: "anthropic",
        limitName: null,
        window: null,
        hardLimitReached: false,
        error: "401 after token refresh",
      },
    ],
  };

  const jcodeUnavailable = {
    provider: "jcode" as const,
    available: false as const,
    reason: "unsupported_provider" as const,
  };

  it("accepts the per-sub-provider list on the live union", () => {
    expect(providerRateLimitsSchema.safeParse(jcodeAvailable).success).toBe(
      true,
    );
  });

  it("accepts an empty sub-provider list as available (nothing to show != could not ask)", () => {
    expect(
      providerRateLimitsSchema.safeParse({
        provider: "jcode",
        available: true,
        subProviders: [],
      }).success,
    ).toBe(true);
  });

  it("keeps the jcode arm OFF the frozen v3.0 union", () => {
    // The whole reason v4.0 exists. If this ever passes, the freeze has been
    // widened and a released `host-v1.1.9` peer would receive an arm it cannot
    // decode.
    expect(providerRateLimitsSchemaV30.safeParse(jcodeAvailable).success).toBe(
      false,
    );
  });

  it.each([
    ["4.0 -> 3.0", hostGetRateLimitUsageDowngradeV4ToV3],
    ["4.0 -> 2.1", hostGetRateLimitUsageDowngradeV4ToV2],
    ["4.0 -> 1.2", hostGetRateLimitUsageDowngradeV4ToV1],
  ] as const)(
    "degrades a jcode-available snapshot to unsupported_provider through the %s bridge",
    (_label, bridge) => {
      const downgraded = bridge.downgradeResponse({
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: jcodeAvailable,
      });
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value.providerRateLimits).toEqual(jcodeUnavailable);
    },
  );

  it("passes non-jcode arms and null through the 4.0 -> 3.0 bridge unchanged", () => {
    const withCodex = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: codexAvailable,
    };
    expect(
      hostGetRateLimitUsageDowngradeV4ToV3.downgradeResponse(withCodex),
    ).toEqual({ ok: true, value: withCodex });

    const withNull = {
      totalTokens: 100,
      remainingTokens: 50,
      providerRateLimits: null,
    };
    expect(
      hostGetRateLimitUsageDowngradeV4ToV3.downgradeResponse(withNull),
    ).toEqual({ ok: true, value: withNull });
  });

  it("still degrades grok on the 4.0 -> 1.2 bridge (both maps compose)", () => {
    const downgraded = hostGetRateLimitUsageDowngradeV4ToV1.downgradeResponse({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokAvailableWithPeriod,
    });
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providerRateLimits).toEqual(grokUnavailable);
  });

  it("keeps the grok available arm on the 4.0 -> 3.0 bridge (v3.0 shipped with grok)", () => {
    // The jcode degrade must not accidentally take grok down with it - v3.0's
    // frozen union genuinely carries the grok arm.
    const response = {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: grokAvailableWithPeriod,
    };
    expect(
      hostGetRateLimitUsageDowngradeV4ToV3.downgradeResponse(response),
    ).toEqual({ ok: true, value: response });
  });
});
