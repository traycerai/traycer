import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import {
  buildProviderRateLimitEnvelope,
  NO_EPISODE,
  envelopeDegradedReason,
  isTransientUnavailableReason,
  mapResponseToProviderRateLimitEnvelope,
  resolveRetainedProviderRateLimits,
  type ProviderRateLimitEnvelope,
  type RateLimitUsageResponse,
} from "@/lib/rate-limits/rate-limit-envelope";

/**
 * The identity a `previous` envelope carries into a row. Negative on purpose:
 * the builder's counter only ever hands out positives, so a row comparing a
 * minted identity with this one cannot collide with it however many envelopes
 * the file has built before it.
 */
const PREVIOUS_EPISODE = -1;

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

const CODEX_WITH_RESET_DETAILS: ProviderRateLimits = {
  provider: "codex",
  available: true,
  planType: "plus",
  limitId: "codex",
  limitName: "Codex",
  primary: null,
  secondary: null,
  extraWindows: [],
  credits: null,
  individualLimit: null,
  resetCredits: {
    availableCount: 2,
    credits: [
      {
        id: "reset-1",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 500,
        expiresAt: 10_000,
        title: "Full reset",
        description: null,
      },
      {
        id: "reset-2",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 750,
        expiresAt: 20_000,
        title: "Full reset",
        description: null,
      },
    ],
  },
  rateLimitReachedType: null,
};

