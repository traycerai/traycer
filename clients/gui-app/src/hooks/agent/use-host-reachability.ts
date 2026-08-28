import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  hasReadyRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";
import {
  hostUnavailability,
  type HostUnavailability,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useLoadDeadline } from "@/hooks/host/use-load-deadline";
import { isUnknownHost } from "@/lib/host/constants";
import { HOST_STARTING_BUDGET_MS } from "@/lib/host/bounded-load-budgets";

export type HostReachabilityStatus =
  | "checking"
  | "reachable"
  | "unreachable"
  | "host-starting";

/**
 * What EVIDENCE produced this verdict.
 *
 * `directory` — the host directory resolved and answered. This is the strong
 * form, and the only one that may drive a destructive or persisted side
 * effect.
 *
 * `starting-deadline` — the host was starting and never finished within
 * `HOST_STARTING_BUDGET_MS`, so the tile stopped waiting (invariant 6). The
 * host may well be fine and merely slow; what expired is the UI's patience,
 * not the machine.
 *
 * The distinction exists because three surfaces fire
 * `emitTerminalClosedNotification` off `unreachable`, and that notification is
 * a PERSISTED claim that a session ended. A boot that overruns its budget must
 * be allowed to change what the tile SHOWS without also writing "Terminal
 * permanently closed" into the notification feed for a PTY that is still
 * running. Bounded loading owes the reader a terminal presentation; it does
 * not owe them a death event, and manufacturing one would re-create the
 * 2026-07-14 incident with a timer instead of an empty directory.
 */
export type HostReachabilityBasis = "directory" | "starting-deadline";

