import type { HostListItem } from "@traycer/protocol/host/host-status";
import {
  formatArchitecture,
  formatHostVersion,
  formatPlatform,
} from "@/components/settings/host-scope/host-scope-model";
import { formatElapsed } from "@/components/settings/panels/my-hosts-model";
import { formatSettingsDate } from "@/lib/settings/settings-date";

/**
 * The account's record of the host, with the scope's clock for the Last seen
 * row. None of it needs a host RPC.
 */
export interface HostOverviewAboutSource {
  readonly item: HostListItem;
  /** The scope's clock the Last seen row is worded on. */
  readonly nowMs: number;
}

/**
 * What the account knows, each cell filled. An unknown fact is the word for
 * unknown, never a missing row and never "Online now".
 */
export interface HostOverviewAboutView {
  readonly hostId: string;
  readonly addedToAccount: string;
  readonly lastSeen: string;
  readonly lastReportedVersion: string;
  readonly platform: string;
}

const NOT_REPORTED = "Not reported yet";

/**
 * Last seen is the account's own stamp. It never reads "Online now": that
 * word followed this app's local reach, which is not the account's check-in.
 */
export function deriveAboutThisHost(
  source: HostOverviewAboutSource,
): HostOverviewAboutView {
  const { item } = source;
  return {
    hostId: item.hostId,
    addedToAccount: formatAccountDate(item.createdAt),
    lastSeen: describeLastSeen(item.status.lastSeenAt, source.nowMs),
    lastReportedVersion:
      formatHostVersion(item.status.appVersion) ?? NOT_REPORTED,
    platform: describeAccountPlatform(item.platform),
  };
}

/** An unparsable account timestamp is shown as it came. */
function formatAccountDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return formatSettingsDate(at, false);
}

function describeLastSeen(lastSeenAt: string | null, nowMs: number): string {
  if (lastSeenAt === null) return "Not seen yet";
  const elapsed = elapsedWords(lastSeenAt, nowMs);
  if (elapsed === null) return "Unknown";
  return elapsed.charAt(0).toUpperCase() + elapsed.slice(1);
}

/** "macOS · arm64", or the explicit unknown when the account has no triple. */
function describeAccountPlatform(platform: string | null): string {
  const parts = [formatPlatform(platform), formatArchitecture(platform)].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return parts.length === 0 ? NOT_REPORTED : parts.join(" · ");
}

function elapsedWords(lastSeenAt: string, nowMs: number): string | null {
  const then = Date.parse(lastSeenAt);
  if (Number.isNaN(then)) return null;
  return formatElapsed(Math.max(0, Math.round((nowMs - then) / 1000)));
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
