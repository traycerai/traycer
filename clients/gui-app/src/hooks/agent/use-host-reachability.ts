import { useCallback, useMemo, useSyncExternalStore } from "react";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import {
  hostUnavailability,
  type HostUnavailability,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { isUnknownHost } from "@/lib/host/constants";

export type HostReachabilityStatus =
  "checking" | "reachable" | "unreachable" | "host-starting";

export interface HostReachability {
  readonly status: HostReachabilityStatus;
  readonly hostLabel: string;
  /**
   * Why, when `status` is `unreachable`. `plan-restricted` is not an outage —
   * a surface that renders "this host is offline" for it is wrong about the
   * machine AND about the remedy. `null` for every other status.
   */
  readonly unavailability: HostUnavailability | null;
}

/**
 * Reachability check for a tile's bound host.
 *
 * Per CLAUDE.md tabs are bound to a host for life. This hook is only a
 * directory-membership gate for renderers that need to know whether the bound
 * host still exists. It is NOT a remote reachability probe and must never write
 * viewer-reachability provenance; the cloud's `connectivity` verdict is status
 * evidence for the host list, not proof that an already-bound tab is
 * permanently dead.
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
  const hasReadySession = useRemoteSessionPollReadiness(hostId);
  return useMemo<HostReachability>(() => {
    if (list.data === undefined) {
      // The directory query is disabled when no host binding exists
      // (e.g., test harnesses that do not mount the renderer's host
      // provider). With no source of truth we cannot gate the tile;
      // fall through to "reachable" so the live render path proceeds.
      if (list.fetchStatus === "idle") {
        return { status: "reachable", hostLabel: hostId, unavailability: null };
      }
      return { status: "checking", hostLabel: hostId, unavailability: null };
    }
    if (isUnknownHost(hostId)) {
      return { status: "reachable", hostLabel: hostId, unavailability: null };
    }
    // An EMPTY directory means this machine's own host has not published
    // yet (boot, ensure/respawn in progress, post-wake re-probe) - the
    // directory only ever contains the local host today (remote discovery
    // is a stub). No bound host's fate is knowable in that state, so it is
    // "host-starting", never a per-tab death: the 2026-07-14 incident
    // rendered every chat as "Bound host is offline" + Clone CTA (and
    // terminals as "permanently closed") from exactly this window.
    if (list.data.length === 0) {
      return {
        status: "host-starting",
        hostLabel: hostId,
        unavailability: null,
      };
    }
    const entry = list.data.find((e) => e.hostId === hostId);
    if (entry === undefined) {
      return {
        status: "unreachable",
        hostLabel: hostId,
        unavailability: "offline",
      };
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
        unavailability: null,
      };
    }
    // Remote entries answer from their directory status, same as local ones.
    // This used to hardwire "reachable" for any remote entry, on the theory
    // that presence leases are My-Hosts evidence rather than tab-death proof.
    // The two-slot live check (2026-08-08) showed where that lie lands: an
    // UNAVAILABLE owner's rows carried no lock, the unified sidebar routed
    // them to a LIVE tab, and the tile dialed a dead host forever - an
    // eternal spinner instead of the locked published copy. The 2026-07-14
    // incident's protection is untouched: it lives in the EMPTY-directory
    // arm above ("host-starting"), never here.
    //
    // A `busy` host is still reachable here, and stays reachable through the
    // reason: the shell publishes it as dialable, so `hostUnavailability`
    // answers `null` and only the badge softens. The lock and the clone CTA
    // follow from "unreachable" alone.
    //
    // But "not dialable" is not one fact, and this hook is what turns it into
    // a dead tile — a banner, and for terminals a "permanently closed"
    // notification. So it gates on the REASON, and only the reason that is
    // actually evidence about the host.
    const hostLabel = entry.label.length > 0 ? entry.label : hostId;
    const unavailability = hostUnavailability(entry);
    if (unavailability === null) {
      return { status: "reachable", hostLabel, unavailability: null };
    }
    // A live E2E session is firsthand proof the host is up, and it outranks a
    // cloud verdict reached minutes ago through a different leg. Without this
    // the directory could kill the surfaces of a host this client is actively
    // talking to.
    if (hasReadySession) {
      return { status: "reachable", hostLabel, unavailability: null };
    }
    if (unavailability === "indeterminate") {
      // The cloud could not read liveness. That is not evidence, and the cost
      // of guessing is asymmetric: guessing "dead" replaces a working chat
      // with a Clone offer and fires a terminal-closed notification, while
      // guessing "alive" costs a dial that fails recoverably. Fall through to
      // the live render path, exactly as the no-directory arm above does for
      // the same reason.
      return { status: "reachable", hostLabel, unavailability: null };
    }
    // `offline` and `plan-restricted` both mean this client cannot open a
    // session, which is what the tab-open gate exists to decide. They read
    // differently to a person, though, so the reason travels with the verdict
    // and the banners branch on it rather than all saying "offline".
    return { status: "unreachable", hostLabel, unavailability };
  }, [hostId, list.data, list.fetchStatus, hasReadySession]);
}

/**
 * How often the ready-session evidence is re-read. Session readiness settles
 * within seconds of a dial (`isConfirmedTransportRefusal`'s contract), so a
 * one-second bound keeps the dead surface honest without meaningful cost -
 * the poll is a scan of the small in-memory session cache, and a tick whose
 * value is unchanged re-renders nothing (`useSyncExternalStore` compares
 * snapshots).
 */
const REMOTE_SESSION_READINESS_POLL_MS = 1_000;

/**
 * Reactive view of `hasReadyRemoteSession(hostId)`.
 *
 * The session cache is a pull-only module map - nothing pushes an event when
 * a session becomes ready or dies - and a readiness flip changes NO directory
 * value (a fuse-recovery dial succeeding leaves the registry row `offline`
 * for up to the lease TTL). Reading it inside the directory-keyed memo above
 * therefore froze the answer: a surface stayed "unreachable" while a working
 * session was open, and could stay "reachable" after the session died, until
 * some unrelated directory emit happened by. With no store to subscribe to,
 * the subscription is a bounded poll; `useSyncExternalStore` turns it into a
 * proper snapshot the memo can key on.
 *
 * Exported for every surface whose render reads session readiness: any
 * component that calls `hasReadyRemoteSession` (directly or through a
 * predicate like `hostSelectRowRefused`) without subscribing here has the
 * same frozen-answer bug this hook was written for.
 */
export function useRemoteSessionPollReadiness(hostId: string): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const timer = setInterval(onStoreChange, REMOTE_SESSION_READINESS_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const getSnapshot = useCallback(
    () => hasReadyRemoteSession(hostId),
    [hostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