export interface HostReachability {
  readonly status: HostReachabilityStatus;
  readonly hostLabel: string;
  /**
   * Why, when `status` is `unreachable`. `plan-restricted` is not an outage —
   * a surface that renders "this host is offline" for it is wrong about the
   * machine AND about the remedy. `null` for every other status.
   */
  readonly unavailability: HostUnavailability | null;
  /** How strong the evidence behind `status` is. See `HostReachabilityBasis`. */
  readonly basis: HostReachabilityBasis;
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
 * "host-starting" is BOUNDED (invariant 6): after `HOST_STARTING_BUDGET_MS`
 * the verdict falls to "unreachable" so the tile reaches a terminal
 * presentation with its affordances instead of waiting forever. The fall
 * carries `basis: "starting-deadline"` - read it before driving anything
 * destructive off "unreachable".
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
  const directoryVerdict = useMemo<HostReachability>(() => {
    if (list.data === undefined) {
      // The directory query is disabled when no host binding exists
      // (e.g., test harnesses that do not mount the renderer's host
      // provider). With no source of truth we cannot gate the tile;
      // fall through to "reachable" so the live render path proceeds.
      if (list.fetchStatus === "idle") {
        return {
          status: "reachable",
          hostLabel: hostId,
          unavailability: null,
          basis: "directory",
        };
      }
      return {
        status: "checking",
        hostLabel: hostId,
        unavailability: null,
        basis: "directory",
      };
    }
    if (isUnknownHost(hostId)) {
      return {
        status: "reachable",
        hostLabel: hostId,
        unavailability: null,
        basis: "directory",
      };
    }
    // An EMPTY directory means this machine's own host has not published
    // yet (boot, ensure/respawn in progress, post-wake re-probe) AND no
    // remote fetch has resolved a registry twin for it either - remote
    // discovery is a real registry fetch now (`HostDirectoryService`'s
    // `remoteEntries`), not the stub this comment used to describe, so an
    // empty list is genuine "nothing known yet", not "local-only by
    // construction". No bound host's fate is knowable in that state, so it
    // is "host-starting", never a per-tab death: the 2026-07-14 incident
    // rendered every chat as "Bound host is offline" + Clone CTA (and
    // terminals as "permanently closed") from exactly this window.
    if (list.data.length === 0) {
      return {
        status: "host-starting",
        hostLabel: hostId,
        unavailability: null,
        basis: "directory",
      };
    }
    const entry = list.data.find((e) => e.hostId === hostId);
    if (entry === undefined) {
      return {
        status: "unreachable",
        hostLabel: hostId,
        unavailability: "offline",
        basis: "directory",
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
        basis: "directory",
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
      return {
        status: "reachable",
        hostLabel,
        unavailability: null,
        basis: "directory",
      };
    }
    // A live E2E session is firsthand proof the host is up, and it outranks a
    // cloud verdict reached minutes ago through a different leg. Without this
    // the directory could kill the surfaces of a host this client is actively
    // talking to.
    if (hasReadySession) {
      return {
        status: "reachable",
        hostLabel,
        unavailability: null,
        basis: "directory",
      };
    }
    if (unavailability === "indeterminate") {
      // The cloud could not read liveness. That is not evidence, and the cost
      // of guessing is asymmetric: guessing "dead" replaces a working chat
      // with a Clone offer and fires a terminal-closed notification, while
      // guessing "alive" costs a dial that fails recoverably. Fall through to
      // the live render path, exactly as the no-directory arm above does for
      // the same reason.
      return {
        status: "reachable",
        hostLabel,
        unavailability: null,
        basis: "directory",
      };
    }
    // `offline` and `plan-restricted` both mean this client cannot open a
    // session, which is what the tab-open gate exists to decide. They read
    // differently to a person, though, so the reason travels with the verdict
    // and the banners branch on it rather than all saying "offline".
    return {
      status: "unreachable",
      hostLabel,
      unavailability,
      basis: "directory",
    };
  }, [hostId, list.data, list.fetchStatus, hasReadySession]);

  // F4/S2. `host-starting` was the one arm with no way out: the directory
  // cannot distinguish "this machine's host is three seconds from publishing"
  // from "it is never going to", and it answered the optimistic one FOREVER.
  // A chat bound to a host that never came back therefore sat behind
  // "Waiting for the host to start…" with its Clone offer withheld - the
  // affordance that would have let the user carry on was gated on the very
  // state that never ended.
  //
  // So the wait is bounded and the verdict falls to `unreachable`, which every
  // consumer already handles with its own affordances (Clone for chats, Close
  // for terminals, the informational banners elsewhere). Clone becomes
  // available AT the deadline rather than never.
  //
  // `basis` carries how we got here, and it is load-bearing rather than
  // decorative: the presentation falls, but a deadline is not proof of death,
  // so the persisted "Terminal permanently closed" notification stays gated on
  // directory evidence. See `HostReachabilityBasis`.
  const startingBudgetElapsed = useLoadDeadline(
    directoryVerdict.status === "host-starting" ? hostId : null,
    HOST_STARTING_BUDGET_MS,
  );

  return useMemo<HostReachability>(() => {
    if (!startingBudgetElapsed) return directoryVerdict;
    // Re-checked rather than assumed: the deadline's own key clears when the
    // status leaves `host-starting`, but reading the CURRENT verdict here is
    // what makes that a belt-and-braces invariant instead of a timing bet.
    if (directoryVerdict.status !== "host-starting") return directoryVerdict;
    return {
      status: "unreachable",
      hostLabel: directoryVerdict.hostLabel,
      // `offline` is the retryable reason, and it is the honest one: the host
      // did not come up. It is deliberately NOT `plan-restricted` (an
      // entitlement verdict this arm has no evidence for) - the two read
      // differently to a person and name different remedies.
      unavailability: "offline",
      basis: "starting-deadline",
    };
  }, [directoryVerdict, startingBudgetElapsed]);
}

/**
 * The label a surface may NAME this host by, or `null` while the directory
 * has not resolved one.
 *
 * `hostLabel` falls back to the raw `hostId` so callers always have a string,
 * which is right for keys and diagnostics and wrong for copy: while the
 * directory is still `checking` that fallback is a uuid, and "Waiting for
 * 8f3c-…-a19 to start" is not a sentence to show a person. One rule, encoded
 * once, rather than each of the six tile families inventing its own fallback
 * phrase.
 */
export function resolvedHostLabel(
  reachability: HostReachability,
): string | null {
  return reachability.status === "checking" ? null : reachability.hostLabel;
}

/**
 * Reactive view of `hasReadyRemoteSession(hostId)`.
 *
 * A readiness flip changes NO directory value (a fuse-recovery dial
 * succeeding leaves the registry row `offline` for up to the lease TTL), so
 * reading it inside the directory-keyed memo above froze the answer: a
 * surface stayed "unreachable" while a working session was open, and could
 * stay "reachable" after the session died, until some unrelated directory
 * emit happened by.
 *
 * The subscription used to be a 1s poll, because the session cache was a
 * pull-only module map with nothing to subscribe to. It pushes now
 * (redesign P4.1): `subscribeRemoteSessionReadiness` fires on ready
 * boundaries, closes, supersession and linger expiry - every transition that
 * can change this answer - so the timer is gone and the answer is if
 * anything fresher, since a ready boundary no longer waits out a tick.
 *
 * Exported for every surface whose render reads session readiness: any
 * component that calls `hasReadyRemoteSession` (directly or through a
 * host-selection predicate without subscribing here has the
 * same frozen-answer bug this hook was written for.
 */
export function useRemoteSessionPollReadiness(hostId: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeRemoteSessionReadiness(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(
    () => hasReadyRemoteSession(hostId),
    [hostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
