import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
  type ProviderManagedInstallErrorReason,
  type ProviderManagedVersions,
  type ProviderManagedVersionsUnavailable,
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
 * Use is disabled for the current version, for rows not installed yet, and
 * for the signed positive refusals (`below-security-floor` /
 * `host-ineligible`). Nothing else gates it — a below-baseline version that
 * certifies eligible is selectable (D1 as revised 2026-08-12), and yanked /
 * uncertified installed copies remain selectable under D8.
 */
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

/**
 * Delete is never offered for the current version ("switch first"), for a
 * version with nothing on disk, or for a quarantined one.
 *
 * The quarantine arm mirrors a positive host rule rather than guessing: the
 * remove RPC reserves a quarantined directory as evidence of a failed
 * verification and answers `quarantine-reserved`. Offering the button anyway
 * means offering an action solely to refuse it, and the row already has a
 * better place to say why. The host stays the authority - a stale client can
 * still ask, and still gets the typed refusal.
 */
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

/**
 * The ONE chip a version row may wear, or none.
 *
 * The row used to stack up to three (`Recommended` + `Current` + a
 * certification badge) beside a meta line that repeated two of them, so the
 * list read as a wall of labels rather than a list of versions. One chip, by
 * priority; everything else moves to the row's hover card.
 *
 * `uncertified` deliberately earns NO chip. "No longer published" is
 * informational - the copy stays installed and stays usable - and it was the
 * single loudest thing on a healthy row. The three certifications that
 * genuinely BLOCK do outrank `Recommended`, because a version you cannot use
 * matters more than one we suggest.
 */
export type VersionRowChip = {
  readonly label: string;
  readonly tone: "current" | "blocked" | "recommended";
};

/**
 * Whether the signed certification BLOCKS this version, as opposed to merely
 * annotating it.
 *
 * One predicate, two consumers: the row's blocked chip and the row's dimming.
 * They were two copies of the same three-member test, so a fourth blocking
 * certification would have given a row its chip and not its dimming, or the
 * reverse. `uncertified` is deliberately not a member - an installed copy the
 * channel stopped listing stays usable (D8).
 */
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
  if (version.recommended) return { label: "Recommended", tone: "recommended" };
  return null;
}

/**
 * Everything about a version that is NOT its number, its chip, or its action.
 *
 * Lives in the row's hover card. Returned as lines rather than one string so
 * the card can space them; `composeVersionRowMeta` still owns the one-line
 * composition of install-state + size + certification, including the
 * uncertified/unverified pair that must not read as "still usable".
 */
export function versionDetailLines(
  version: ProviderPackVersion,
): readonly string[] {
  const lines: string[] = [];
  const meta = composeVersionRowMeta({
    installState: version.installState,
    certification: version.certification,
    sizeLabel: formatPackSizeBytes(version.sizeBytes),
    recommended: version.recommended,
  });
  if (meta.length > 0) lines.push(meta);

  // Only ever stated for a row that RENDERS a disabled Use - an installed,
  // non-current version. Anywhere else there is no control for it to explain.
  if (version.installState.status === "installed" && !version.current) {
    const useElig = versionUseEligibility(version);
    if (!useElig.allowed) lines.push(`Can't switch to it — ${useElig.reason}`);
  }
  return lines;
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

/**
 * Error reasons the version-manager Retry button may fire for. Allow-list.
 *
 * Typed on the protocol union rather than `string`: a `ReadonlySet<string>`
 * accepts a member the wire no longer has, and the miss is silent - the button
 * simply stops appearing for a reason it should serve. The union makes a
 * renamed or removed reason a compile error here.
 */
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
      return installErrorReasonLabel(installState.reason);
  }
}

/**
 * User-facing copy for a failed install, derived from the TYPED reason.
 *
 * The wire `message` is deliberately not rendered. The schema documents it as
 * the underlying operator-facing detail, so it can carry raw filesystem and
 * network text; and it says nothing about the only thing the reader has to
 * decide - whether waiting, retrying, or freeing disk is what helps. The typed
 * reason carries exactly that, so the renderer owns the sentence.
 *
 * Total over the union with no `default`, so a ninth reason is a compile error
 * here rather than a raw diagnostic reaching the row.
 */
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

/**
 * Copy for the reasons the Retry allow-list deliberately excludes.
 *
 * The parameter is the protocol union, not `string`. With `string` the
 * `default` arm absorbed every typo and every future reason silently; now a
 * new non-retryable reason that needs its own sentence shows up as an
 * unhandled case at the call site rather than as generic copy in the UI. The
 * `default` stays for the reasons that are on the allow-list and therefore
 * never reach here.
 */
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

/**
 * Why the version manager is not on screen, in the user's terms.
 *
 * Total over the wire enum plus the one client-side cause the host cannot
 * report (a host too old to have the RPCs at all). The panel used to render
 * nothing for every one of these, which reads as "this feature does not exist"
 * rather than "it cannot run right now".
 *
 * Each line says whether waiting will help, because that is the only decision
 * the reader actually has.
 */
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
  "host-unsupported" | ProviderManagedVersionsUnavailable["reason"];

/**
 * Why the managed install failed, for the CLI row's warning affordance.
 *
 * DELIBERATELY NOT the row's headline. When this fires the provider is still
 * runnable - the resolver fell through to the bundled or PATH binary and the
 * row's Active chip names it - so the failure is a footnote to a working
 * state, not the state itself. Leading with it is what made a healthy row read
 * as broken.
 *
 * Names the version because "Install failed" alone cannot be acted on: the
 * common cause is a pinned version the registry has no artifact for, and
 * seeing WHICH version is the difference between "retry" and "this pin was
 * never published".
 *
 * Each line ends by saying whether a retry can help, since that is the only
 * decision available here - and for four of these reasons the honest answer is
 * no, which the old shared copy could not express.
 */
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
