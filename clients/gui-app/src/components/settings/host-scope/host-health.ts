import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  deriveHostPresence,
  formatLastSeen,
  type ViewerReachabilityCheckLike,
} from "@/components/settings/panels/my-hosts-model";

/**
 * ONE health vocabulary for every host, everywhere.
 *
 * Before this, a host could be described by two disjoint vocabularies that
 * never met: the registry-backed presence words ("Online", "Status unknown",
 * "Offline") and the local service words ("Running", "Stopped", "Not
 * installed"). The SAME machine — your own — was rendered with both, in two
 * different cards, and a reader had no way to know they described one thing.
 * That is the defect this type closes.
 *
 * The split is now by MEANING rather than by data source:
 *
 *   - `state` is the coarse thing a person acts on. There are eight, and
 *     they are mutually exclusive.
 *   - `detail` carries the honest nuance the old design spent a row of pills
 *     on ("last seen 3h ago"). It is a sentence fragment, never a status word
 *     competing with `state`.
 *
 * `stopped` and `not-installed` are THIS-MACHINE-ONLY: only a machine this
 * client can manage can be in them, and both are actionable rather than merely
 * informational — which is exactly why they must not be flattened into
 * "Offline". A remote host that is off simply reads `offline`.
 *
 * `local-only` is a different thing wearing a similar word, and the two must
 * not be conflated. It is not about which machine is doing the reading: it is
 * the account's plan saying this host will never be reachable remotely, which
 * is why it carries an upgrade as its remedy where `stopped` carries a Start
 * button. Any host — including a remote one on someone else's desk — can be
 * `local-only`.
 */
export type HostHealthState =
  | "online"
  | "connection-issue"
  | "local-only"
  | "unknown"
  | "offline"
  | "stopped"
  | "not-installed"
  | "viewer-offline";

export type HostHealthTone = "live" | "warn" | "idle";

export interface HostHealth {
  readonly state: HostHealthState;
  /** Short status word. Never repeats `detail`. */
  readonly label: string;
  /** The nuance — a fragment, or `null` when the label already says it all. */
  readonly detail: string | null;
  readonly tone: HostHealthTone;
  /**
   * A live dot renders ONLY when live evidence backs it. Carried forward from
   * `deriveHostPresence`'s first invariant: no green dot without a live
   * attachment or an open session, ever.
   */
  readonly live: boolean;
}

export const HOST_HEALTH_TONE: Record<HostHealthState, HostHealthTone> = {
  online: "live",
  "connection-issue": "warn",
  // Not a fault, so not a warning: the host is exactly as reachable as the
  // plan says it should be. `idle` keeps it visually alongside a host that is
  // simply not running rather than alongside one that is failing.
  "local-only": "idle",
  unknown: "warn",
  offline: "idle",
  stopped: "warn",
  "not-installed": "idle",
  "viewer-offline": "idle",
};

export interface DeriveHostHealthOptions {
  /** Registry row, or `null` for a host the registry has not listed. */
  readonly item: HostListItem | null;
  readonly isLocalMachine: boolean;
  readonly hasLiveSession: boolean;
  readonly viewerCheck: ViewerReachabilityCheckLike | null;
  /**
   * The local service snapshot, for THIS machine only. It outranks every
   * cloud-derived signal for a local host — `connectivity` describes whether
   * the host reached a relay, while this is a direct read of the process on
   * this box. It is also the only source that can distinguish "installed but
   * not running" from "not installed" — a distinction the cloud erases into a
   * single `offline`, and the one that decides whether we can offer Start or
   * must offer Install.
   *
   * This is step 1 of the derivation precedence; `deriveHostPresence`'s
   * doc-comment carries the rest.
   */
  readonly service: ServiceStatusSnapshot | undefined;
  readonly nowMs: number;
}

export function deriveHostHealth(options: DeriveHostHealthOptions): HostHealth {
  const local = localServiceHealth(options);
  if (local !== null) return local;
  return registryHealth(options);
}

/**
 * The local machine's health, or `null` when this is not the local machine (or
 * its service snapshot has not resolved yet, in which case the registry answer
 * is still better than nothing).
 */
