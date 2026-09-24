import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import {
  rateLimitPollCandidates,
  rateLimitPollMembershipKey,
  rateLimitPollTargets,
  type RateLimitPollCandidate,
} from "@/lib/rate-limits/rate-limit-poll-targets";

const NOW = 1_700_000_000_000;

function profile(input: {
  readonly profileId: string;
  readonly kind: ProviderProfile["kind"];
  readonly usageUpdatedAt: number | null;
  readonly authenticated?: boolean;
  readonly enabled?: boolean;
}): ProviderProfile {
  return {
    profileId: input.profileId,
    enabled: input.enabled ?? true,
    kind: input.kind,
    authType: "oauth",
    label: input.profileId,
    auth: {
      status:
        (input.authenticated ?? true) ? "authenticated" : "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: `${input.profileId}@example.com`,
      tier: "Pro",
      accountUuid: `${input.profileId}-uuid`,
    },
    usageUpdatedAt: input.usageUpdatedAt,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function provider(input: {
  readonly providerId: ConfiguredRateLimitProvider["providerId"];
  readonly lane?: ConfiguredRateLimitProvider["lane"];
  readonly profiles?: ReadonlyArray<ProviderProfile>;
  readonly ambientEligible?: boolean;
  readonly managedEligible?: boolean;
}): ConfiguredRateLimitProvider {
  return {
    providerId: input.providerId,
    lane: input.lane ?? "ephemeralProcess",
    profiles: input.profiles ?? [],
    fetchEligibility: {
      ambient: input.ambientEligible ?? true,
      managedProfiles: input.managedEligible ?? true,
    },
  };
}

describe("rateLimitPollCandidates", () => {
  it("excludes signed-out (fetch-ineligible) profiles", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "signed-out",
            kind: "managed",
            usageUpdatedAt: null,
            authenticated: false,
          }),
        ],
      }),
    ];
    expect(rateLimitPollCandidates(providers)).toEqual([]);
  });

  it("excludes disabled authenticated profiles", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "disabled-authenticated",
            kind: "managed",
            usageUpdatedAt: null,
            enabled: false,
          }),
        ],
      }),
    ];
    expect(rateLimitPollCandidates(providers)).toEqual([]);
  });

  it("excludes a signed-out ambient profile via provider-level ambient ineligibility", () => {
    const providers = [
      provider({
        providerId: "codex",
        ambientEligible: false,
        profiles: [
          profile({
            profileId: "ambient",
            kind: "ambient",
            usageUpdatedAt: null,
          }),
        ],
      }),
    ];
    expect(rateLimitPollCandidates(providers)).toEqual([]);
  });

  it("excludes non-ephemeralProcess (httpFetch) providers", () => {
    const providers = [
      provider({
        providerId: "openrouter",
        lane: "httpFetch",
        profiles: [
          profile({
            profileId: "ambient",
            kind: "ambient",
            usageUpdatedAt: null,
          }),
        ],
      }),
    ];
    expect(rateLimitPollCandidates(providers)).toEqual([]);
  });

  it("emits a single ambient candidate with no persisted reading for a profile-less provider when ambient-eligible", () => {
    const providers = [provider({ providerId: "codex", profiles: [] })];
    expect(rateLimitPollCandidates(providers)).toEqual([
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: null,
        usageUpdatedAt: null,
      },
    ]);
  });

  it("emits no candidate for a profile-less provider when ambient-ineligible", () => {
    const providers = [
      provider({ providerId: "codex", profiles: [], ambientEligible: false }),
    ];
    expect(rateLimitPollCandidates(providers)).toEqual([]);
  });

  it("carries each eligible profile's own persisted usageUpdatedAt onto its candidate", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "work",
            kind: "managed",
            usageUpdatedAt: NOW - 1_000,
          }),
        ],
      }),
    ];
    expect(rateLimitPollCandidates(providers)).toEqual([
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "work",
        usageUpdatedAt: NOW - 1_000,
      },
    ]);
  });

  it("includes every eligible profile of a provider, not just the first", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
          profile({ profileId: "p2", kind: "managed", usageUpdatedAt: null }),
        ],
      }),
    ];
    expect(rateLimitPollCandidates(providers).map((c) => c.profileId)).toEqual([
      "p1",
      "p2",
    ]);
  });
});

