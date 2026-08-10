import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
  type ProviderManagedVersions,
  type ProviderPackVersion,
  type ProviderPackVersionCertification,
  type ProviderPackVersionInstallState,
  type ProviderPackVersionUnusableReason,
  type ProvidersInstallPackVersionResult,
  type ProvidersRemovePackVersionResult,
  type ProvidersUsePackVersionResult,
} from "@traycer/protocol/host/provider-schemas";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";

/**
 * Pure decision helpers for the per-pack version-manager panel.
 *
 * Kept free of React so tests can prove action availability without mounting
 * hooks, and so the panel stays a thin renderer over product rules that live
 * once.
 */

/** Bytes → compact human label. Null sizes (yank tombstones) stay null. */
export function formatPackSizeBytes(sizeBytes: number | null): string | null {
  if (sizeBytes === null) return null;
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  const kib = sizeBytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib < 10 ? 1 : 0)} MB`;
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GB`;
}

export function providerDisplayName(providerId: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[providerId];
}

/**
 * "Shared by OpenCode, Traycer, OpenRouter" — the other providers on this
 * pack, excluding the row the user opened from (already on `sharedWithProviders`).
 */
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

/**
 * Download is offered only for versions the host can still fetch and that are
 * not already on disk in a usable/downloading form. Yanked / below-floor /
 * host-ineligible / uncertified are never downloadable.
 *
 * Error rows share the Retry allow-list: non-retryable errors must not be
 * relabelled as an enabled Download (finding 1).
 */
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
      // quarantined / corrupt / unverified — still may re-fetch once cleared.
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

/**
 * Whether the row should show any install-fetch button (Download or Retry).
 * Single composition point so the panel cannot re-offer a forbidden retry as
 * Download.
 */
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

/**
 * Use is disabled for the current version and for any version below the
 * recommended (baked-pin) baseline, regardless of list source (D1).
 *
 * Fail closed when the baseline is unknown (offline / no recommended row):
 * offer Use only on positive proof the candidate clears the floor.
 */
export function versionUseEligibility(
  version: ProviderPackVersion,
  recommendedVersion: string | null,
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
  if (recommendedVersion === null) {
    return {
      allowed: false,
      reason:
        "Can't confirm the shipped baseline — reconnect to switch versions",
    };
  }
  if (isVersionBelowBaseline(version.version, recommendedVersion)) {
    return {
      allowed: false,
      reason: `Below shipped baseline ${recommendedVersion}`,
    };
  }
  return { allowed: true };
}

export type VersionDeleteEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Delete is never offered for the current version ("switch first"). */
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
  return { allowed: true };
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

export function certificationMetaLine(
  certification: ProviderPackVersionCertification,
): string | null {
  switch (certification) {
    case "yanked":
      return "Withdrawn by publisher";
    case "uncertified":
      // Do not claim "still usable" — install-state is a separate axis (finding 7).
      return "No longer published · remains on disk";
    case "below-security-floor":
      return "Below the publisher's security minimum";
    case "host-ineligible":
      return "This Traycer release cannot drive this version";
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
      // Indeterminate — must not read as damage.
      return "Could not verify this install (not necessarily damaged)";
  }
}

/**
 * Composed row metadata. Certification and install-state are independent wire
 * axes; this helper is the only place that concatenates them so contradictory
 * "still usable" + "could not verify" pairs cannot appear (finding 7).
 */
export function composeVersionRowMeta(options: {
  readonly installState: ProviderPackVersionInstallState;
  readonly certification: ProviderPackVersionCertification;
  readonly sizeLabel: string | null;
  readonly recommended: boolean;
}): string {
  const parts: string[] = [];
  const installPart = installStateMetaPart(options.installState);
  if (installPart !== null) parts.push(installPart);
  if (options.sizeLabel !== null) parts.push(options.sizeLabel);
  if (options.recommended) {
    parts.push("pairs with this Traycer release");
  }

  const certPart = certificationMetaForCompose(
    options.certification,
    options.installState,
  );
  if (certPart !== null) parts.push(certPart);

  return parts.join(" · ");
}

