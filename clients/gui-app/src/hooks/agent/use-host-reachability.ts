import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  hasReadyRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";
import {
  hostUnavailability,
  type HostUnavailability,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostKind } from "@traycer-clients/shared/host-client/host-directory";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useLoadDeadline } from "@/hooks/host/use-load-deadline";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { isUnknownHost } from "@/lib/host/constants";
import { HOST_STARTING_BUDGET_MS } from "@/lib/host/bounded-load-budgets";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";

function isPlanRestrictedLease(lease: HostLeaseSnapshot | null): boolean {
  return lease?.status === "dead" && lease.dead.reason === "plan-restricted";
}

export type HostReachabilityStatus =
  | "checking"
  | "reachable"
  | "unreachable"
  | "host-starting";

/** directory may drive a persisted side effect. starting-deadline is a UI wait, not a death event. */
export type HostReachabilityBasis = "directory" | "starting-deadline";

/** unknown is a real third answer. Reuse directory HostKind; do not map mock onto local. */
export type HostReachabilityHostKind = HostKind | "unknown";

export interface HostReachability {
  readonly status: HostReachabilityStatus;
  readonly hostLabel: string;
  /** `plan-restricted` is not an outage - a surface that renders "this host is offline" for it is wrong about the machine AND about the remedy. */
  readonly unavailability: HostUnavailability | null;
  /** How strong the evidence behind `status` is. See `HostReachabilityBasis`. */
  readonly basis: HostReachabilityBasis;
  /** Whose machine the bound host is. See `HostReachabilityHostKind`. */
  readonly hostKind: HostReachabilityHostKind;
}

/** Not a remote probe. */
export function useHostReachability(hostId: string): HostReachability {
  const lease = useHostLease(hostId);
  const list = useHostDirectoryList();
  const hasReadySession = useRemoteSessionPollReadiness(hostId);
  const directoryVerdict = useMemo<HostReachability>(() => {
    if (list.data === undefined) {
      // The directory query is disabled when no host binding exists (e.g., test harnesses that do not mount the renderer's host provider).
      // With no source of truth we cannot gate the tile; fall through to "reachable" so the live render path proceeds.
      if (list.fetchStatus === "idle") {
        return {
          status: "reachable",
          hostLabel: hostId,
          unavailability: null,
          basis: "directory",
          hostKind: "unknown",
        };
      }
      return {
        status: "checking",
        hostLabel: hostId,
        unavailability: null,
        basis: "directory",
        hostKind: "unknown",
      };
    }
    if (isUnknownHost(hostId)) {
      return {
        status: "reachable",
        hostLabel: hostId,
        unavailability: null,
        basis: "directory",
        hostKind: "unknown",
      };
    }
    // Empty directory is host-starting, never a per-tab death.
    if (list.data.length === 0) {
      return {
        status: "host-starting",
        hostLabel: hostId,
        unavailability: null,
        basis: "directory",
        hostKind: "unknown",
      };
    }
    const entry = list.data.find((e) => e.hostId === hostId);
    if (entry === undefined) {
      // A bound host the directory does not list at all: a machine that left the account, or a past identity's.
      // `unknown` rather than `remote` - there is no entry to read a kind off, and inferring one from "it is not the local host" would be a guess dressed as a fact.
      return {
        status: "unreachable",
        hostLabel: hostId,
        unavailability: "offline",
        basis: "directory",
        hostKind: "unknown",
      };
    }
    // Registry twin with websocketUrl null + unavailable is "not published yet", not a dead local host.
    if (entry.kind === "local" && entry.websocketUrl === null) {
      return {
        status: "host-starting",
        hostLabel: entry.label.length > 0 ? entry.label : hostId,
        unavailability: null,
        basis: "directory",
        hostKind: "local",
      };
    }
    // Remote entries use directory status, not hardwired reachable. busy is still reachable. Gate death on the unavailability reason.
    const hostLabel = entry.label.length > 0 ? entry.label : hostId;
    const hostKind = entry.kind;
    if (!hasReadySession && isPlanRestrictedLease(lease)) {
      return {
        status: "unreachable",
        hostLabel,
        unavailability: "plan-restricted",
        basis: "directory",
        hostKind,
      };
    }
    const unavailability = hostUnavailability(entry);
    if (unavailability === null) {
      return {
        status: "reachable",
        hostLabel,
        unavailability: null,
        basis: "directory",
        hostKind,
      };
    }
    // Without this the directory could kill the surfaces of a host this client is actively talking to.
    if (hasReadySession) {
      return {
        status: "reachable",
        hostLabel,
        unavailability: null,
        basis: "directory",
        hostKind,
      };
    }
    if (unavailability === "indeterminate") {
      // The cloud could not read liveness.
      return {
        status: "reachable",
        hostLabel,
        unavailability: null,
        basis: "directory",
        hostKind,
      };
    }
    // `offline` and `plan-restricted` both mean this client cannot open a session, which is what the tab-open gate exists to decide.
    // They read differently to a person, though, so the reason travels with the verdict and the banners branch on it rather than all saying "offline".
    return {
      status: "unreachable",
      hostLabel,
      unavailability,
      basis: "directory",
      hostKind,
    };
  }, [hostId, list.data, list.fetchStatus, hasReadySession, lease]);

  // Bound host-starting; then unreachable. A deadline is not directory evidence of death.
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
      // It is deliberately NOT `plan-restricted` (an entitlement verdict this arm has no evidence for) - the two read differently to a person and name different remedies.
      unavailability: "offline",
      basis: "starting-deadline",
      // Carried through unchanged: whose machine this is does not change
      // because our patience ran out.
      hostKind: directoryVerdict.hostKind,
    };
  }, [directoryVerdict, startingBudgetElapsed]);
}

/** null while the directory has no label. Do not fall back to hostId in copy. */
export function resolvedHostLabel(
  reachability: HostReachability,
): string | null {
  return reachability.status === "checking" ? null : reachability.hostLabel;
}

/** Subscribe to remote-session readiness; a directory memo will not see a fuse-recovery dial succeed. */
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