const GROK_GOOD: ProviderRateLimits = {
  provider: "grok",
  available: true,
  subscriptionTier: "SuperGrok",
  periodType: "USAGE_PERIOD_TYPE_WEEKLY",
  periodStart: 1_784_678_400_000,
  periodEnd: 1_785_283_200_000,
  period: {
    usedPercent: 12,
    resetsAt: 1_785_283_200_000,
    durationMinutes: 10_080,
  },
  monthlyLimit: null,
  onDemandCap: null,
  onDemandUsed: null,
  prepaidBalance: null,
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
    const { episode, ...rest } = envelope;
    expect(rest).toEqual({
      latest: GOOD,
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: null,
    });
    // The reading IS an answer about this account, so it names the episode any
    // run of failures after it belongs to.
    expect(episode).toBeGreaterThan(NO_EPISODE);
  });

  it.each(["usage_fetch_failed", "timeout", "connection_failed"] as const)(
    "retains a prior lastGood across a transient failure (%s), advancing lastFailureAt only",
    (reason) => {
      const previous: ProviderRateLimitEnvelope = {
        latest: GOOD,
        lastGood: GOOD,
        lastGoodAt: 1_000,
        lastFailureAt: null,
        episode: PREVIOUS_EPISODE,
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
        // A transient failure answers nothing, so the stamp stays where the
        // last answer put it: every failure in one run carries the same one,
        // which is what names the run.
        episode: PREVIOUS_EPISODE,
      });
    },
  );

  it("cold-after-reload: a transient failure with no previous envelope has nothing to retain", () => {
    const envelope = buildProviderRateLimitEnvelope(
      undefined,
      response(unavailable("usage_fetch_failed")),
      1_000,
    );
    const { episode, ...rest } = envelope;
    expect(rest).toEqual({
      latest: unavailable("usage_fetch_failed"),
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: 1_000,
    });
    expect(episode).toBeGreaterThan(NO_EPISODE);
  });

  it("retains OpenCode last-good only when a transient carries the same generation", () => {
    const openCodeGood: ProviderRateLimits = {
      provider: "opencode",
      available: true,
      credentialGeneration: "gen-a",
      fiveHour: {
        status: "ok",
        usedPercent: 10,
        resetsAt: 2_000,
        durationMinutes: 300,
      },
      weekly: {
        status: "ok",
        usedPercent: 20,
        resetsAt: 2_000,
        durationMinutes: 10_080,
      },
      monthly: {
        status: "ok",
        usedPercent: 30,
        resetsAt: 2_000,
        durationMinutes: null,
      },
    };
    const previous: ProviderRateLimitEnvelope = {
      latest: openCodeGood,
      lastGood: openCodeGood,
      lastGoodAt: 1_000,
      lastFailureAt: null,
      episode: PREVIOUS_EPISODE,
    };
    const sameGeneration: ProviderRateLimits = {
      provider: "opencode",
      available: false,
      reason: "usage_fetch_failed",
      credentialGeneration: "gen-a",
    };
    expect(
      buildProviderRateLimitEnvelope(previous, response(sameGeneration), 2_000),
    ).toEqual({
      latest: sameGeneration,
      lastGood: openCodeGood,
      lastGoodAt: 1_000,
      lastFailureAt: 2_000,
      episode: PREVIOUS_EPISODE,
    });
  });

  it("clears OpenCode last-good when the transient generation differs or is missing", () => {
    const openCodeGood: ProviderRateLimits = {
      provider: "opencode",
      available: true,
      credentialGeneration: "gen-a",
      fiveHour: {
        status: "ok",
        usedPercent: 10,
        resetsAt: 2_000,
        durationMinutes: 300,
      },
      weekly: {
        status: "ok",
        usedPercent: 20,
        resetsAt: 2_000,
        durationMinutes: 10_080,
      },
      monthly: {
        status: "ok",
        usedPercent: 30,
        resetsAt: 2_000,
        durationMinutes: null,
      },
    };
    const previous: ProviderRateLimitEnvelope = {
      latest: openCodeGood,
      lastGood: openCodeGood,
      lastGoodAt: 1_000,
      lastFailureAt: null,
      episode: PREVIOUS_EPISODE,
    };
    const differentGeneration: ProviderRateLimits = {
      provider: "opencode",
      available: false,
      reason: "timeout",
      credentialGeneration: "gen-b",
    };
    const { episode: differentEpisode, ...differentRest } =
      buildProviderRateLimitEnvelope(
        previous,
        response(differentGeneration),
        2_000,
      );
    expect(differentRest).toEqual({
      latest: differentGeneration,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: 2_000,
    });
    // And a NAMED different credential takes the run with the reading: see the
    // rotation rows below.
    expect(differentEpisode).not.toBe(PREVIOUS_EPISODE);

    const missingGeneration: ProviderRateLimits = {
      provider: "opencode",
      available: false,
      reason: "connection_failed",
    };
    const { episode: missingEpisode, ...missingRest } =
      buildProviderRateLimitEnvelope(
        previous,
        response(missingGeneration),
        3_000,
      );
    expect(missingRest).toEqual({
      latest: missingGeneration,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: 3_000,
    });
    // The two questions part here: a failure that names no credential cannot
    // be shown the old reading, and has not said the credential changed, so
    // the run it belongs to carries on.
    expect(missingEpisode).toBe(PREVIOUS_EPISODE);
  });

  it("an authoritative reason (rate_limits_not_available) replaces the picture entirely, clearing any retained lastGood", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: GOOD,
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: 500,
      episode: PREVIOUS_EPISODE,
    };
    const envelope = buildProviderRateLimitEnvelope(
      previous,
      response(unavailable("rate_limits_not_available")),
      2_000,
    );
    const { episode, ...rest } = envelope;
    expect(rest).toEqual({
      latest: unavailable("rate_limits_not_available"),
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
    // An authoritative reason answers the account as surely as a reading does,
    // so it ends whatever run of failures was under way.
    expect(episode).not.toBe(previous.episode);
  });

  it("a fresh good reading replaces an older lastGood and clears lastFailureAt tracking forward, keeping only the new lastGoodAt", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: unavailable("usage_fetch_failed"),
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: 1_500,
      episode: PREVIOUS_EPISODE,
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
      episode: envelope.episode,
    });
    expect(envelope.episode).not.toBe(previous.episode);
  });

  it("retains Codex reset-credit details when a refresh only reports the unchanged count", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: CODEX_WITH_RESET_DETAILS,
      lastGood: CODEX_WITH_RESET_DETAILS,
      lastGoodAt: 1_000,
      lastFailureAt: null,
      episode: PREVIOUS_EPISODE,
    };
    const countOnlyRefresh: ProviderRateLimits = {
      ...CODEX_WITH_RESET_DETAILS,
      primary: { usedPercent: 42, resetsAt: 30_000, durationMinutes: 300 },
      resetCredits: { availableCount: 2, credits: null },
    };
    const envelope = buildProviderRateLimitEnvelope(
      previous,
      response(countOnlyRefresh),
      2_000,
    );

    expect(envelope.latest).toEqual({
      ...countOnlyRefresh,
      resetCredits: CODEX_WITH_RESET_DETAILS.resetCredits,
    });
    expect(envelope.lastGood).toEqual(envelope.latest);
    expect(envelope.lastGoodAt).toBe(2_000);
  });

  it("does not retain Codex reset-credit details when the count changes", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: CODEX_WITH_RESET_DETAILS,
      lastGood: CODEX_WITH_RESET_DETAILS,
      lastGoodAt: 1_000,
      lastFailureAt: null,
      episode: PREVIOUS_EPISODE,
    };
    const countOnlyRefresh: ProviderRateLimits = {
      ...CODEX_WITH_RESET_DETAILS,
      resetCredits: { availableCount: 1, credits: null },
    };

    expect(
      buildProviderRateLimitEnvelope(
        previous,
        response(countOnlyRefresh),
        2_000,
      ).latest,
    ).toEqual(countOnlyRefresh);
  });

  it("does not replace an explicit empty Codex credit list with cached details", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: CODEX_WITH_RESET_DETAILS,
      lastGood: CODEX_WITH_RESET_DETAILS,
      lastGoodAt: 1_000,
      lastFailureAt: null,
      episode: PREVIOUS_EPISODE,
    };
    const emptyDetailRefresh: ProviderRateLimits = {
      ...CODEX_WITH_RESET_DETAILS,
      resetCredits: { availableCount: 2, credits: [] },
    };

    expect(
      buildProviderRateLimitEnvelope(
        previous,
        response(emptyDetailRefresh),
        2_000,
      ).latest,
    ).toEqual(emptyDetailRefresh);
  });

  it("treats a null provider snapshot (aperture-only response) like an authoritative reset", () => {
    const previous: ProviderRateLimitEnvelope = {
      latest: GOOD,
      lastGood: GOOD,
      lastGoodAt: 1_000,
      lastFailureAt: null,
      episode: PREVIOUS_EPISODE,
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
      episode: PREVIOUS_EPISODE,
    });
  });
});

