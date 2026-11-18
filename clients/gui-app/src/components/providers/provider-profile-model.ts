import type {
  ProviderProfile,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { providerSupportsManagedProfiles } from "@traycer/protocol/host/provider-profile-inheritance";
import {
  PERSON_NOTICE_TEXT,
  terminalAccountLineText,
} from "@/components/providers/profile-sync-copy";

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

/** Every one-sign-in screen of Providers and the Add and Sign in again dialogs is drawn only when true. */
export function listOffersSignIns(
  list: { readonly offersSignIns?: boolean } | undefined,
): boolean {
  return list?.offersSignIns === true;
}

export function profileUsesRecord(profile: ProviderProfile): boolean {
  return profile.aliases !== undefined;
}

export type RemovedProviderProfile = NonNullable<
  ProvidersListResponse["removedProfiles"]
>[number];

const NO_REMOVED_PROFILES: readonly RemovedProviderProfile[] = [];

/** An older computer sends none. */
export function removedProfilesForProvider(
  list:
    | { readonly removedProfiles?: readonly RemovedProviderProfile[] }
    | undefined,
  providerId: string | null,
): readonly RemovedProviderProfile[] {
  const removed = list?.removedProfiles;
  if (removed === undefined || providerId === null) return NO_REMOVED_PROFILES;
  const forProvider = removed.filter(
    (entry) => entry.providerId === providerId,
  );
  return forProvider.length === 0 ? NO_REMOVED_PROFILES : forProvider;
}

/** An id more than one row lists is `unknown`, never guessed. */
export type ProfilePinResolution =
  | { readonly kind: "row"; readonly profile: ProviderProfile }
  | { readonly kind: "removed" }
  | { readonly kind: "unknown" };

const UNKNOWN_PIN: ProfilePinResolution = { kind: "unknown" };
const REMOVED_PIN: ProfilePinResolution = { kind: "removed" };

export function resolveProfilePin(
  profiles: readonly ProviderProfile[],
  removedProfiles: readonly RemovedProviderProfile[],
  pinnedId: string | null,
): ProfilePinResolution {
  if (pinnedId === null) return resolveTerminalPin(profiles);
  const listing = profiles.filter(
    (profile) =>
      profileCommitId(profile) === pinnedId ||
      profile.aliases?.includes(pinnedId) === true,
  );
  if (listing.length === 1) return { kind: "row", profile: listing[0] };
  if (listing.length > 1) return UNKNOWN_PIN;
  const removed = removedProfiles.some(
    (entry) => entry.profileId === pinnedId || entry.aliases.includes(pinnedId),
  );
  return removed ? REMOVED_PIN : UNKNOWN_PIN;
}

function resolveTerminalPin(
  profiles: readonly ProviderProfile[],
): ProfilePinResolution {
  const ambient = profiles.find((profile) => profile.kind === "ambient");
  if (ambient !== undefined) return { kind: "row", profile: ambient };
  const terminalRows = profiles.filter(
    (profile) => profile.terminalOnThisComputer === true,
  );
  return terminalRows.length === 1
    ? { kind: "row", profile: terminalRows[0] }
    : UNKNOWN_PIN;
}

/**
 * Always for a removed pin, so it reads "Was removed" rather than becoming the
 * Terminal pin when a model is chosen. `providerId` is the CLI id (`claude-code`).
 */
export function profileDropdownShown(
  providerId: string | null,
  profiles: readonly ProviderProfile[],
  removedProfiles: readonly RemovedProviderProfile[],
  pinnedId: string | null,
): boolean {
  if (resolveProfilePin(profiles, removedProfiles, pinnedId).kind === "removed")
    return true;
  return profiles.length >= profileDropdownMinimumRows(providerId);
}

export function profileDropdownMinimumRows(providerId: string | null): number {
  return providerId !== null && providerSupportsManagedProfiles(providerId)
    ? 1
    : 2;
}

export function resolvedProfileRow(
  profiles: readonly ProviderProfile[],
  removedProfiles: readonly RemovedProviderProfile[],
  pinnedId: string | null,
): ProviderProfile | null {
  const resolution = resolveProfilePin(profiles, removedProfiles, pinnedId);
  return resolution.kind === "row" ? resolution.profile : null;
}

export function profilePersonNoticeText(
  profile: ProviderProfile,
): string | null {
  const notice = profile.personNotice;
  return notice === null || notice === undefined
    ? null
    : PERSON_NOTICE_TEXT[notice];
}

export function profileTerminalAccountLine(
  profile: ProviderProfile,
  computerName: string | null,
): string | null {
  if (profile.kind === "ambient" || profile.terminalOnThisComputer !== true) {
    return null;
  }
  return terminalAccountLineText(computerName);
}

const NO_OTHER_NAMES: readonly string[] = [];

export function profileOtherNames(profile: ProviderProfile): readonly string[] {
  return profile.otherNames ?? NO_OTHER_NAMES;
}

export function profileDisplayLabel(profile: ProviderProfile): string {
  return profile.label;
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

const REVOCATION_NOTICES = {
  "host-left-environment": "Disconnecting: this host left the environment.",
  "profile-account-changed": "Disconnecting: the profile account changed.",
  "signed-out-by-person": "Disconnecting: signed out.",
};

const CREDENTIAL_STANDING_LABELS = {
  stale: "Stale",
  "signed-out": "Signed out",
  rejected: "Credential rejected",
  "refused-by-provider": "Refused by provider",
};

/** Host-reported inventory health, independent of whether usage is observable. */
export function profileInventoryNotice(
  profile: ProviderProfile,
): string | null {
  if (profile.readability?.kind === "unreadable") {
    const reason = profile.readability.reason;
    return reason === null
      ? "Unreadable profile"
      : `Unreadable profile: ${reason}`;
  }
  if (profile.presence?.kind === "revoking") {
    return profile.presence.cause === null
      ? "Disconnecting."
      : REVOCATION_NOTICES[profile.presence.cause];
  }
  const standing = profile.credentialHome?.standing;
  if (standing === undefined) {
    if (
      profile.auth.status === "authenticated" ||
      profile.auth.status === "configured"
    )
      return null;
    return profileAuthStatusText(profile);
  }
  const cause = standing.cause === null ? "" : `: ${standing.cause}`;
  if (standing.observation.status === "unknown" || standing.material === null) {
    return `Status unknown${cause}`;
  }
  return standing.material === "usable"
    ? null
    : `${CREDENTIAL_STANDING_LABELS[standing.material]}${cause}`;
}

/** The existing inventory words split between the status badge and its detail. */
export function profileInventorySummary(profile: ProviderProfile): {
  readonly badge: string;
  readonly detail: string | null;
} {
  // The computer's word for the person replaces the status words, detail
  // included: it is the one thing this account has to say.
  const personNotice = profilePersonNoticeText(profile);
  if (personNotice !== null) return { badge: personNotice, detail: null };
  const notice = profileInventoryNotice(profile);
  const standing = profile.credentialHome?.standing;
  let badge = profileAuthStatusText(profile);
  if (standing !== undefined) {
    if (
      standing.observation.status === "unknown" ||
      standing.material === null
    ) {
      badge = "Unknown";
    } else if (standing.material !== "usable") {
      badge = CREDENTIAL_STANDING_LABELS[standing.material];
    }
  }
  if (
    profile.readability?.kind === "unreadable" ||
    profile.presence?.kind === "revoking"
  ) {
    return { badge, detail: notice };
  }
  const separator = notice?.indexOf(": ") ?? -1;
  return {
    badge,
    detail:
      notice !== null && separator !== -1 ? notice.slice(separator + 2) : null,
  };
}

/** Semantic identity of a rendered inventory row, shared across both surfaces. */
export function profileInventoryAttributes(profile: ProviderProfile) {
  return {
    "data-provider-profile-id": profile.profileId,
    "data-provider-profile-kind": profile.kind,
    "data-provider-profile-label": profile.label,
    "data-provider-profile-auth-status": profile.auth.status,
    "data-provider-profile-standing": JSON.stringify(
      profile.credentialHome?.standing ?? null,
    ),
    "data-provider-profile-presence": JSON.stringify(profile.presence ?? null),
    "data-provider-profile-readability": JSON.stringify(
      profile.readability ?? null,
    ),
  };
}

// Dropdown row status suffix: null for a healthy profile (nothing to announce
// beyond its name), else the same wording the Settings profile row uses
// (`profileAuthStatusText`, or the computer's word for the person) so every
// surface stays consistent.
export function profileRowStatusSuffix(
  profile: ProviderProfile,
): string | null {
  const personNotice = profilePersonNoticeText(profile);
  if (personNotice !== null) return personNotice;
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

/**
 * Why this profile's enable switch is held, or null when it may move.
 *
 * A provider that is off holds every profile control (`providerHostBlockLabel`
 * says so), with one exception it cannot do without: the host refuses to turn
 * a provider on while none of its profiles is on, so with every profile off,
 * turning one on is the step the provider's own switch is waiting for. That
 * single move stays open; nothing else does until the provider is on.
 */
export function profileEligibilityToggleDisabledReason(
  providerEnabled: boolean,
  providerLabel: string,
  profile: ProviderProfile,
  profiles: readonly ProviderProfile[],
): string | null {
  if (!providerEnabled) {
    const anyEnabled = profiles.some((candidate) => candidate.enabled);
    return anyEnabled
      ? `${providerLabel} is turned off. Turn it on to change its profiles.`
      : null;
  }
  if (profileUsesRecord(profile)) return null;
  if (!profile.enabled) return null;
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
