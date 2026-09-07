import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
  type ProviderManagedInstallErrorReason,
  type ProviderManagedVersions,
  type ProviderManagedVersionsUnavailable,
  type ProviderPackRefreshOutcome,
  type ProviderPackVersion,
  type ProviderPackVersionCertification,
  type ProviderPackVersionInstallState,
  type ProviderPackVersionUnusableReason,
  type ProvidersInstallPackVersionResult,
  type ProvidersRefreshPackDiscoveryResult,
  type ProvidersRemovePackVersionResult,
  type ProvidersUsePackVersionResult,
} from "@traycer/protocol/host/provider-schemas";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";

export function providerDisplayName(providerId: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[providerId];
}

/** "Shared by OpenCode, Traycer, OpenRouter" - the other providers on this pack, excluding the row the user
 * opened from (already on `sharedWithProviders`). */
export function formatSharedWithProvidersLine(
  sharedWithProviders: readonly ProviderId[],
): string | null {
  if (sharedWithProviders.length === 0) return null;
  const names = sharedWithProviders.map(providerDisplayName);
  if (names.length === 1) return `Shared by ${names[0]}`;
  if (names.length === 2) return `Shared by ${names[0]} and ${names[1]}`;
  const head = names.slice(0, -1).join(", ");
  const tail = names[names.length - 1];
  return `Shared by ${head}, and ${tail}`;
}

export type VersionDownloadEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Yanked / below-floor / host-ineligible / uncertified are never downloadable. Error rows share the Retry
 * allow-list: non-retryable errors must not be relabelled as an enabled Download (finding 1). */
export function versionDownloadEligibility(
  version: ProviderPackVersion,
): VersionDownloadEligibility {
  switch (version.certification) {
    case "yanked":
      return {
        allowed: false,
        reason: "Withdrawn by the publisher — not available for download",
      };
    case "below-security-floor":
      return {
        allowed: false,
        reason: "Below the publisher's security minimum — cannot download",
      };
    case "host-ineligible":
      return {
        allowed: false,
        reason: "This Traycer release cannot run this version",
      };
    case "uncertified":
      return {
        allowed: false,
        reason: "No longer published — not available for re-download",
      };
    case "eligible":
      break;
  }

  switch (version.installState.status) {
    case "installed":
      return { allowed: false, reason: "Already installed" };
    case "downloading":
      return { allowed: false, reason: "Download in progress" };
    case "unusable":
      if (version.installState.reason === "condemned") {
        return {
          allowed: false,
          reason: "Install failed permanently on this machine",
        };
      }
      // quarantined / corrupt / unverified - still may re-fetch once cleared.
      return { allowed: true };
    case "absent":
      return { allowed: true };
    case "error":
      // Same default-deny allow-list as Retry. Non-retryable reasons must not
      // surface as an enabled Download under a different label.
      if (versionErrorIsRetryable(version.installState)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: nonRetryableErrorDownloadReason(version.installState.reason),
      };
  }
}

/** Single composition point so the panel cannot re-offer a forbidden retry as Download. */
export function versionShowsInstallFetchAction(
  version: ProviderPackVersion,
): boolean {
  if (!versionDownloadEligibility(version).allowed) return false;
  const status = version.installState.status;
  if (status === "absent") return true;
  if (status === "error") return versionErrorIsRetryable(version.installState);
  if (status === "unusable") {
    return version.installState.reason !== "condemned";
  }
  return false;
}

export function versionInstallFetchLabel(
  version: ProviderPackVersion,
): "Download" | "Retry" {
  if (
    version.installState.status === "error" &&
    versionErrorIsRetryable(version.installState)
  ) {
    return "Retry";
  }
  return "Download";
}

export type VersionUseEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Nothing else gates it - a below-baseline version that certifies eligible is selectable, and yanked /
 * uncertified installed copies remain selectable under. */
export function versionUseEligibility(
  version: ProviderPackVersion,
): VersionUseEligibility {
  if (version.current) {
    return { allowed: false, reason: "Already current" };
  }
  if (version.installState.status !== "installed") {
    return { allowed: false, reason: "Install this version first" };
  }
  if (
    version.certification === "below-security-floor" ||
    version.certification === "host-ineligible"
  ) {
    return {
      allowed: false,
      reason: certificationBlockReason(version.certification),
    };
  }
  return { allowed: true };
}