function candidate(input: {
  readonly providerId: RateLimitPollCandidate["providerId"];
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): RateLimitPollCandidate {
  return {
    providerId: input.providerId,
    accountContext: DEFAULT_ACCOUNT_CONTEXT,
    profileId: input.profileId,
    usageUpdatedAt: input.usageUpdatedAt,
  };
}

describe("rateLimitPollTargets", () => {
  it("excludes a candidate whose usage is still within the freshness window", () => {
    const candidates = [
      candidate({
        providerId: "codex",
        profileId: "work",
        usageUpdatedAt: NOW - 1_000,
      }),
    ];
    expect(rateLimitPollTargets(candidates, NOW)).toEqual([]);
  });

  it("includes a candidate exactly at the freshness boundary (stale is inclusive)", () => {
    const candidates = [
      candidate({
        providerId: "codex",
        profileId: "work",
        usageUpdatedAt: NOW - PROVIDER_RATE_LIMITS_STALE_TIME_MS,
      }),
    ];
    expect(rateLimitPollTargets(candidates, NOW)).toEqual([
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "work",
      },
    ]);
  });

  it("includes a never-read candidate (usageUpdatedAt: null) regardless of now", () => {
    const candidates = [
      candidate({
        providerId: "codex",
        profileId: "work",
        usageUpdatedAt: null,
      }),
    ];
    expect(rateLimitPollTargets(candidates, NOW)).toEqual([
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "work",
      },
    ]);
  });

  it("drops usageUpdatedAt from the target shape it returns", () => {
    const candidates = [
      candidate({
        providerId: "codex",
        profileId: "work",
        usageUpdatedAt: null,
      }),
    ];
    expect(rateLimitPollTargets(candidates, NOW)[0]).not.toHaveProperty(
      "usageUpdatedAt",
    );
  });

  it("applies no budget - every stale candidate becomes a target, even six of them", () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      candidate({
        providerId: "codex",
        profileId: `p${i}`,
        usageUpdatedAt: null,
      }),
    );
    expect(rateLimitPollTargets(candidates, NOW)).toHaveLength(6);
  });

  it("re-evaluates staleness against the `now` it is given, not a value baked in earlier", () => {
    const candidates = [
      candidate({
        providerId: "codex",
        profileId: "work",
        usageUpdatedAt: NOW - 1_000,
      }),
    ];
    // Fresh relative to an early `now`...
    expect(rateLimitPollTargets(candidates, NOW)).toEqual([]);
    // ...but stale once enough time has passed, using the SAME candidate list.
    expect(
      rateLimitPollTargets(
        candidates,
        NOW + PROVIDER_RATE_LIMITS_STALE_TIME_MS,
      ),
    ).toEqual([
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "work",
      },
    ]);
  });
});

describe("rateLimitPollMembershipKey", () => {
  it("stays identical when only a candidate's usageUpdatedAt changes", () => {
    const base = (usageUpdatedAt: number | null) => [
      candidate({ providerId: "codex", profileId: "p1", usageUpdatedAt }),
    ];
    expect(rateLimitPollMembershipKey(base(NOW - 10_000))).toBe(
      rateLimitPollMembershipKey(base(null)),
    );
  });

  it("is independent of input order", () => {
    const a = [
      candidate({ providerId: "codex", profileId: "p1", usageUpdatedAt: null }),
      candidate({
        providerId: "claude-code",
        profileId: null,
        usageUpdatedAt: null,
      }),
    ];
    const b = [a[1], a[0]];
    expect(rateLimitPollMembershipKey(a)).toBe(rateLimitPollMembershipKey(b));
  });

  it("changes when the candidate set gains or loses a member", () => {
    const withCodex = [
      candidate({ providerId: "codex", profileId: null, usageUpdatedAt: null }),
    ];
    const withBoth = [
      ...withCodex,
      candidate({
        providerId: "claude-code",
        profileId: null,
        usageUpdatedAt: null,
      }),
    ];
    expect(rateLimitPollMembershipKey(withCodex)).not.toBe(
      rateLimitPollMembershipKey(withBoth),
    );
  });

  it("changes when a profile joins or leaves a provider's candidate set", () => {
    const one = [
      candidate({ providerId: "codex", profileId: "p1", usageUpdatedAt: null }),
    ];
    const two = [
      ...one,
      candidate({ providerId: "codex", profileId: "p2", usageUpdatedAt: null }),
    ];
    expect(rateLimitPollMembershipKey(one)).not.toBe(
      rateLimitPollMembershipKey(two),
    );
  });
});