describe("the episode an envelope names", () => {
  it("mints one for a reading, and a fresh one for every answer after it", () => {
    const first = buildProviderRateLimitEnvelope(
      undefined,
      response(GOOD),
      1_000,
    );
    // The same millisecond, deliberately: a run of failures is identified by
    // this value, and two answers that shared one would read as a single run -
    // the second of which would then be owed no scheduled read at all.
    const second = buildProviderRateLimitEnvelope(
      first,
      response(OTHER_GOOD),
      1_000,
    );
    expect(second.episode).not.toBe(first.episode);
  });

  it("carries one through a run of transient failures, and mints for a run that starts cold", () => {
    const answered = buildProviderRateLimitEnvelope(
      undefined,
      response(GOOD),
      1_000,
    );
    const failing = buildProviderRateLimitEnvelope(
      answered,
      response(unavailable("timeout")),
      2_000,
    );
    const failingAgain = buildProviderRateLimitEnvelope(
      failing,
      response(unavailable("connection_failed")),
      3_000,
    );
    expect(failing.episode).toBe(answered.episode);
    expect(failingAgain.episode).toBe(answered.episode);

    // Nothing to carry: a cold cache, or an entry collected while its provider
    // was hidden. That is the start of a run too, and its own.
    const cold = buildProviderRateLimitEnvelope(
      undefined,
      response(unavailable("timeout")),
      4_000,
    );
    expect(cold.episode).not.toBe(answered.episode);
  });

  it("mints for a failure that came back under another credential", () => {
    // OpenCode is the one provider whose readings name the credential they
    // were read with, and a rotation is the one thing that can make a run of
    // failures describe an account nobody is using any more. The reading goes
    // (`lastGood: null`, the row above), and the run has to go with it: the
    // read the old run already spent was spent on the old credential.
    const openCodeGood: ProviderRateLimits = {
      provider: "opencode",
      available: true,
      credentialGeneration: "gen-a",
      fiveHour: {
        status: "ok",
        usedPercent: 10,
        resetsAt: 2_000,
        durationMinutes: 300,
      },
      weekly: {
        status: "ok",
        usedPercent: 20,
        resetsAt: 2_000,
        durationMinutes: 10_080,
      },
      monthly: {
        status: "ok",
        usedPercent: 30,
        resetsAt: 2_000,
        durationMinutes: null,
      },
    };
    const answered = buildProviderRateLimitEnvelope(
      undefined,
      response(openCodeGood),
      1_000,
    );
    const sameCredential = buildProviderRateLimitEnvelope(
      answered,
      response({
        provider: "opencode",
        available: false,
        reason: "timeout",
        credentialGeneration: "gen-a",
      }),
      2_000,
    );
    const rotated = buildProviderRateLimitEnvelope(
      sameCredential,
      response({
        provider: "opencode",
        available: false,
        reason: "timeout",
        credentialGeneration: "gen-b",
      }),
      3_000,
    );
    const rotatedAgain = buildProviderRateLimitEnvelope(
      rotated,
      response({
        provider: "opencode",
        available: false,
        reason: "timeout",
        credentialGeneration: "gen-c",
      }),
      4_000,
    );

    expect(sameCredential.episode).toBe(answered.episode);
    expect(rotated.episode).not.toBe(answered.episode);
    // Including the second rotation, which is the one a comparison against the
    // RETAINED reading cannot see: the first rotation already dropped it, so
    // what gen-c differs from is the gen-b failure before it.
    expect(rotatedAgain.episode).not.toBe(rotated.episode);
  });

  it("carries one through an OpenCode run with no reading to retain", () => {
    // The trap under the row above: retention is also refused when there is no
    // OpenCode reading to compare at all, which is every failure of an account
    // that has never been read. Minting there would hand each failure in one
    // run its own identity, and the strip's one re-read per run would become
    // one per failure.
    const failing = buildProviderRateLimitEnvelope(
      undefined,
      response({
        provider: "opencode",
        available: false,
        reason: "timeout",
        credentialGeneration: "gen-a",
      }),
      1_000,
    );
    const failingAgain = buildProviderRateLimitEnvelope(
      failing,
      response({
        provider: "opencode",
        available: false,
        reason: "connection_failed",
        credentialGeneration: "gen-a",
      }),
      2_000,
    );
    const failingWithoutGeneration = buildProviderRateLimitEnvelope(
      failingAgain,
      response({
        provider: "opencode",
        available: false,
        reason: "timeout",
      }),
      3_000,
    );

    expect(failing.episode).toBeGreaterThan(NO_EPISODE);
    expect(failingAgain.episode).toBe(failing.episode);
    expect(failingWithoutGeneration.episode).toBe(failing.episode);
  });

  it("mints for an authoritative reason, which ends the run before it", () => {
    const failing = buildProviderRateLimitEnvelope(
      buildProviderRateLimitEnvelope(undefined, response(GOOD), 1_000),
      response(unavailable("timeout")),
      2_000,
    );
    const answered = buildProviderRateLimitEnvelope(
      failing,
      response(unavailable("cli_not_found")),
      3_000,
    );
    const failingAfter = buildProviderRateLimitEnvelope(
      answered,
      response(unavailable("timeout")),
      4_000,
    );
    expect(answered.episode).not.toBe(failing.episode);
    expect(failingAfter.episode).toBe(answered.episode);
    expect(failingAfter.episode).not.toBe(failing.episode);
  });

  it("is not a clock reading, so a clock corrected backwards still names a distinct run", () => {
    const answered = buildProviderRateLimitEnvelope(
      undefined,
      response(unavailable("cli_not_found")),
      10_000,
    );
    const failing = buildProviderRateLimitEnvelope(
      answered,
      response(unavailable("timeout")),
      11_000,
    );
    // The clock goes back an hour between the two answers, which is what a
    // correction does, and dates the second one where the first was.
    const answeredAgain = buildProviderRateLimitEnvelope(
      failing,
      response(unavailable("cli_not_found")),
      10_000,
    );
    const failingAgain = buildProviderRateLimitEnvelope(
      answeredAgain,
      response(unavailable("timeout")),
      10_000,
    );
    expect(answeredAgain.episode).not.toBe(answered.episode);
    expect(failingAgain.episode).not.toBe(failing.episode);
  });

  it("carries one through a response with no provider snapshot", () => {
    const failing = buildProviderRateLimitEnvelope(
      buildProviderRateLimitEnvelope(undefined, response(GOOD), 1_000),
      response(unavailable("timeout")),
      2_000,
    );
    expect(
      buildProviderRateLimitEnvelope(failing, response(null), 3_000).episode,
    ).toBe(failing.episode);
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
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
        episode: PREVIOUS_EPISODE,
      }),
    ).toBeNull();
  });
});