export type VersionDeleteEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Delete is never offered for the current version ("switch first"), for a version with nothing on disk, or for
 * a quarantined one. */
export function versionDeleteEligibility(
  version: ProviderPackVersion,
): VersionDeleteEligibility {
  if (version.current) {
    return { allowed: false, reason: "Switch to another version first" };
  }
  if (
    version.installState.status !== "installed" &&
    version.installState.status !== "unusable"
  ) {
    return { allowed: false, reason: "Not installed" };
  }
  if (
    version.installState.status === "unusable" &&
    version.installState.reason === "quarantined"
  ) {
    // Same sentence `removeResultUserMessage` gives for the refusal this
    // pre-empts, so the disabled reason and the refusal cannot drift apart.
    return {
      allowed: false,
      reason: "Held by quarantine after a failed verification",
    };
  }
  return { allowed: true };
}

/** Whether the row shows a Delete control at all - enabled, or disabled with a reason. */
export function versionShowsDeleteAction(
  version: ProviderPackVersion,
): boolean {
  return (
    version.installState.status === "installed" ||
    version.installState.status === "unusable"
  );
}

/** The first half of that was wrong: it is the only state on this surface that decides whether deleting a
 * version can be undone, because an unpublished one cannot be fetched again. */
export type VersionRowChip = {
  readonly label: string;
  readonly tone: "current" | "blocked" | "unpublished" | "recommended";
};

/** They were two copies of the same three-member test, so a fourth blocking certification would have given a
 * row its chip and not its dimming, or the reverse. */
export function isBlockingCertification(
  certification: ProviderPackVersionCertification,
): boolean {
  return (
    certification === "yanked" ||
    certification === "below-security-floor" ||
    certification === "host-ineligible"
  );
}

export function versionRowChip(
  version: ProviderPackVersion,
): VersionRowChip | null {
  if (version.current) return { label: "Current", tone: "current" };
  if (isBlockingCertification(version.certification)) {
    const label = certificationBadgeLabel(version.certification);
    if (label !== null) return { label, tone: "blocked" };
  }
  if (version.certification === "uncertified") {
    // The longer sentence is still what the withdrawn family says, because those are refusals and deserve the
    // room.
    return { label: "Unpublished", tone: "unpublished" };
  }
  if (version.recommended) return { label: "Recommended", tone: "recommended" };
  return null;
}

export function certificationBadgeLabel(
  certification: ProviderPackVersionCertification,
): string | null {
  switch (certification) {
    case "yanked":
      return "Withdrawn";
    case "uncertified":
      return "No longer published";
    case "below-security-floor":
      return "Below security minimum";
    case "host-ineligible":
      return "Not supported on this host";
    case "eligible":
      return null;
  }
}

export function unusableReasonLabel(
  reason: ProviderPackVersionUnusableReason,
): string {
  switch (reason) {
    case "condemned":
      return "Install failed permanently on this machine";
    case "quarantined":
      return "Quarantined after a failed verification";
    case "corrupt":
      return "Installed copy is corrupt";
    case "unverified":
      // Indeterminate - must not read as damage.
      return "Could not verify this install (not necessarily damaged)";
  }
}

export function installErrorReasonLabel(
  reason: ProviderManagedInstallErrorReason,
): string {
  switch (reason) {
    case "disk-full":
      return "Not enough disk space to install";
    case "network":
      return "Download failed — network error";
    case "verification":
      return "Downloaded bytes failed verification";
    case "live-owner-stalled":
      return "Another process was downloading this and stalled";
    case "unknown":
      return "Install failed";
    case "unrepairable":
      return "This install cannot be repaired on this machine";
    case "trust-unavailable":
      return "Trust is unavailable on this host";
    case "local-storage-mismatch":
      return "The local copy does not match the published version";
  }
}

/** That was fine for the card's other content - `Installed`, the size, `pairs with this Traycer release` all
 * restated things the row already showed. */
export function versionTroubleLine(
  version: ProviderPackVersion,
): string | null {
  if (version.installState.status === "unusable") {
    return unusableReasonLabel(version.installState.reason);
  }
  if (version.installState.status === "error") {
    // `installState.message` is documented as the underlying operator-facing detail and can carry raw filesystem
    // or network text; it must never reach this surface.
    return installErrorReasonLabel(version.installState.reason);
  }
  if (version.current && isBlockingCertification(version.certification)) {
    return certificationMetaLine(version.certification);
  }
  return null;
}

