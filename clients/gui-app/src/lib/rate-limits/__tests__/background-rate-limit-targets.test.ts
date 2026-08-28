import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import {
  BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
  backgroundRateLimitMembershipKey,
  selectBackgroundRateLimitTargets,
} from "@/lib/rate-limits/background-rate-limit-targets";

const NOW = 1_700_000_000_000;

const NO_SELECTION: RateLimitProfileSelection = {
  activeChatSettings: null,
  lastProfileByHarness: {},
};

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

function selectionFor(
  harness: "codex" | "claude",
  profileId: string,
): RateLimitProfileSelection {
  return {
    activeChatSettings: null,
    lastProfileByHarness: { [harness]: profileId },
  };
}

describe("selectBackgroundRateLimitTargets", () => {
  it("excludes signed-out (fetch-ineligible) profiles even when stale", () => {
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
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toEqual([]);
  });

  it("excludes disabled authenticated profiles from automatic targets", () => {
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

    expect(
      selectBackgroundRateLimitTargets(
        providers,
        NO_SELECTION,
        NOW,
        BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
      ),
    ).toEqual([]);
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
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toEqual([]);
  });

  it("excludes a target whose usage is still within the freshness window", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "work-profile",
            kind: "managed",
            usageUpdatedAt: NOW - 1_000,
          }),
        ],
      }),
    ];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toEqual([]);
  });

  it("includes a target exactly at the freshness boundary (stale is inclusive)", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "work-profile",
            kind: "managed",
            usageUpdatedAt: NOW - PROVIDER_RATE_LIMITS_STALE_TIME_MS,
          }),
        ],
      }),
    ];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toEqual([
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "work-profile",
      },
    ]);
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
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toEqual([]);
  });

  it("emits a single always-stale ambient candidate for a profile-less provider when ambient-eligible", () => {
    const providers = [provider({ providerId: "codex", profiles: [] })];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toEqual([
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: null,
      },
    ]);
  });

  it("emits no candidate for a profile-less provider when ambient-ineligible", () => {
    const providers = [
      provider({ providerId: "codex", profiles: [], ambientEligible: false }),
    ];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toEqual([]);
  });

  it("prioritizes the selected stale target ahead of an older but unselected one", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "oldest",
            kind: "managed",
            usageUpdatedAt: NOW - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 10_000,
          }),
          profile({
            profileId: "selected-but-newer",
            kind: "managed",
            usageUpdatedAt: NOW - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1_000,
          }),
        ],
      }),
    ];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      selectionFor("codex", "selected-but-newer"),
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets.map((t) => t.profileId)).toEqual([
      "selected-but-newer",
      "oldest",
    ]);
  });

  it("orders non-selected stale targets oldest reading first", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "newer-stale",
            kind: "managed",
            usageUpdatedAt: NOW - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1_000,
          }),
          profile({
            profileId: "never-read",
            kind: "managed",
            usageUpdatedAt: null,
          }),
          profile({
            profileId: "oldest-stale",
            kind: "managed",
            usageUpdatedAt: NOW - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 100_000,
          }),
        ],
      }),
    ];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    // A never-read profile (`usageUpdatedAt: null`) sorts as the oldest
    // possible reading (`Number.NEGATIVE_INFINITY`), ahead of any timestamped
    // stale reading.
    expect(targets.map((t) => t.profileId)).toEqual([
      "never-read",
      "oldest-stale",
      "newer-stale",
    ]);
  });

  it("enforces the budget across providers, keeping only the highest-priority targets", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "p1",
            kind: "managed",
            usageUpdatedAt: NOW - 4_000_000,
          }),
          profile({
            profileId: "p2",
            kind: "managed",
            usageUpdatedAt: NOW - 3_000_000,
          }),
        ],
      }),
      provider({
        providerId: "claude-code",
        profiles: [
          profile({
            profileId: "p3",
            kind: "managed",
            usageUpdatedAt: NOW - 2_000_000,
          }),
          profile({
            profileId: "p4",
            kind: "managed",
            usageUpdatedAt: NOW - 1_000_000,
          }),
        ],
      }),
    ];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    expect(targets).toHaveLength(BACKGROUND_RATE_LIMIT_TARGET_BUDGET);
    expect(targets.map((t) => t.profileId)).toEqual(["p1", "p2", "p3"]);
  });

  it("respects a custom, smaller budget than the default", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
          profile({ profileId: "p2", kind: "managed", usageUpdatedAt: null }),
        ],
      }),
    ];
    const targets = selectBackgroundRateLimitTargets(
      providers,
      NO_SELECTION,
      NOW,
      1,
    );
    expect(targets).toHaveLength(1);
  });
});

describe("backgroundRateLimitMembershipKey", () => {
  it("stays identical when only a usage timestamp changes", () => {
    const base = (usageUpdatedAt: number | null) => [
      provider({
        providerId: "codex",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt }),
        ],
      }),
    ];
    expect(
      backgroundRateLimitMembershipKey(base(NOW - 10_000), NO_SELECTION),
    ).toBe(backgroundRateLimitMembershipKey(base(null), NO_SELECTION));
  });

  it("changes when a profile's fetch eligibility changes", () => {
    const eligible = [
      provider({
        providerId: "codex",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
        ],
      }),
    ];
    const ineligible = [
      provider({
        providerId: "codex",
        profiles: [
          profile({
            profileId: "p1",
            kind: "managed",
            usageUpdatedAt: null,
            authenticated: false,
          }),
        ],
      }),
    ];
    expect(backgroundRateLimitMembershipKey(eligible, NO_SELECTION)).not.toBe(
      backgroundRateLimitMembershipKey(ineligible, NO_SELECTION),
    );
  });

  it("changes when the selected profile changes", () => {
    const providers = [
      provider({
        providerId: "codex",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
          profile({ profileId: "p2", kind: "managed", usageUpdatedAt: null }),
        ],
      }),
    ];
    expect(
      backgroundRateLimitMembershipKey(providers, selectionFor("codex", "p1")),
    ).not.toBe(
      backgroundRateLimitMembershipKey(providers, selectionFor("codex", "p2")),
    );
  });

  it("changes when the candidate provider set changes", () => {
    const withCodex = [provider({ providerId: "codex" })];
    const withBoth = [
      provider({ providerId: "codex" }),
      provider({ providerId: "claude-code" }),
    ];
    expect(backgroundRateLimitMembershipKey(withCodex, NO_SELECTION)).not.toBe(
      backgroundRateLimitMembershipKey(withBoth, NO_SELECTION),
    );
  });
});