const CODEX_GOOD: ProviderRateLimits = {
  provider: "codex",
  available: true,
  planType: null,
  limitId: null,
  limitName: null,
  primary: { usedPercent: 10, resetsAt: null, durationMinutes: 300 },
  secondary: null,
  extraWindows: [],
  credits: null,
  individualLimit: null,
  resetCredits: null,
  rateLimitReachedType: null,
};

const OPENROUTER_GOOD: ProviderRateLimits = {
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
};

describe("mapResponseToProviderRateLimitEnvelope providers.list convergence", () => {
  function invalidateSpyFor(client: QueryClient) {
    return vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
  }

  it("invalidates providers.list when a claude-code fetch resolves", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = invalidateSpyFor(queryClient);
    mapResponseToProviderRateLimitEnvelope({
      response: response(GOOD),
      queryClient,
      queryKey: ["host", "host-a", "host.getRateLimitUsage", {}],
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(typeof invalidateSpy.mock.calls[0]?.[0]?.predicate).toBe("function");
  });

  it("invalidates providers.list when a codex fetch resolves", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = invalidateSpyFor(queryClient);
    mapResponseToProviderRateLimitEnvelope({
      response: response(CODEX_GOOD),
      queryClient,
      queryKey: ["host", "host-a", "host.getRateLimitUsage", {}],
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidates providers.list when a grok fetch resolves", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = invalidateSpyFor(queryClient);
    const providersListKey = ["host", "host-a", "providers.list", {}];
    const unrelatedKey = ["host", "host-a", "host.getRateLimitUsage", {}];
    queryClient.setQueryData(providersListKey, { providers: [] });
    queryClient.setQueryData(unrelatedKey, {
      latest: null,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
      episode: PREVIOUS_EPISODE,
    });
    mapResponseToProviderRateLimitEnvelope({
      response: response(GROK_GOOD),
      queryClient,
      queryKey: unrelatedKey,
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    const predicate = invalidateSpy.mock.calls[0]?.[0]?.predicate;
    const providersListQuery = queryClient
      .getQueryCache()
      .find({ queryKey: providersListKey, exact: true });
    const unrelatedQuery = queryClient
      .getQueryCache()
      .find({ queryKey: unrelatedKey, exact: true });
    if (
      predicate === undefined ||
      providersListQuery === undefined ||
      unrelatedQuery === undefined
    ) {
      throw new Error("expected cached queries and invalidation predicate");
    }
    expect(predicate(providersListQuery)).toBe(true);
    expect(predicate(unrelatedQuery)).toBe(false);
  });

  it("does not invalidate providers.list for openrouter/kilocode (never carry managed profiles)", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = invalidateSpyFor(queryClient);
    mapResponseToProviderRateLimitEnvelope({
      response: response(OPENROUTER_GOOD),
      queryClient,
      queryKey: ["host", "host-a", "host.getRateLimitUsage", {}],
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not invalidate providers.list for a failed claude-code/codex probe (available: false carries nothing to converge on)", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = invalidateSpyFor(queryClient);
    mapResponseToProviderRateLimitEnvelope({
      response: response(unavailable("timeout")),
      queryClient,
      queryKey: ["host", "host-a", "host.getRateLimitUsage", {}],
    });
    mapResponseToProviderRateLimitEnvelope({
      response: response({
        provider: "codex",
        available: false,
        reason: "cli_not_found",
      }),
      queryClient,
      queryKey: ["host", "host-a", "host.getRateLimitUsage", {}],
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not invalidate providers.list for a null provider snapshot (aperture-only response)", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = invalidateSpyFor(queryClient);
    mapResponseToProviderRateLimitEnvelope({
      response: response(null),
      queryClient,
      queryKey: ["host", "host-a", "host.getRateLimitUsage", {}],
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates providers.list under every cached host scope, leaving unrelated queries alone", () => {
    // Unmocked queryClient (real invalidateQueries) - exercises the predicate
    // itself rather than asserting on how it was called.
    const queryClient = new QueryClient();
    const providersListKeyA = ["host", "host-a", "providers.list", {}];
    const providersListKeyB = ["host", "host-b", "providers.list", {}];
    const unrelatedKey = ["host", "host-a", "host.getRateLimitUsage", {}];
    queryClient.setQueryData(providersListKeyA, { providers: [] });
    queryClient.setQueryData(providersListKeyB, { providers: [] });
    queryClient.setQueryData(unrelatedKey, {});

    mapResponseToProviderRateLimitEnvelope({
      response: response(GOOD),
      queryClient,
      queryKey: unrelatedKey,
    });

    expect(queryClient.getQueryState(providersListKeyA)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(providersListKeyB)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  });
});
