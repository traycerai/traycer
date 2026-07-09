import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";
import { providerIdForHarness } from "./use-provider-reauth-gate";

// The wire array's ambient row keys itself by the literal "ambient" sentinel;
// every run/session-level profileId (composer selection included) uses `null`
// for the same concept. Mirrors `rate-limit-popover.tsx`'s identical mapping.
function normalizedProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

function isLimited(profile: ProviderProfile): boolean {
  return (
    profile.rateLimitStatus === "near_limit" ||
    profile.rateLimitStatus === "hard_limit"
  );
}

export interface ProfileRateLimitAlternative {
  readonly profileId: string | null;
  readonly label: string;
}

export interface ProfileRateLimitSwitchPrompt {
  /** True only when the composer's OWN committed profile is near/at its limit
   *  and at least one other authenticated, non-limited profile exists to
   *  switch to - the progressive-disclosure gate (a single-profile provider,
   *  or a provider with no viable alternative, never shows this banner). */
  readonly limited: boolean;
  readonly hardLimited: boolean;
  readonly alternatives: ReadonlyArray<ProfileRateLimitAlternative>;
}

const NO_ALTERNATIVES: ReadonlyArray<ProfileRateLimitAlternative> = [];
const NO_PROFILES: ReadonlyArray<ProviderProfile> = [];

/**
 * Composer-facing rate-limit signal for the mid-chat "Continue on <profile>"
 * switch prompt (multi-profile decision log's "Rate-limit moment"). Derives
 * everything from the SAME `providers.list` read the reauth gate already
 * queries (dedupes via the query cache - no new host RPC), reading the
 * per-profile `rateLimitStatus` the host derives from its passive-capture
 * gauge cache. Never switches automatically - this is a read-only signal the
 * banner turns into a user-confirmed action.
 */
export function useProfileRateLimitSwitchPrompt(
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
): ProfileRateLimitSwitchPrompt {
  const providerId = providerIdForHarness(harnessId);
  const enabled = active && providerId !== null;
  const query = useTabProvidersList({ enabled, subscribed: enabled });

  const profiles =
    query.data?.providers.find((p) => p.providerId === providerId)?.profiles ??
    NO_PROFILES;
  if (profiles.length < 2) {
    return {
      limited: false,
      hardLimited: false,
      alternatives: NO_ALTERNATIVES,
    };
  }

  const current = profiles.find(
    (profile) => normalizedProfileId(profile) === profileId,
  );
  if (current === undefined || !isLimited(current)) {
    return {
      limited: false,
      hardLimited: false,
      alternatives: NO_ALTERNATIVES,
    };
  }

  const alternatives = profiles
    .filter(
      (profile) =>
        normalizedProfileId(profile) !== profileId &&
        profile.auth.status === "authenticated" &&
        !isLimited(profile),
    )
    .map((profile) => ({
      profileId: normalizedProfileId(profile),
      label: profile.kind === "ambient" ? "Terminal account" : profile.label,
    }));

  return {
    limited: alternatives.length > 0,
    hardLimited: current.rateLimitStatus === "hard_limit",
    alternatives,
  };
}
