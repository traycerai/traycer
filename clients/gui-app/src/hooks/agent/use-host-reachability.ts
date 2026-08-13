import { useMemo } from "react";
import { isHostReachable } from "@traycer-clients/shared/host-client/host-directory";
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
 *
 * A host that is merely BUSY is reachable. See `HostAvailability`: `busy`
 * means the shell proved the process is alive and only a probe went
 * unanswered, and the entry keeps its real `websocketUrl` throughout, so
 * everything downstream of "reachable" (per-request dials, durable streams)
 * keeps working. Reading it as unreachable is what locked every chat on a
 * healthy machine read-only for two hours on 2026-08-11.
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
    // The same "not published yet" state as the empty-directory arm above,
    // wearing a different shape. When this machine's local snapshot is absent,
    // `HostDirectoryService.snapshot()` substitutes the registry's twin of this
    // machine as a LOCAL entry with `websocketUrl: null` and a hardcoded
    // `unavailable` - a row that exists purely to keep the id selectable while
    // the local provisioning lifecycle stays armed. Nothing else in the
    // directory produces that pair, and its `unavailable` is about DIALABILITY,
    // not about the host being dead.
    //
    // Reading it as a per-tab death is the 2026-08-11 incident's freshly-derived
    // half: the registry twin arrives from the cloud before the local snapshot
    // arrives from the shell, so on every relaunch there was a window - and,
    // while the host stayed busy, an unbounded one - where the directory was
    // NON-empty and the 2026-07-14 protection above therefore did not apply.
    // Same unknowable state, same answer.
    //
    // This cannot resurrect the 2026-08-08 failure it looks adjacent to. That
    // one was a tile dialing a corpse forever; this entry carries no
    // `websocketUrl`, so `dialableHostEndpoint` refuses it and there is nothing
    // to dial. The genuinely-dead LOCAL host reaches the user through the
    // readiness controller's provisioning/Retry card, which this row is
    // deliberately shaped to keep armed.
    if (entry.kind === "local" && entry.websocketUrl === null) {
      return {
        status: "host-starting",
        hostLabel: entry.label.length > 0 ? entry.label : hostId,
      };
    }
    // Remote entries answer from their directory STATUS, same as local ones.
    // This used to hardwire "reachable" for any remote entry, on the theory
    // that presence leases are My-Hosts evidence rather than tab-death proof.
    // The two-slot live check (2026-08-08) showed where that lie lands: an
    // UNAVAILABLE owner's rows carried no lock, the unified sidebar routed
    // them to a LIVE tab, and the tile dialed a dead host forever - an
    // eternal spinner instead of the locked published copy. A populated
    // directory explicitly marking a host unavailable is high-confidence
    // evidence, and every consumer of "unreachable" degrades recoverably
    // (lock badge and copy routing flip back on the next refresh; the
    // dead-tile banner is reactive, not a tab kill). The 2026-07-14
    // incident's protection is untouched: it lives in the EMPTY-directory
    // arm above ("host-starting"), never here.
    //
    // `busy` counts as reachable. The lock and the clone CTA follow from
    // "unreachable" alone, and a busy host is one this tab can still dial,
    // stream from, and write to - only its badge should soften.
    const reachable = isHostReachable(entry.status);
    return {
      status: reachable ? "reachable" : "unreachable",
      hostLabel: entry.label.length > 0 ? entry.label : hostId,
    };
  }, [hostId, list.data, list.fetchStatus]);
}
