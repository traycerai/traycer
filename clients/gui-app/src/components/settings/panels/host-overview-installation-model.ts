import type { HostListItem } from "@traycer/protocol/host/host-status";
import {
  formatArchitecture,
  formatHostVersion,
  formatPlatform,
} from "@/components/settings/host-scope/host-scope-model";
import { formatElapsed } from "@/components/settings/panels/my-hosts-model";
import type { InstallationDetailsRecord } from "@/components/settings/panels/host-settings-installation-details";
import {
  formatInstallDate,
  formatSource,
} from "@/components/settings/panels/host-settings-panel-model";
import { formatSettingsDate } from "@/lib/settings/settings-date";

/**
 * The account's record of the host, with the scope's clock for qualifying
 * the freshness of registry facts. None of it needs a host RPC.
 */
export interface HostOverviewAboutSource {
  readonly item: HostListItem;
  /** The scope's clock - the one the header's "Last seen …" is worded on. */
  readonly nowMs: number;
}

/**
 * About shows only facts the account actually has. A host that has never
 * checked in is one line, not a last-seen cell saying it has not been seen.
 */
export interface HostOverviewAboutView {
  readonly addedToAccount: string;
  /** "Not seen since it was added" when `lastSeenAt` is null. */
  readonly unseenLine: string | null;
}

const LIVE_FRESHNESS = "from this host now";
const NO_VERSION_RECEIVED = "No version received by the account";
const UNSEEN_SINCE_ADDED = "Not seen since it was added";

/** The CLI's sentinel for "this install was never signed". */
const UNSIGNED_SIGNATURE_KEY_ID = "local-file:unsigned";

export interface InstallationDetailRow {
  readonly label: string;
  readonly value: string;
  readonly kind: "code" | "text";
  readonly tone: "default" | "success" | "warning";
  readonly copy: { readonly value: string; readonly label: string } | null;
  readonly testId: string;
}

/**
 * What Installation ▸ Details is drawn from.
 *
 * `runningVersion` is the header's own value, `view.hostVersion ?? host.version`.
 * The registry's `appVersion` is a second line only when that display differs,
 * so one screen does not show the same version twice.
 */
export interface InstallationDetailsSource {
  readonly about: HostOverviewAboutSource | null;
  /**
   * True when this tab has a route and is not waiting out a connect or a
   * restart. Freshness says "from this host now" only then.
   */
  readonly live: boolean;
  readonly runningVersion: string | null;
  /**
   * The install record while this tab is showing it. Platform and architecture
   * prefer it over the account's copy, because it is the host's own answer.
   * Null while the record is unread, missing, or withheld.
   */
  readonly record: InstallationDetailsRecord | null;
}

export function deriveAboutThisHost(
  source: HostOverviewAboutSource,
): HostOverviewAboutView {
  const { item } = source;
  return {
    addedToAccount: formatAccountDate(item.createdAt),
    unseenLine: item.status.lastSeenAt === null ? UNSEEN_SINCE_ADDED : null,
  };
}

/** An unparsable account timestamp is shown as it came. */
function formatAccountDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return formatSettingsDate(at, false);
}

function elapsedWords(lastSeenAt: string, nowMs: number): string | null {
  const then = Date.parse(lastSeenAt);
  if (Number.isNaN(then)) return null;
  return formatElapsed(Math.max(0, Math.round((nowMs - then) / 1000)));
}

/**
 * Platform, architecture, the running version, the registry version when it
 * differs, and the host id. A row is omitted when its fact is unknown.
 * Architecture is included whenever it is known, including when the account
 * triple is the only source.
 */
