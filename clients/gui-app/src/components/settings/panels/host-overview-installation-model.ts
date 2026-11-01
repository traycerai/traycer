import type { HostListItem } from "@traycer/protocol/host/host-status";
import {
  formatArchitecture,
  formatHostVersion,
  formatPlatform,
} from "@/components/settings/host-scope/host-scope-model";
import {
  deriveHostPresence,
  formatElapsed,
} from "@/components/settings/panels/my-hosts-model";
import { formatSettingsDate } from "@/lib/settings/settings-date";

/**
 * What About this host is drawn from: the ACCOUNT's record of the host, and
 * the clock its "Last seen" is worded on. None of it is a host RPC, which is
 * the whole reason the group still reads while the host cannot be reached.
 */
export interface HostOverviewAboutSource {
  readonly item: HostListItem;
  /** The scope's clock - the one the header's "Last seen …" is worded on. */
  readonly nowMs: number;
}

export interface HostOverviewAboutView {
  readonly hostId: string;
  readonly addedToAccount: string;
  readonly lastSeen: string;
  readonly online: boolean;
  readonly lastReportedVersion: string;
  readonly platform: string;
}

const NOT_REPORTED = "Not reported yet";

/**
 * Whether the ACCOUNT holds this host right now, which is the only evidence
 * "Online now" can stand on in a row whose subject is when the account last
 * heard from the host.
 *
 * Read from the account's own presence derivation with NO session evidence
 * (`hasLiveSession: false`), which is the fix rather than a simplification.
 * The row used to follow the header's live dot (`HostScopeOption.health.live`),
 * and that dot's strongest source is the local process read - firsthand about
 * a process on this box and worth nothing about the account's reach. A host
 * whose identity plane has paused serves this app over its local stream while
 * its relay uplink is down, so the header read Online, the account had not
 * heard from it in minutes, and this row said "Online now" - a claim about
 * every other device, made from evidence that covers only this one.
 *
 * `deriveHostPresence` answers `reported-reachable` for exactly that fact (the
 * account's relay holds a live attachment) and `client-offline` when this
 * viewer cannot refresh the record at all, so a stale `connectable` behind a
 * dropped cloud link does not word the row either.
 */
function accountHoldsHostNow(item: HostListItem): boolean {
  const presence = deriveHostPresence({
    status: item.status,
    hasLiveSession: false,
  });
  return presence.reading === "reported-reachable";
}

export function deriveAboutThisHost(
  source: HostOverviewAboutSource,
): HostOverviewAboutView {
  const { item } = source;
  const online = accountHoldsHostNow(item);
  return {
    hostId: item.hostId,
    addedToAccount: formatAccountDate(item.createdAt),
    lastSeen: online
      ? "Online now"
      : describeLastSeen(item.status.lastSeenAt, source.nowMs),
    online,
    lastReportedVersion:
      formatHostVersion(item.status.appVersion) ?? NOT_REPORTED,
    platform: describePlatform(item.platform),
  };
}

/** An unparsable account timestamp is shown as it came. */
function formatAccountDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return formatSettingsDate(at, false);
}

/**
 * "3h ago" - the same ladder, and the same clock, as the header's "Last seen
 * 3h ago" for a host that is offline, so the two never disagree on one screen.
 */
function describeLastSeen(lastSeenAt: string | null, nowMs: number): string {
  if (lastSeenAt === null) return "Not seen yet";
  const then = Date.parse(lastSeenAt);
  if (Number.isNaN(then)) return "Unknown";
  const elapsed = formatElapsed(Math.max(0, Math.round((nowMs - then) / 1000)));
  return elapsed.charAt(0).toUpperCase() + elapsed.slice(1);
}

/** "macOS · arm64", as the header's health line words the same triple. */
function describePlatform(platform: string | null): string {
  const parts = [formatPlatform(platform), formatArchitecture(platform)].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return parts.length === 0 ? NOT_REPORTED : parts.join(" · ");
}

/**
 * An identifier shortened to its head and tail ("8f14e45f…c9a2"), so a fact
 * grid can hold a 64-character digest without four lines of hex. The caller
 * keeps the whole value on a copy button and in the tooltip. Short values are
 * returned whole.
 */
export function abbreviateIdentifier(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