/** Error reasons the version-manager Retry button may fire for. Allow-list. */
const VERSION_MANAGER_RETRYABLE_ERROR_REASONS: ReadonlySet<string> = new Set([
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
      // Not a failure — queued for boot GC.
      return result.detail ?? "Removes when no longer in use";
  }
}

/**
 * Primary user copy for a typed install-pack-version refusal.
 * Exhaustive over the protocol enum — hard policy must not read as "try again
 * later." `detail` is operator-facing only; never the primary sentence.
 */
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
    case "pin-below-floor":
      return "Cannot install below the shipped baseline";
    case "below-security-floor":
      return "Below the publisher's security minimum — cannot download";
    case "host-ineligible":
      return "This Traycer release cannot run this version";
    case "yanked":
      return "Withdrawn by the publisher — not available for download";
  }
}

/**
 * Primary user copy for a typed use-pack-version (Use / pin) refusal.
 * Exhaustive over the protocol enum. Hard policy codes must not invite retry
 * or say "withdrawn" (yanked/uncertified installed copies remain selectable
 * under D8 — these two refusals are signed positive ineligibility only).
 * `detail` is operator-facing only.
 */
export function packVersionUseRefusalMessage(
  code: Extract<ProvidersUsePackVersionResult, { ok: false }>["code"],
): string {
  switch (code) {
    case "pin-below-floor":
      return "Cannot select below the shipped baseline";
    case "verification-failed":
      return "Could not verify this install before switching — the pin was not kept";
    case "below-security-floor":
      return "Below the publisher's security minimum — cannot select";
    case "host-ineligible":
      return "This Traycer release cannot run this version";
  }
}

/**
 * Whether the update-available banner may offer Download for this version.
 * Fail closed when the durable head version is not in `available` (offline /
 * expired knowledge): a missing row is not permission to download.
 */
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

/**
 * Newest-first SemVer order via the shared host-version authority.
 * Equal precedence (incl. build-metadata-only differences) ties break by
 * version string for a stable UI order.
 */
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

/**
 * Baseline comparison for the Use-below-recommended rule (D1).
 *
 * Delegates to the single shared SemVer authority
 * (`@traycer-clients/shared/host-version/compare-host-versions`) used by CLI
 * and desktop for host-update decisions — full §11 precedence including
 * prereleases, with build metadata (`+…`) ignored. A third hand-rolled
 * comparator is deliberately not introduced here (finding 4 harden).
 *
 * When either side is not SemVer, fails closed (treated as below baseline)
 * so Use is not offered without a positive proof the candidate clears the
 * floor. Identity still returns false.
 */
export function isVersionBelowBaseline(
  version: string,
  baseline: string,
): boolean {
  if (version === baseline) return false;
  const result = compareHostVersions(version, baseline);
  if (!result.comparable) return true;
  return result.ordering === "less";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function installStateMetaPart(
  installState: ProviderPackVersionInstallState,
): string | null {
  switch (installState.status) {
    case "installed":
      return "Installed";
    case "absent":
      return "Not installed";
    case "downloading":
      return installState.percent === null
        ? "Downloading…"
        : `Downloading · ${String(Math.round(installState.percent))}%`;
    case "unusable":
      return unusableReasonLabel(installState.reason);
    case "error":
      return installState.message;
  }
}

function certificationMetaForCompose(
  certification: ProviderPackVersionCertification,
  installState: ProviderPackVersionInstallState,
): string | null {
  if (certification === "eligible") return null;

  // Uncertified + indeterminate verification: one coherent claim — remains on
  // disk, not proven usable, not proven damaged.
  if (
    certification === "uncertified" &&
    installState.status === "unusable" &&
    installState.reason === "unverified"
  ) {
    return "No longer published · remains on disk";
  }

  return certificationMetaLine(certification);
}

function nonRetryableErrorDownloadReason(reason: string): string {
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
