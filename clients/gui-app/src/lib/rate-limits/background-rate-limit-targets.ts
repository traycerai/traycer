import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import {
  resolveRateLimitProfileId,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  isRateLimitProfileFetchEligible,
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
} from "@/lib/rate-limit-providers";
import type { RateLimitQueueBatchTarget } from "@/lib/rate-limits/ephemeral-fetch-queue";

export const BACKGROUND_RATE_LIMIT_TARGET_BUDGET = 3;

interface BackgroundCandidate extends RateLimitQueueBatchTarget {
  readonly usageUpdatedAt: number | null;
  readonly selected: boolean;
}

function profileTargetId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

function candidates(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  selection: RateLimitProfileSelection,
): ReadonlyArray<BackgroundCandidate> {
  return providers.flatMap((provider) => {
    if (provider.lane !== "ephemeralProcess") return [];
    const selectedProfileId = resolveRateLimitProfileId(
      selection,
      provider.providerId,
      provider.profiles,
    );
    if (provider.profiles.length === 0) {
      return provider.fetchEligibility.ambient
        ? [
            {
              providerId: provider.providerId,
              accountContext: DEFAULT_ACCOUNT_CONTEXT,
              profileId: null,
              usageUpdatedAt: null,
              selected: true,
            },
          ]
        : [];
    }
    return provider.profiles.flatMap((profile) => {
      if (
        !isRateLimitProfileFetchEligible(provider.fetchEligibility, profile)
      ) {
        return [];
      }
      const profileId = profileTargetId(profile);
      return [
        {
          providerId: provider.providerId,
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          profileId,
          usageUpdatedAt: profile.usageUpdatedAt,
          selected: profileId === selectedProfileId,
        },
      ];
    });
  });
}

/**
 * Stable dependency key for eligibility/selection changes. Persisted freshness
 * is deliberately excluded: one completed pull must not refill the budget
 * immediately; the next interval chooses the next-oldest stale targets.
 */
export function backgroundRateLimitMembershipKey(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  selection: RateLimitProfileSelection,
): string {
  return JSON.stringify(
    candidates(providers, selection)
      .map((target) => [target.providerId, target.profileId, target.selected])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}

/**
 * Selected stale targets first, then oldest persisted reading, globally capped
 * per window. Signed-out profiles never enter the candidate set.
 */
export function selectBackgroundRateLimitTargets(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  selection: RateLimitProfileSelection,
  now: number,
  budget: number,
): ReadonlyArray<RateLimitQueueBatchTarget> {
  return candidates(providers, selection)
    .filter(
      (target) =>
        target.usageUpdatedAt === null ||
        now - target.usageUpdatedAt >= PROVIDER_RATE_LIMITS_STALE_TIME_MS,
    )
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      return (
        (left.usageUpdatedAt ?? Number.NEGATIVE_INFINITY) -
        (right.usageUpdatedAt ?? Number.NEGATIVE_INFINITY)
      );
    })
    .slice(0, budget)
    .map(({ providerId, accountContext, profileId }) => ({
      providerId,
      accountContext,
      profileId,
    }));
}
