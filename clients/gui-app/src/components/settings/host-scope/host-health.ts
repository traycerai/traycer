import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type {
  HostLeaseDeadState,
  HostLeaseSnapshot,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  deriveHostPresence,
  formatLastSeen,
} from "@/components/settings/panels/my-hosts-model";

/** `stopped` and `not-installed` are this-machine-only: only a machine this client can manage can be in them,
 * and both are actionable rather than merely informational. */
export type HostHealthState =
  | "online"
  | "reported-reachable"
  | "restarting"
  | "local-only"
  | "unknown"
  | "offline"
  | "update-required"
  | "removed"
  | "stopped"
  | "not-installed"
  | "viewer-offline";

export type HostHealthTone = "live" | "warn" | "idle";

export interface HostHealth {
  readonly state: HostHealthState;
  /** Short status word. Never repeats `detail`. */
  readonly label: string;
  /** The nuance - a fragment, or `null` when the label already says it all. */
  readonly detail: string | null;
  readonly tone: HostHealthTone;
  /** Never a cloud lease: that clause is what made the same invariant vacuous where it was first written
   * (`deriveHostPresence`). */
  readonly live: boolean;
}

export const HOST_HEALTH_TONE: Record<HostHealthState, HostHealthTone> = {
  online: "live",
  // Not a fault and not a claim: nothing has reached this machine from here,
  // so it gets the same muted treatment as a host that is simply not running.
  "reported-reachable": "idle",
  // A restart we asked for or expect is not a failure in progress.
  restarting: "idle",
  // Not a fault, so not a warning: the host is exactly as reachable as the plan says it should be. `idle` keeps
  // it visually alongside a host that is simply not running rather than alongside one that is failing.
  "local-only": "idle",
  unknown: "warn",
  offline: "idle",
  // Actionable, like `stopped`: something a person can fix, and the row offers
  // the fix where it is a fix this app can perform.
  "update-required": "warn",
  // Terminal but not broken - the same "it is simply not here" class as `offline`, and a warning colour would
  // imply a repair that does not exist.
  removed: "idle",
  stopped: "warn",
  "not-installed": "idle",
  "viewer-offline": "idle",
};

export interface DeriveHostHealthOptions {
  readonly item: HostListItem | null;
  readonly isLocalMachine: boolean;
  readonly hasLiveSession: boolean;
  /** It is also the only source that can distinguish "installed but not running" from "not installed". */
  readonly service: ServiceStatusSnapshot | undefined;
  /** Both mean "no verdict yet", which is a different fact from "the verdict is bad" and must fall through to the
   * weaker evidence below rather than terminate the derivation. */
  readonly lease: HostLeaseSnapshot | null;
  /** Without it a `null` lease is ambiguous in exactly the way that matters. */
  readonly authorityAttached: boolean;
  /** Legacy projection input; production always allows remote connectivity. */
  readonly planAllowsRemote: boolean;
  readonly nowMs: number;
}

/** Precedence, and each step's claim to outrank the next: 1. This is the app's own experience of the host, and
 * it is why a host can read `Offline` here while the cloud still holds a `connectable` lease for it. */
export function deriveHostHealth(options: DeriveHostHealthOptions): HostHealth {
  const local = localServiceHealth(options);
  if (local !== null) return local;
  const lease = leaseHealth(options);
  if (lease !== null) return lease;
  return registryHealth(options);
}

/** The local machine's health, or `null` when this is not the local machine (or its service snapshot has not
 * resolved yet, in which case the weaker answers are still better than nothing). */
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
  // Incompatibility is not a liveness claim: the process is running and this app cannot speak to it, and reading
  // that as "Online" hides the one affordance that fixes it (the update action gates on `update-required`.
  const { lease, authorityAttached } = options;
  if (
    authorityAttached &&
    lease !== null &&
    lease.status === "dead" &&
    lease.dead.reason === "incompatible"
  ) {
    return null;
  }
  return {
    state: "online",
    label: "Online",
    detail: "Running on this computer.",
    tone: HOST_HEALTH_TONE.online,
    live: true,
  };
}

interface DeadHealthContext {
  readonly item: HostListItem | null;
  readonly isLocalMachine: boolean;
  readonly nowMs: number;
}