export function certificationMetaLine(
  certification: ProviderPackVersionCertification,
): string | null {
  switch (certification) {
    case "yanked":
      return "Withdrawn by publisher";
    case "uncertified":
      // Do not claim "still usable" - install-state is a separate axis (finding 7).
      return "No longer published · remains on disk";
    case "below-security-floor":
      return "Below the publisher's security minimum";
    case "host-ineligible":
      return "This Traycer release cannot drive this version";
    case "eligible":
      return null;
  }
}

/** Typed on the protocol union rather than `string`: a `ReadonlySet<string>` accepts a member the wire no
 * longer has, and the miss is silent - the button simply stops appearing for a reason it should serve. */
const VERSION_MANAGER_RETRYABLE_ERROR_REASONS: ReadonlySet<ProviderManagedInstallErrorReason> =
  new Set<ProviderManagedInstallErrorReason>([
    "disk-full",
    "network",
    "verification",
    "live-owner-stalled",
    "unknown",
  ]);

export function versionErrorIsRetryable(
  installState: ProviderPackVersionInstallState,
): boolean {
  if (installState.status !== "error") return false;
  return VERSION_MANAGER_RETRYABLE_ERROR_REASONS.has(installState.reason);
}

export function removeResultUserMessage(
  result: Extract<ProvidersRemovePackVersionResult, { ok: false }>,
): string {
  switch (result.code) {
    case "is-current":
      return result.detail ?? "Switch to another version first";
    case "holder-reserved":
      return (
        result.detail ??
        "In use by a running session — it will be free when that session ends"
      );
    case "quarantine-reserved":
      return result.detail ?? "Held by quarantine after a failed verification";
    case "deferred-locked":
      // Not a failure - queued for boot GC.
      return result.detail ?? "Removes when no longer in use";
  }
}

/** Exhaustive over the protocol enum - hard policy must not read as "try again later." `detail` is
 * operator-facing only; never the primary sentence. */
export function installPackVersionRefusalMessage(
  code: Extract<ProvidersInstallPackVersionResult, { ok: false }>["code"],
): string {
  switch (code) {
    case "condemned":
      return "Install failed permanently on this machine";
    case "unfetchable":
      return "This version is not in the current channel — reconnect or refresh to download it";
    case "invalid-version":
      return "This is not a valid version string";
    case "below-security-floor":
      return "Below the publisher's security minimum — cannot download";
    case "host-ineligible":
      return "This Traycer release cannot run this version";
    case "yanked":
      return "Withdrawn by the publisher — not available for download";
  }
}

/** Hard policy codes must not invite retry or say "withdrawn". */
export function packVersionUseRefusalMessage(
  code: Extract<ProvidersUsePackVersionResult, { ok: false }>["code"],
): string {
  switch (code) {
    case "verification-failed":
      return "Could not verify this install before switching — the pin was not kept";
    case "below-security-floor":
      return "Below the publisher's security minimum — cannot select";
    case "host-ineligible":
      return "This Traycer release cannot run this version";
  }
}

/** The one line the footer draws after an on-demand update check. */
export type PackDiscoveryCheckNotice = {
  readonly kind: "info" | "error";
  readonly message: string;
};

/** It means this host's target knowledge changed, which the host also reports for the first population of a
 * never-derived pack and for a sibling host's pin move on a head identical to the one already running. */
export function packDiscoveryCheckOutcomeNotice(
  outcome: ProviderPackRefreshOutcome,
): PackDiscoveryCheckNotice {
  switch (outcome) {
    case "moved":
      return { kind: "info", message: "Checked the registry." };
    case "unchanged":
      return { kind: "info", message: "No changes found." };
    case "unreachable":
      return {
        kind: "error",
        message: "Couldn't reach the registry. Try again later.",
      };
    case "unusable":
      return {
        kind: "error",
        message:
          "The registry's answer couldn't be trusted. This pack's update knowledge was cleared until the next successful check.",
      };
  }
}

