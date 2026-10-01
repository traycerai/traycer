import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import {
  isRateLimitProfileFetchEligible,
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
} from "@/lib/rate-limit-providers";
import type { ProviderRateLimitFetchTarget } from "@/lib/rate-limits/provider-rate-limit-fetch";

/**
 * One target the app-shell poll may read, with the host's persisted reading
 * time for it (`usageUpdatedAt` from `providers.list`; `null` when the host has
 * none, and always for the ambient login of a provider that reports no
 * profiles).
 */
export interface RateLimitPollCandidate extends ProviderRateLimitFetchTarget {
  readonly usageUpdatedAt: number | null;
}

function profileTargetId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * Every `ephemeralProcess` target the app-shell poll watches: each
 * fetch-eligible profile of each such provider, or the ambient login for a
 * provider that reports no profiles. Signed-out and disabled profiles never
 * enter it.
 */
export function rateLimitPollCandidates(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
): ReadonlyArray<RateLimitPollCandidate> {
  return providers.flatMap((provider) => {
    if (provider.lane !== "ephemeralProcess") return [];
    if (provider.profiles.length === 0) {
      return provider.fetchEligibility.ambient
        ? [
            {
              providerId: provider.providerId,
              accountContext: DEFAULT_ACCOUNT_CONTEXT,
              profileId: null,
              usageUpdatedAt: null,
            },
          ]
        : [];
    }
    return provider.profiles.flatMap((profile) =>
      isRateLimitProfileFetchEligible(provider.fetchEligibility, profile)
        ? [
            {
              providerId: provider.providerId,
              accountContext: DEFAULT_ACCOUNT_CONTEXT,
              profileId: profileTargetId(profile),
              usageUpdatedAt: profile.usageUpdatedAt,
            },
          ]
        : [],
    );
  });
}

/**
 * The candidates one poll tick reads: every one whose persisted reading is
 * missing or at least `PROVIDER_RATE_LIMITS_STALE_TIME_MS` old. A reading the
 * host refreshed recently - a probe, or the passive capture a turn's own usage
 * report feeds - is skipped, since the host would otherwise re-probe anything
 * past its much shorter read floor.
 *
 * There is no per-tick budget. Each read goes to the host as `force: false`,
 * and the host bounds the probes it does run (`provider-probe-gates.ts`
 * there); a client-side budget could only pick which profiles go stale.
 */
export function rateLimitPollTargets(
  candidates: ReadonlyArray<RateLimitPollCandidate>,
  now: number,
): ReadonlyArray<ProviderRateLimitFetchTarget> {
  return candidates
    .filter(
      (candidate) =>
        candidate.usageUpdatedAt === null ||
        now - candidate.usageUpdatedAt >= PROVIDER_RATE_LIMITS_STALE_TIME_MS,
    )
    .map(({ providerId, accountContext, profileId }) => ({
      providerId,
      accountContext,
      profileId,
    }));
}

/**
 * Stable dependency key for the poll's candidate set: changes when a target
 * joins or leaves, never when a reading lands, so one completed read does not
 * re-trigger the whole set.
 */
export function rateLimitPollMembershipKey(
  candidates: ReadonlyArray<RateLimitPollCandidate>,
): string {
  return JSON.stringify(
    candidates
      .map((candidate) => [candidate.providerId, candidate.profileId])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}
