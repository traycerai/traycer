import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { isRateLimitProfileFetchEligible } from "@/lib/rate-limit-providers";

/**
 * The `profileId` a provider profile's `host.getRateLimitUsage` pull is keyed
 * by: `null` for the ambient (terminal) login, the profile's own id otherwise.
 * Every surface that enqueues or observes a per-profile reading must derive
 * the id through this one function so the popover, the Settings card, and the
 * background timer can never write or read a differently-keyed cache slot.
 */
export function rateLimitProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * Every profile of `provider` that may currently perform its own usage pull -
 * the same set the popover's "Refresh all" fans out over, and the set the
 * background timer walks so managed profiles stay as fresh as the ambient
 * login. A provider that reports no profile metadata (older hosts) falls back
 * to its provider-wide ambient reading when that is fetch-eligible.
 */
export function refreshTargetsForProvider(
  provider: ConfiguredRateLimitProvider,
): ReadonlyArray<string | null> {
  if (provider.profiles.length === 0) {
    return provider.fetchEligibility.ambient ? [null] : [];
  }
  return provider.profiles
    .filter((profile) =>
      isRateLimitProfileFetchEligible(provider.fetchEligibility, profile),
    )
    .map(rateLimitProfileId);
}