/** Neither code invites a retry, because neither clears on its own: `discovery-unavailable` is a property of
 * the host (no discovery machinery to run), and `pack-disabled` names an action the user has to take first. */
export function refreshPackDiscoveryRefusalMessage(
  code: Extract<ProvidersRefreshPackDiscoveryResult, { ok: false }>["code"],
): string {
  switch (code) {
    case "discovery-unavailable":
      return "Update checks aren't available on this host right now.";
    case "pack-disabled":
      return "Enable this provider to check for updates.";
  }
}

/** Whether the update-available banner may offer Download for this version. */
export function updateBannerDownloadEligibility(
  available: readonly ProviderPackVersion[],
  version: string,
): VersionDownloadEligibility {
  const row = available.find((entry) => entry.version === version);
  if (row === undefined) {
    return {
      allowed: false,
      reason:
        "Can't confirm this version is fetchable — reconnect to download updates",
    };
  }
  return versionDownloadEligibility(row);
}

export function findRecommendedVersion(
  managed: ProviderManagedVersions,
): string | null {
  const recommended = managed.available.find((row) => row.recommended);
  return recommended?.version ?? null;
}

/** Equal-precedence versions, including build-metadata-only differences, tie-break by version string. */
export function comparePackVersionsDescending(
  left: string,
  right: string,
): number {
  const result = compareHostVersions(left, right);
  if (result.comparable) {
    if (result.ordering === "greater") return -1;
    if (result.ordering === "less") return 1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function nonRetryableErrorDownloadReason(
  reason: ProviderManagedInstallErrorReason,
): string {
  switch (reason) {
    case "trust-unavailable":
      return "Trust is unavailable on this host — cannot download";
    case "local-storage-mismatch":
      return "Local storage does not match — cannot re-download";
    case "unrepairable":
      return "This install cannot be repaired on this machine";
    default:
      return "This error cannot be retried from the version manager";
  }
}

function certificationBlockReason(
  certification: "below-security-floor" | "host-ineligible",
): string {
  return certificationMetaLine(certification) ?? "Not usable";
}

/** Total over the wire enum plus the one client-side cause the host cannot report (a host too old to have the
 * RPCs at all). */
export function managedVersionsUnavailableMessage(
  cause: ProviderManagedVersionsUnavailableCause,
): string {
  switch (cause) {
    case "host-unsupported":
      return "This host is too old to manage provider CLI versions. Update the host to turn this on.";
    case "registry-unconfigured":
      return "This build has no provider registry configured, so there are no versions to manage. Waiting will not change it.";
    case "registry-unreachable":
      return "Traycer could not verify the provider registry's signing keys — usually no network, or the registry is down. It keeps retrying in the background.";
    case "registry-not-yet-checked":
      return "Traycer has not finished checking the provider registry yet. This should resolve on its own in a moment.";
    case "install-manager-unavailable":
      return "The registry was verified, but Traycer could not start its installer, so versions cannot be listed. Restarting the host usually clears this.";
  }
}

export type ProviderManagedVersionsUnavailableCause =
  | "host-unsupported"
  | ProviderManagedVersionsUnavailable["reason"];

/** Deliberately not the row's headline. */
export function managedInstallFailureMessage(
  reason: ProviderManagedInstallErrorReason,
  version: string | null,
): string {
  const build = version === null ? "the managed build" : `managed v${version}`;
  switch (reason) {
    case "disk-full":
      return `Not enough disk space to install ${build}. Free some space, then retry.`;
    case "network":
      return `Traycer could not download ${build}. That is usually a network problem, but it also happens when the registry carries no artifact for this version and platform - in which case retrying will not help.`;
    case "verification":
      return `${build} failed its signature check and was discarded. Traycer will not run bytes it cannot verify.`;
    case "live-owner-stalled":
      return `Another Traycer host on this machine was installing ${build} and stalled. Retrying takes the download over.`;
    case "trust-unavailable":
      return `Traycer cannot verify downloads on this host, so ${build} was not installed. Retrying will not help until the registry's signing keys load.`;
    case "local-storage-mismatch":
      return `The stored copy of ${build} does not match what Traycer expects, and it cannot be re-downloaded on this machine.`;
    case "unrepairable":
      return `${build} cannot be installed on this machine, and retrying will not change that.`;
    case "unknown":
      return `Traycer could not install ${build}.`;
  }
}
