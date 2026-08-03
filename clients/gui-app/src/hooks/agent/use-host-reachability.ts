import { useMemo } from "react";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { isUnknownHost } from "@/lib/host/constants";

export type HostReachabilityStatus =
  "checking" | "reachable" | "unreachable" | "host-starting";

export interface HostReachability {
  readonly status: HostReachabilityStatus;
  readonly hostLabel: string;
}

/**
 * Reachability check for a tile's bound host.
 *
 * Per CLAUDE.md tabs are bound to a host for life. This hook is only a
 * directory-membership gate for renderers that need to know whether the bound
 * host still exists. It is NOT a remote reachability probe and must never write
 * viewer-reachability provenance; remote presence leases are status evidence
 * for My Hosts, not proof that an already-bound tab is permanently dead.
 *
 * Rows that carry the unknown-host placeholder (legacy artifacts
 * created before per-tile binding existed, or transient pre-binding
 * states) report "reachable" so they continue to render against
 * whichever host the renderer is currently using.
 *
 * "unreachable" is reserved for a directory that HAS entries but not the
 * bound host (foreign machine, past identity, or a host marked
 * unavailable). A resolved-but-EMPTY directory reports "host-starting"
 * instead - the local host simply hasn't published yet.
 */
export function useHostReachability(hostId: string): HostReachability {
  const list = useHostDirectoryList();
  return useMemo<HostReachability>(() => {
    if (list.data === undefined) {
      // The directory query is disabled when no host binding exists
      // (e.g., test harnesses that do not mount the renderer's host
      // provider). With no source of truth we cannot gate the tile;
      // fall through to "reachable" so the live render path proceeds.
      if (list.fetchStatus === "idle") {
        return { status: "reachable", hostLabel: hostId };
      }
      return { status: "checking", hostLabel: hostId };
    }
    if (isUnknownHost(hostId)) {
      return { status: "reachable", hostLabel: hostId };
    }
    // An EMPTY directory means this machine's own host has not published
    // yet (boot, ensure/respawn in progress, post-wake re-probe) - the
    // directory only ever contains the local host today (remote discovery
    // is a stub). No bound host's fate is knowable in that state, so it is
    // "host-starting", never a per-tab death: the 2026-07-14 incident
    // rendered every chat as "Bound host is offline" + Clone CTA (and
    // terminals as "permanently closed") from exactly this window.
    if (list.data.length === 0) {
      return { status: "host-starting", hostLabel: hostId };
    }
    const entry = list.data.find((e) => e.hostId === hostId);
    if (entry === undefined) {
      return { status: "unreachable", hostLabel: hostId };
    }
    if (entry.kind === "remote") {
      return {
        status: "reachable",
        hostLabel: entry.label.length > 0 ? entry.label : hostId,
      };
    }
    const reachable = entry.status === "available";
    return {
      status: reachable ? "reachable" : "unreachable",
      hostLabel: entry.label.length > 0 ? entry.label : hostId,
    };
  }, [hostId, list.data, list.fetchStatus]);
}
