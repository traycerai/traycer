import type {
  HostListItem,
  HostPresenceHealth,
  HostStatusDTO,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";
import { HOST_VERSION_PATTERN } from "@traycer/protocol/host/version";

/**
 * Pure status derivation for the My Hosts list (Remote Host Support §7,
 * Journey 2). Every row is a pure function of the host-status DTO + the
 * envelope's presence-health + two client-local signals (live-session
 * evidence, the viewer's own last reachability check) — no ambient probing
 * beyond what those two signals already recorded elsewhere. Invariants the
 * tests pin:
 *
 *   1. NO green dot without a live signal — `showLiveDot` is `true` only for a
 *      live lease (`fresh`/`stale`) or live-session evidence.
 *   2. NEVER a false "Offline" when coordination is blind — an `expired` lease
 *      under `presenceHealth: degraded` renders "Status unknown", not Offline.
 *   3. Live-session evidence wins over every other signal (R4-B5) — a client
 *      holding an open E2E session to the host is firsthand truth; the lease
 *      is hearsay about a different leg.
 *   4. The relay-attach / tunnel / connection-issue sub-states only apply to a
 *      REMOTE row (`isViewerLocalHost: false`) — a local host never attaches
 *      to any relay in v1, so `hostRelayAttached` is always `false` for one
 *      and must never be read as "lost its tunnel".
 */

export type HostPresenceTone =
  | "online"
  | "likely-reachable"
  | "tunnel-down"
  | "connection-issue"
  | "offline"
  | "unknown"
  | "client-offline";

export interface HostPresenceView {
  readonly tone: HostPresenceTone;
  readonly label: string;
  /** A green liveness dot renders ONLY when a live lease/session backs it. */
  readonly showLiveDot: boolean;
  /** Active agent work — meaningful (and shown) only when Online. */
  readonly busy: boolean;
}

export interface DeriveHostPresenceOptions {
  readonly status: HostStatusDTO;
  readonly presenceHealth: HostPresenceHealth;
  readonly isViewerLocalHost: boolean;
  readonly hasLiveSession: boolean;
  readonly viewerCheck: ViewerReachabilityCheckLike | null;
  readonly nowMs: number;
}

export function deriveHostPresence(
  options: DeriveHostPresenceOptions,
): HostPresenceView {
  const {
    status,
    presenceHealth,
    isViewerLocalHost,
    hasLiveSession,
    viewerCheck,
    nowMs,
  } = options;
  // This client is offline: we cannot claim anything about the host's liveness.
  if (status.clientCloud === "down") {
    return {
      tone: "client-offline",
      label: "You're offline",
      showLiveDot: false,
      busy: false,
    };
  }
  // Live-session-evidence override (R4-B5): a client holding an open E2E
  // session to this host renders Online regardless of everything below.
  if (hasLiveSession) {
    return {
      tone: "online",
      label: "Online",
      showLiveDot: true,
      busy: status.busy,
    };
  }
  if (status.presenceLease === "fresh" || status.presenceLease === "stale") {
    if (!isViewerLocalHost && !status.hostRelayAttached) {
      // The host's own leg is down — never the viewer's path. Distinguishing
      // "which leg failed" is exactly R4's status-honesty requirement.
      return {
        tone: "tunnel-down",
        label: "Up, re-establishing its tunnel",
        showLiveDot: false,
        busy: false,
      };
    }
    if (
      !isViewerLocalHost &&
      viewerCheck !== null &&
      viewerCheck.result === "failing"
    ) {
      return {
        tone: "connection-issue",
        label: `Reachable, connection issue (checked ${formatElapsed(
          Math.max(0, Math.round((nowMs - viewerCheck.checkedAtMs) / 1000)),
        )})`,
        showLiveDot: true,
        busy: status.busy,
      };
    }
    return {
      tone: "online",
      label: "Online",
      showLiveDot: true,
      busy: status.busy,
    };
  }
  // Lease expired. When coordination cannot see presence, an expired lease is
  // NOT proof of Offline — render honest uncertainty instead.
  if (presenceHealth.status === "degraded") {
    return {
      tone: "unknown",
      label: "Status unknown",
      showLiveDot: false,
      busy: false,
    };
  }
  if (!isViewerLocalHost && status.hostRelayAttached) {
    // Heartbeat leg down but the relay leg is (recently) confirmed up — the
    // host is very likely still reachable via a live session, just not
    // reporting its own liveness right now.
    return {
      tone: "likely-reachable",
      label: "Not reporting — likely reachable",
      showLiveDot: false,
      busy: false,
    };
  }
  // Expired lease + healthy ingestion (+ no relay evidence) ⇒ a genuine Offline.
  return {
    tone: "offline",
    label: "Offline",
    showLiveDot: false,
    busy: false,
  };
}

/** Structural subset of `ViewerReachabilityCheck` so this module stays UI-free. */
export interface ViewerReachabilityCheckLike {
  readonly result: "ok" | "failing";
  readonly checkedAtMs: number;
}

export type HostUpdatePillTone = "info" | "warn" | "danger";

export interface HostUpdatePill {
  readonly label: string;
  readonly tone: HostUpdatePillTone;
}

/**
 * Maps the update lifecycle to a pill (Architecture §7/§13). `current` shows
 * nothing. S1 populates `current`/`pending`/`required`; the remaining states
 * are rendered for completeness once the S3 reconciler emits them.
 */
export function deriveUpdatePill(
  updateState: HostUpdateState,
): HostUpdatePill | null {
  switch (updateState) {
    case "available":
      return { label: "Update available", tone: "warn" };
    case "pending":
      return { label: "Update pending", tone: "warn" };
    case "updating":
      return { label: "Updating…", tone: "info" };
    case "failed":
      return { label: "Update failed", tone: "danger" };
    case "required":
      return { label: "Update required", tone: "danger" };
    case "current":
      return null;
  }
}

// -----------------------------------------------------------------------------
// Update affordances (Architecture §13, T16): "Update now" version input,
// auto-policy toggle, and the "Apply now — ends N sessions" drain-gate force.
// -----------------------------------------------------------------------------

/**
 * Validates a user-typed "Update now" target version client-side before
 * submit. Trims surrounding whitespace (a pasted value commonly carries it)
 * before matching. The pattern is shared with authn-v3's server-side check via
 * `@traycer/protocol/host/version`, so a client-accepted value never bounces
 * off the server's 400.
 */
export function isValidHostVersion(value: string): boolean {
  return HOST_VERSION_PATTERN.test(value.trim());
}

export interface HostUpdateAffordanceView {
  /**
   * Whether to show the "Update now" target-version input + button. Hidden
   * only while a `desiredVersion` write is already in flight toward the host
   * (`pending` — approved, draining; `updating` — swap in progress); shown
   * for `current`/`available`/`required`, and also for `failed` (the failed
   * swap's `desiredVersion` stays approved, so re-submitting "Update now" is
   * a legitimate retry, not a redundant action).
   */
  readonly showUpdateNowInput: boolean;
  /**
   * "Waiting for N sessions" — populated only when the host is actually
   * gated on open sessions (`updateState === "pending"` AND
   * `busySessionCount > 0`); `null` otherwise, including a `pending` host
   * that hasn't yet started draining (`busySessionCount === 0`).
   */
  readonly waitingForSessionsLabel: string | null;
  /** Whether to show the "Apply now — ends N sessions" drain-gate force. */
  readonly showApplyNowForce: boolean;
  /** "Apply now — ends N sessions", or `null` when the force isn't offered. */
  readonly applyNowLabel: string | null;
}

function pluralizeSessions(count: number): string {
  return count === 1 ? "session" : "sessions";
}

/**
 * Derives the update-affordance view from the status DTO alone (Architecture
 * §13). Pure and DTO-driven, matching `deriveUpdatePill`'s contract — no
 * client-local signal is needed here (unlike `deriveHostPresence`).
 */
export function deriveUpdateAffordance(
  status: HostStatusDTO,
): HostUpdateAffordanceView {
  const showUpdateNowInput =
    status.updateState !== "pending" && status.updateState !== "updating";
  const isWaitingOnSessions =
    status.updateState === "pending" && status.busySessionCount > 0;
  const sessionsWord = pluralizeSessions(status.busySessionCount);
  return {
    showUpdateNowInput,
    waitingForSessionsLabel: isWaitingOnSessions
      ? `Waiting for ${status.busySessionCount} ${sessionsWord}`
      : null,
    showApplyNowForce: isWaitingOnSessions,
    applyNowLabel: isWaitingOnSessions
      ? `Apply now — ends ${status.busySessionCount} ${sessionsWord}`
      : null,
  };
}

/**
 * Human relative last-seen ("last seen 2h ago"), from the durable registry
 * timestamp (survives cache loss). Returns `null` when never seen or unparsable.
 */
export function formatLastSeen(
  lastSeenAt: string | null,
  nowMs: number,
): string | null {
  if (lastSeenAt === null) {
    return null;
  }
  const then = Date.parse(lastSeenAt);
  if (Number.isNaN(then)) {
    return null;
  }
  const deltaSeconds = Math.max(0, Math.round((nowMs - then) / 1000));
  return `last seen ${formatElapsed(deltaSeconds)}`;
}

function formatElapsed(deltaSeconds: number): string {
  if (deltaSeconds < 45) {
    return "just now";
  }
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * The identity meta line under a host name. Joins the platform and the
 * last-reported version ("Ubuntu · v1.4.2"), falling back to the last-seen
 * hint for a host with no live version. Returns `null` when nothing is known.
 */
export function formatHostMeta(
  item: HostListItem,
  presence: HostPresenceView,
  nowMs: number,
): string | null {
  const parts: string[] = [];
  if (item.platform !== null && item.platform.length > 0) {
    parts.push(item.platform);
  }
  if (item.status.appVersion !== null && item.status.appVersion.length > 0) {
    parts.push(`v${item.status.appVersion}`);
  }
  // For a host that is not live, the durable last-seen is the more useful hint
  // than a stale version string.
  if (presence.tone === "offline") {
    const lastSeen = formatLastSeen(item.status.lastSeenAt, nowMs);
    if (lastSeen !== null) {
      return lastSeen;
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" · ");
}
