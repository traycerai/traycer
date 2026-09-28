import type { HostListItem } from "@traycer/protocol/host/host-status";
import {
  formatArchitecture,
  formatHostVersion,
  formatPlatform,
} from "@/components/settings/host-scope/host-scope-model";
import { formatElapsed } from "@/components/settings/panels/my-hosts-model";

/**
 * What About this host is drawn from: the ACCOUNT's record of the host, plus
 * the two things that word its "Last seen". None of it is a host RPC, which is
 * the whole reason the group still reads while the host cannot be reached.
 */
export interface HostOverviewAboutSource {
  readonly item: HostListItem;
  /**
   * The header's live evidence for this host (`HostScopeOption.health.live`):
   * while it holds, Last seen reads "Online now", matching the live dot beside
   * the name rather than a timestamp the registry refreshes in minutes.
   */
  readonly live: boolean;
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

export function deriveAboutThisHost(
  source: HostOverviewAboutSource,
): HostOverviewAboutView {
  const { item } = source;
  return {
    hostId: item.hostId,
    addedToAccount: formatAccountDate(item.createdAt),
    lastSeen: source.live
      ? "Online now"
      : describeLastSeen(item.status.lastSeenAt, source.nowMs),
    online: source.live,
    lastReportedVersion:
      formatHostVersion(item.status.appVersion) ?? NOT_REPORTED,
    platform: describePlatform(item.platform),
  };
}

/** "Mar 3, 2026"; an unparsable stamp is shown as it came. */
function formatAccountDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
