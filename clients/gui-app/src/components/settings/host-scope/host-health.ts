import type {
  HostListItem,
  HostPresenceHealth,
} from "@traycer/protocol/host/host-status";
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
 * never met: the registry-backed presence words ("Online", "Up,
 * re-establishing its tunnel", "Not reporting — likely reachable", "Status
 * unknown", "Offline") and the local service words ("Running", "Stopped",
 * "Not installed"). The SAME machine — your own — was rendered with both, in
 * two different cards, and a reader had no way to know they described one
 * thing. That is the defect this type closes.
 *
 * The split is now by MEANING rather than by data source:
 *
 *   - `state` is the coarse thing a person acts on. There are seven, and
 *     they are mutually exclusive.
 *   - `detail` carries the honest nuance the old design spent a row of pills
 *     on ("re-establishing its tunnel", "last seen 3h ago"). It is a sentence
 *     fragment, never a status word competing with `state`.
 *
 * Two states are LOCAL-ONLY (`stopped`, `not-installed`): only a machine this
 * client can manage can be in them, and both are actionable rather than merely
 * informational — which is exactly why they must not be flattened into
 * "Offline". A remote host that is off simply reads `offline`.
 */
export type HostHealthState =
  | "online"
  | "reconnecting"
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
   * `deriveHostPresence`'s first invariant: no green dot without a fresh lease
   * or an open session, ever.
   */
  readonly live: boolean;
  /** Agent work in flight. Meaningful only while `online`. */
  readonly busy: boolean;
}

export const HOST_HEALTH_TONE: Record<HostHealthState, HostHealthTone> = {
  online: "live",
  reconnecting: "warn",
  unknown: "warn",
  offline: "idle",
  stopped: "warn",
  "not-installed": "idle",
  "viewer-offline": "idle",
};

export interface DeriveHostHealthOptions {
  /** Registry row, or `null` for a host the registry has not listed. */
  readonly item: HostListItem | null;
  readonly presenceHealth: HostPresenceHealth;
  readonly isLocalMachine: boolean;
  readonly hasLiveSession: boolean;
  readonly viewerCheck: ViewerReachabilityCheckLike | null;
  /**
   * The local service snapshot, for THIS machine only. It outranks the
   * registry lease for a local host: the lease is hearsay about a heartbeat
   * that reached the cloud, while this is a direct read of the process on
   * this box. It is also the only source that can distinguish "installed but
   * not running" from "not installed" — a distinction the lease erases into a
   * single expired lease, and the one that decides whether we can offer Start
   * or must offer Install.
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
      busy: false,
    };
  }
  if (service.state === "stopped") {
    return {
      state: "stopped",
      label: "Stopped",
      detail: "Installed, but the host process isn't running.",
      tone: HOST_HEALTH_TONE.stopped,
      live: false,
      busy: false,
    };
  }
  // Running. The process is right here, so this is firsthand and outranks
  // every cloud-derived signal — but `busy` is still the registry's to report,
  // since the local snapshot says nothing about agent turns.
  return {
    state: "online",
    label: "Online",
    detail: "Running on this computer.",
    tone: HOST_HEALTH_TONE.online,
    live: true,
    busy: options.item?.status.busy ?? false,
  };
}

function registryHealth(options: DeriveHostHealthOptions): HostHealth {
  const { item, presenceHealth, isLocalMachine, hasLiveSession, nowMs } =
    options;
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
      busy: false,
    };
  }
  const presence = deriveHostPresence({
    status: item.status,
    presenceHealth,
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
        busy: presence.busy,
      };
    case "connection-issue":
      return {
        state: "reconnecting",
        label: "Connection issue",
        // `deriveHostPresence` folds the "checked Xm ago" stamp into its own
        // label; keep it, as a detail rather than a competing status word.
        detail: stripLeadingClause(presence.label),
        tone: HOST_HEALTH_TONE.reconnecting,
        live: presence.showLiveDot,
        busy: presence.busy,
      };
    case "tunnel-down":
      return {
        state: "reconnecting",
        label: "Reconnecting",
        detail: "Up, but re-establishing its tunnel.",
        tone: HOST_HEALTH_TONE.reconnecting,
        live: false,
        busy: false,
      };
    case "likely-reachable":
      return {
        state: "unknown",
        label: "Not reporting",
        detail: "Its tunnel is up, so it's likely still reachable.",
        tone: HOST_HEALTH_TONE.unknown,
        live: false,
        busy: false,
      };
    case "unknown":
      return {
        state: "unknown",
        label: "Status unknown",
        detail: "Live status is degraded right now — this may be stale.",
        tone: HOST_HEALTH_TONE.unknown,
        live: false,
        busy: false,
      };
    case "client-offline":
      return {
        state: "viewer-offline",
        label: "You're offline",
        detail: "Reconnect to see this host's status.",
        tone: HOST_HEALTH_TONE["viewer-offline"],
        live: false,
        busy: false,
      };
    case "offline":
      return {
        state: "offline",
        label: "Offline",
        detail: capitalize(formatLastSeen(item.status.lastSeenAt, nowMs)),
        tone: HOST_HEALTH_TONE.offline,
        live: false,
        busy: false,
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