function localServiceHealth(
  options: DeriveHostHealthOptions,
): HostHealth | null {
  const { isLocalMachine, service } = options;
  if (!isLocalMachine || service === undefined) return null;
  if (service.state === "not-installed") {
    return {
      state: "not-installed",
      label: "Not installed",
      detail: "No Traycer host is installed on this computer yet.",
      tone: HOST_HEALTH_TONE["not-installed"],
      live: false,
    };
  }
  if (service.state === "stopped") {
    return {
      state: "stopped",
      label: "Stopped",
      detail: "Installed, but the host process isn't running.",
      tone: HOST_HEALTH_TONE.stopped,
      live: false,
    };
  }
  // Running. The process is right here, so this is firsthand and outranks every
  // cloud-derived signal.
  return {
    state: "online",
    label: "Online",
    detail: "Running on this computer.",
    tone: HOST_HEALTH_TONE.online,
    live: true,
  };
}

function registryHealth(options: DeriveHostHealthOptions): HostHealth {
  const { item, isLocalMachine, hasLiveSession, nowMs } = options;
  if (item === null) {
    // In the runtime directory but not the cloud registry: we can reach it,
    // yet nothing vouches for its liveness. Claiming either Online or Offline
    // would be an invention.
    return {
      state: "unknown",
      label: "Status unknown",
      detail: "This host hasn't reported to your account yet.",
      tone: HOST_HEALTH_TONE.unknown,
      live: false,
    };
  }
  const presence = deriveHostPresence({
    status: item.status,
    isViewerLocalHost: isLocalMachine,
    hasLiveSession,
    viewerCheck: options.viewerCheck,
    nowMs,
  });
  switch (presence.tone) {
    case "online":
      return {
        state: "online",
        label: "Online",
        detail: null,
        tone: HOST_HEALTH_TONE.online,
        live: presence.showLiveDot,
      };
    case "connection-issue":
      return {
        state: "connection-issue",
        label: "Connection issue",
        // `deriveHostPresence` folds the "checked Xm ago" stamp into its own
        // label; keep it, as a detail rather than a competing status word.
        detail: stripLeadingClause(presence.label),
        tone: HOST_HEALTH_TONE["connection-issue"],
        live: presence.showLiveDot,
      };
    case "local-only":
      return {
        state: "local-only",
        label: "Local only",
        // The copy has to depend on WHOSE machine this is, because the claim
        // "reachable from this computer" is only true for one of them.
        //
        // It said that unconditionally, and for a remote row it was a
        // fabrication twice over: the machine is somewhere else, and the plan
        // is the reason no route to it exists. A free-tier user inspecting
        // their other laptop was told it was reachable right here.
        //
        // Both arms state the remedy — an upgrade — because that is the one
        // thing a person can act on, and it is what the generic
        // connection-failure copy downstream used to replace with a retry.
        detail: isLocalMachine
          ? "Reachable on this computer. Remote access needs a paid plan."
          : "Not reachable from here — remote access needs a paid plan.",
        tone: HOST_HEALTH_TONE["local-only"],
        live: false,
      };
    case "unknown":
      return {
        state: "unknown",
        label: "Status unknown",
        detail: "Live status is unavailable right now — this may be stale.",
        tone: HOST_HEALTH_TONE.unknown,
        live: false,
      };
    case "client-offline":
      return {
        state: "viewer-offline",
        label: "You're offline",
        detail: "Reconnect to see this host's status.",
        tone: HOST_HEALTH_TONE["viewer-offline"],
        live: false,
      };
    case "offline":
      return {
        state: "offline",
        label: "Offline",
        detail: capitalize(formatLastSeen(item.status.lastSeenAt, nowMs)),
        tone: HOST_HEALTH_TONE.offline,
        live: false,
      };
  }
}

/**
 * `deriveHostPresence` returns "Reachable, connection issue (checked 2m ago)".
 * The status word is now the label, so the detail keeps only what follows it.
 */
function stripLeadingClause(label: string): string {
  const open = label.indexOf("(");
  const close = label.lastIndexOf(")");
  if (open === -1 || close <= open) return label;
  const inner = label.slice(open + 1, close).trim();
  return inner.length === 0 ? label : capitalizeString(inner);
}

function capitalize(value: string | null): string | null {
  if (value === null) return null;
  return capitalizeString(value);
}

function capitalizeString(value: string): string {
  if (value.length === 0) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