export function deriveInstallationDetails(
  source: InstallationDetailsSource,
): readonly InstallationDetailRow[] {
  const rows: InstallationDetailRow[] = [];
  const accountFreshness = accountFreshnessSuffix(source.about);
  const place = describePlace(source);
  if (place.platform !== null) {
    rows.push({
      label: "Platform",
      value: withFreshness(place.platform, place.live, accountFreshness),
      kind: "text",
      tone: "default",
      copy: null,
      testId: "host-overview-about-platform",
    });
  }
  if (place.architecture !== null) {
    rows.push({
      label: "Architecture",
      value: withFreshness(place.architecture, place.live, accountFreshness),
      kind: "text",
      tone: "default",
      copy: null,
      testId: "host-overview-about-architecture",
    });
  }

  const runningDisplay = displayedVersion(source.runningVersion);
  const recordFallback =
    runningDisplay === null && source.record !== null
      ? displayedInstallVersion(source.record)
      : null;
  const buildDisplay = runningDisplay ?? recordFallback;
  if (buildDisplay !== null) {
    const freshness = buildVersionFreshness(
      source,
      runningDisplay,
      accountFreshness,
    );
    rows.push({
      label: "Build version",
      value:
        freshness === null ? buildDisplay : `${buildDisplay} · ${freshness}`,
      kind: "code",
      tone: "default",
      copy: null,
      testId: "settings-host-install-version",
    });
  }

  const reported = registryRow(source, buildDisplay, accountFreshness);
  if (reported !== null) rows.push(reported);

  const hostId = source.about?.item.hostId ?? null;
  if (hostId !== null && hostId.length > 0) {
    rows.push({
      label: "Host ID",
      value: abbreviateIdentifier(hostId),
      kind: "code",
      tone: "default",
      copy: { value: hostId, label: "Copy host ID" },
      testId: "host-overview-about-host-id",
    });
  }
  return rows;
}

/**
 * The install record's facts that did not move into Details: the install id
 * when it is not the version above it, then source, installed, verification
 * and SHA-256. Version and platform are not here — Details already shows them.
 *
 * `runningVersion` is that version above it. On the CLI-bridge path
 * `runtimeVersion` is null and `version` is the only install id the record
 * has, so it is still shown when it is not the running version.
 */
export function deriveInstallRecordRows(
  record: InstallationDetailsRecord,
  runningVersion: string | null,
): readonly InstallationDetailRow[] {
  const rows: InstallationDetailRow[] = [];
  if (!installIdAlreadyShown(record, runningVersion)) {
    rows.push({
      label: "Build",
      value: record.version,
      kind: "code",
      tone: "default",
      copy: null,
      testId: "settings-host-install-build",
    });
  }
  rows.push({
    label: "Source",
    value: formatSource(record.source),
    kind: "code",
    tone: "default",
    copy: null,
    testId: "settings-host-install-source",
  });
  rows.push({
    label: "Installed",
    value: formatInstallDate(record.installedAt),
    kind: "code",
    tone: "default",
    copy: null,
    testId: "settings-host-install-installed",
  });
  const verified = isSignatureVerified(record);
  rows.push({
    label: "Verification",
    value: describeVerification(record),
    kind: "code",
    tone: verified ? "success" : "warning",
    copy: null,
    testId: "settings-host-verification",
  });
  if (record.archiveSha256 !== null && record.archiveSha256.length > 0) {
    rows.push({
      label: "SHA-256",
      value: abbreviateIdentifier(record.archiveSha256),
      kind: "code",
      tone: "default",
      copy: { value: record.archiveSha256, label: "Copy SHA-256" },
      testId: "settings-host-install-sha256",
    });
  }
  return rows;
}

function buildVersionFreshness(
  source: InstallationDetailsSource,
  runningDisplay: string | null,
  accountFreshness: string,
): string | null {
  if (source.live) return LIVE_FRESHNESS;
  if (runningDisplay !== null && runningDisplay === registryDisplay(source)) {
    return accountFreshness;
  }
  return null;
}

function withFreshness(
  value: string,
  live: boolean,
  accountFreshness: string,
): string {
  return live
    ? `${value} · ${LIVE_FRESHNESS}`
    : `${value} · ${accountFreshness}`;
}

