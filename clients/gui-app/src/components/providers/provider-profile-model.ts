import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

/**
 * Canonical provider-profile identity model (multi-profile UX overhaul):
 * commit-id semantics, ambient display, ordering, status text, and chip/dot
 * projection inputs, consumed by the picker, settings, rate-limit, and
 * composer surfaces. One source of truth so none of them re-derive this
 * independently.
 */

/**
 * A profile's commit id: `null` for the ambient (Terminal account) profile,
 * its own `profileId` otherwise. The wire array's ambient row keys itself by
 * the literal "ambient" sentinel; every run/session-level profileId
 * (composer selection, rate-limit switching, ...) uses `null` for the same
 * concept - never the wire sentinel.
 */
export function profileCommitId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

export function profileDisplayLabel(profile: ProviderProfile): string {
  return profile.label;
}

export function profileAuthStatusText(profile: ProviderProfile): string {
  if (profile.auth.status === "authenticated") return "Signed in";
  if (profile.auth.status === "configured") return "Configured";
  if (profile.auth.status === "unauthenticated") return "Signed out";
  if (profile.auth.status === "unavailable") return "Unavailable";
  return "Unknown";
}

// Dropdown row status suffix: null for a healthy profile (nothing to announce
// beyond its name), else the same wording the Settings profile row uses
// (`profileAuthStatusText`) so every surface stays consistent.
export function profileRowStatusSuffix(
  profile: ProviderProfile,
): string | null {
  if (profile.auth.status === "unauthenticated") return "Signed out";
  if (profile.auth.status === "unavailable") return "Unavailable";
  return null;
}

// Ambient always sorts first, matching the rail dot / picker dropdown / old
// row-list convention, so "default to ambient/first" resolves to the same
// profile everywhere.
export function orderProfiles(
  profiles: readonly ProviderProfile[],
): ReadonlyArray<ProviderProfile> {
  return [...profiles].sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === "ambient" ? -1 : 1;
  });
}

/** The profile a fresh section instance (new provider, or first mount) should
 *  select - ambient/first per `orderProfiles`. `null` when the provider
 *  reports no profiles (callers don't render profile-scoped UI then anyway). */
export function defaultSelectedProfileId(
  profiles: readonly ProviderProfile[],
): string | null {
  const first = orderProfiles(profiles).at(0);
  return first === undefined ? null : profileCommitId(first);
}

export function duplicateProfileLabel(
  profile: ProviderProfile,
  profiles: readonly ProviderProfile[],
): string | null {
  if (profile.duplicateOfProfileId === null) return null;
  const duplicate = profiles.find(
    (candidate) => candidate.profileId === profile.duplicateOfProfileId,
  );
  if (duplicate === undefined) return "another profile";
  return profileDisplayLabel(duplicate);
}

/** Chip/dot projection input shared by the rail's corner badge, the trigger's
 *  corner badge, and any other surface that renders an `AccentDot` for a
 *  resolved profile. */
export interface ProfileAccentDotInput {
  readonly profileId: string;
  readonly accentColor: string | null;
  readonly label: string;
}

export function profileAccentDotInput(
  profile: ProviderProfile,
): ProfileAccentDotInput {
  return {
    profileId: profile.profileId,
    accentColor: profile.accentColor,
    label: profileDisplayLabel(profile),
  };
}
