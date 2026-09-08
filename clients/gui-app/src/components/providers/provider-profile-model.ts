import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { redactEmail } from "@/lib/providers/redact-email";

/**
 * Canonical provider-profile identity model (multi-profile UX overhaul):
 * commit-id semantics, ambient display, ordering, status text, and chip/dot
 * projection inputs, consumed by the picker, settings, rate-limit, and
 * composer surfaces. One source of truth so none of them re-derive this
 * independently.
 */

/**
 * A profile's commit id: `null` for the ambient (Default account) profile,
 * its own `profileId` otherwise. The wire array's ambient row keys itself by
 * the literal "ambient" sentinel; every run/session-level profileId
 * (composer selection, rate-limit switching, ...) uses `null` for the same
 * concept - never the wire sentinel.
 */
export function profileCommitId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * The inverse of {@link profileCommitId}: a commit id rendered as the WIRE
 * profile id, where the ambient (Default account) row keys itself by the
 * `"ambient"` sentinel rather than by `null`.
 *
 * Two callers need a non-null string for a commit id and were each spelling
 * the sentinel themselves: the focus store, whose one-shot deep-link intents
 * travel in wire vocabulary, and the settings panel's per-profile React key -
 * `null` is not a valid key on its own (React reads it as "no key"), so the
 * Default account needs a real identity or its tab stops remounting on a
 * switch. One derivation so a rename cannot land in one of them only.
 */
export function profileWireId(profileId: string | null): string {
  return profileId ?? "ambient";
}

/**
 * D26 vocabulary: the ONE user-facing name for a profile row. The ambient
 * row's wire label is the host's internal `"Terminal account"` string, which
 * is barred from user-facing copy - every surface renders "Default account"
 * instead. Managed rows render their own label verbatim.
 */
export const DEFAULT_ACCOUNT_DISPLAY_LABEL = "Default account";

export function profileDisplayLabel(profile: ProviderProfile): string {
  return profile.kind === "ambient"
    ? DEFAULT_ACCOUNT_DISPLAY_LABEL
    : profile.label;
}

/**
 * A row-level admission verdict overlaid onto a profile row by a caller that
 * has its own reason to forbid picking a particular profile (e.g. the TUI
 * continue-under-another-profile dialog's bulk fork-admission preflight).
 * Independent of a profile's own auth status - `profileRowStatusSuffix`
 * still renders "Signed out"/"Unavailable" alongside a `disabled` row.
 */
export interface ProfileRowAdmission {
  readonly disabled: boolean;
  readonly reason: string | null;
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

export function profileEnablementTooltipText(
  enabled: boolean,
  disabledReason: string | null,
): string {
  if (disabledReason !== null) return disabledReason;
  return enabled
    ? "Enabled: agents can use this profile."
    : "Disabled: agents can’t use this profile.";
}

export function profileEligibilityToggleDisabledReason(
  providerEnabled: boolean,
  profile: ProviderProfile,
  profiles: readonly ProviderProfile[],
): string | null {
  if (!providerEnabled || !profile.enabled) return null;
  return profiles.some(
    (candidate) =>
      candidate.profileId !== profile.profileId && candidate.enabled,
  )
    ? null
    : "Enable another profile before disabling this one.";
}

export function eligibleProfilesForShortcut(
  profiles: readonly ProviderProfile[],
  profileEnablementPending: (profileId: string | null) => boolean,
): ProviderProfile[] {
  return profiles.filter(
    (profile) =>
      profile.enabled && !profileEnablementPending(profileCommitId(profile)),
  );
}

/** The profile a fresh section instance (new provider, or first mount) should
 *  select - first in the host's stable order. `null` when the provider
 *  reports no profiles (callers don't render profile-scoped UI then anyway). */
export function defaultSelectedProfileId(
  profiles: readonly ProviderProfile[],
): string | null {
  const first = profiles.at(0);
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

/** The toast copy for a profile that just finished signing in - shared by the
 *  Manage dialog's "Switch account" flow and the Account tab's oauth arm, so
 *  the two never drift. Lives here rather than beside either surface because
 *  a module that exports a component exports only components. */
export function signedInMessage(profile: ProviderProfile): string {
  const email = profile.identity?.email ?? null;
  if (email !== null) return `Signed in as ${redactEmail(email)}`;
  return `Signed in to ${profileDisplayLabel(profile)}`;
}