/** A fifth dead reason added to `HostLeaseDeadState` fails to compile here, naming its missing key, rather than
 * arriving at runtime and routing silently to whichever arm a `default` happened to point at. */
const DEAD_HEALTH: Record<
  HostLeaseDeadState["reason"],
  (context: DeadHealthContext) => HostHealth
> = {
  offline: (context) => ({
    state: "offline",
    label: "Offline",
    detail: capitalize(
      formatLastSeen(context.item?.status.lastSeenAt ?? null, context.nowMs),
    ),
    tone: HOST_HEALTH_TONE.offline,
    live: false,
  }),
  "plan-restricted": (context) => ({
    state: "local-only",
    label: "Local only",
    // The copy has to depend on whose machine this is, because the claim "reachable from this computer" is only
    // true for one of them.
    detail: context.isLocalMachine
      ? "Reachable on this computer. Remote access needs a paid plan."
      : "Not reachable from here — remote access needs a paid plan.",
    tone: HOST_HEALTH_TONE["local-only"],
    live: false,
  }),
  removed: () => ({
    state: "removed",
    label: "Removed",
    detail: "This host was removed from your account.",
    tone: HOST_HEALTH_TONE.removed,
    live: false,
  }),
  incompatible: () => ({
    state: "update-required",
    label: "Update required",
    // The versions themselves are deliberately not here.
    detail: "This host is running an older version than this app supports.",
    tone: HOST_HEALTH_TONE["update-required"],
    live: false,
  }),
};

/** `degraded` is the opposite case and is deliberately not a fall-through: it is a live serving state (the
 * lease is usable), so it renders as Online with the impairment as nuance rather than demoting the host. */
function leaseHealth(options: DeriveHostHealthOptions): HostHealth | null {
  const { lease, authorityAttached } = options;
  if (!authorityAttached || lease === null) return null;
  switch (lease.status) {
    case "connecting":
      return null;
    case "ready":
      return {
        state: "online",
        label: "Online",
        detail: null,
        tone: HOST_HEALTH_TONE.online,
        live: true,
      };
    case "degraded":
      return {
        state: "online",
        label: "Online",
        detail: "Connection is unstable.",
        tone: HOST_HEALTH_TONE.online,
        live: true,
      };
    case "restarting-expected":
      return {
        state: "restarting",
        label: "Restarting…",
        detail: "Expected restart — reconnecting.",
        tone: HOST_HEALTH_TONE.restarting,
        live: false,
      };
    case "dead":
      return DEAD_HEALTH[lease.dead.reason]({
        item: options.item,
        isLocalMachine: options.isLocalMachine,
        nowMs: options.nowMs,
      });
  }
}

/** Reached only when the two firsthand steps above declined. */
function registryHealth(options: DeriveHostHealthOptions): HostHealth {
  const { item, isLocalMachine, hasLiveSession, nowMs } = options;
  if (item === null) {
    // In the runtime directory but not the cloud registry, and no lease: we can reach it, yet nothing vouches for
    // its liveness. Claiming either Online or Offline would be an invention.
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
    hasLiveSession,
    planAllowsRemote: options.planAllowsRemote,
    nowMs,
  });
  switch (presence.reading) {
    case "online":
      // Reached only through the live-session override, which is firsthand.
      return {
        state: "online",
        label: "Online",
        detail: null,
        tone: HOST_HEALTH_TONE.online,
        live: presence.showLiveDot,
      };
    case "reported-reachable":
      // The account heard from this host within the lease ttl and nothing here has spoken to it, so the row says
      // what is true - that the report exists - instead of asserting a liveness no layer in this app has observed.
      return {
        state: "reported-reachable",
        label: "Reported reachable",
        detail:
          "Your account last heard from this host. Nothing has connected to it from here yet.",
        tone: HOST_HEALTH_TONE["reported-reachable"],
        live: false,
      };
    case "local-only":
      return DEAD_HEALTH["plan-restricted"]({ item, isLocalMachine, nowMs });
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
      return DEAD_HEALTH.offline({ item, isLocalMachine, nowMs });
  }
}

function capitalize(value: string | null): string | null {
  if (value === null) return null;
  return capitalizeString(value);
}

function capitalizeString(value: string): string {
  if (value.length === 0) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