function accountFreshnessSuffix(about: HostOverviewAboutSource | null): string {
  if (about === null) return "last account report";
  const lastSeenAt = about.item.status.lastSeenAt;
  if (lastSeenAt === null) return "last account report";
  const elapsed = elapsedWords(lastSeenAt, about.nowMs);
  if (elapsed === null) return "last account report";
  return `last account report, ${elapsed}`;
}

function describePlace(source: InstallationDetailsSource): {
  readonly platform: string | null;
  readonly architecture: string | null;
  readonly live: boolean;
} {
  const record = source.record;
  if (source.live && record !== null) {
    const platform = formatPlatform(record.platform);
    const architecture =
      record.arch.length > 0
        ? record.arch
        : formatArchitecture(record.platform);
    return { platform, architecture, live: true };
  }
  const accountPlatform = source.about?.item.platform ?? null;
  return {
    platform: formatPlatform(accountPlatform),
    architecture: formatArchitecture(accountPlatform),
    live: false,
  };
}

function displayedVersion(version: string | null): string | null {
  if (version === null || version.length === 0) return null;
  return formatHostVersion(version);
}

/**
 * What the install record used to label Version: the runtime the record
 * names, or the install id when the bridge has no runtime field. A non-semver
 * install id stays whole — `formatHostVersion` would collapse it to
 * "Preview build" and the stamp would disappear.
 */
function displayedInstallVersion(
  record: InstallationDetailsRecord,
): string | null {
  const raw = record.runtimeVersion ?? record.version;
  if (raw.length === 0) return null;
  const formatted = formatHostVersion(raw);
  if (formatted === null || formatted === "Preview build") return `v${raw}`;
  return formatted;
}

function registryDisplay(source: InstallationDetailsSource): string | null {
  const appVersion = source.about?.item.status.appVersion ?? null;
  return displayedVersion(appVersion);
}

function registryRow(
  source: InstallationDetailsSource,
  buildDisplay: string | null,
  accountFreshness: string,
): InstallationDetailRow | null {
  if (source.about === null) return null;
  const appVersion = source.about.item.status.appVersion;
  if (appVersion === null || appVersion.length === 0) {
    return {
      label: "Last reported version",
      value: NO_VERSION_RECEIVED,
      kind: "text",
      tone: "default",
      copy: null,
      testId: "host-overview-about-version",
    };
  }
  const reported = displayedVersion(appVersion);
  if (reported === null || reported === buildDisplay) return null;
  return {
    label: "Last reported version",
    value: `${reported} · ${accountFreshness}`,
    kind: "code",
    tone: "default",
    copy: null,
    testId: "host-overview-about-version",
  };
}

function installIdAlreadyShown(
  record: InstallationDetailsRecord,
  runningVersion: string | null,
): boolean {
  if (record.version.length === 0) return true;
  if (runningVersion !== null && runningVersion.length > 0) {
    return record.version === runningVersion;
  }
  const shownAsVersion = record.runtimeVersion ?? record.version;
  return record.version === shownAsVersion;
}

function isSignatureVerified(record: InstallationDetailsRecord): boolean {
  return (
    record.signatureVerifiedAt !== null &&
    record.signatureKeyId !== UNSIGNED_SIGNATURE_KEY_ID
  );
}

function describeVerification(record: InstallationDetailsRecord): string {
  if (record.signatureKeyId === UNSIGNED_SIGNATURE_KEY_ID) {
    // Not "Unverified": nothing failed and nothing is wrong. This build was
    // installed from a local file or run from a tree, so there was no
    // signature to check in the first place.
    return "Unsigned local build";
  }
  return record.signatureVerifiedAt === null
    ? "Unverified"
    : `Verified ${formatInstallDate(record.signatureVerifiedAt)}`;
}

/**
 * An identifier shortened to its head and tail ("8f14e45f…c9a2"), so a fact
 * can hold a 64-character digest without four lines of hex. The caller keeps
 * the whole value on a copy button and in the tooltip. Short values are
 * returned whole.
 */
export function abbreviateIdentifier(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
