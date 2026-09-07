/**
 * Timing / sizing knobs for the client remote transport (Architecture §3, §4b).
 * The re-auth values must stay under the relay's derived deadlines (workers/relay-do): client leg `baseInterval = 60 min`, host leg `= 15 min`.
 */

/**
 * Bulk chunk cap (audit C2).
 * A logical message larger than this is split across multiple mux frames so a keystroke (interactive class) never queues behind a megabyte frame.
 */
export { BULK_CHUNK_SIZE_BYTES } from "@traycer/protocol/host-transport/chunking";

/**
 * Legacy initial per-session send credits for the bulk (low-priority) class, used only against a peer that did not advertise `SESSION_CAPABILITY_FINE_CREDITS`.
 * Interactive and session-control frames are never credit-gated (they must not stall on a slow peer); only bulk frames draw down credits.
 */
export const INITIAL_BULK_SEND_CREDITS = 512;

/**
 * Client-leg re-auth cadence to the relay (§4b, R4-D2).
 * The client re-presents a fresh CS attach-grant on the live socket well before the relay's 60-min client-leg deadline; jitter spreads a fleet so a relay is not hit by a synchronized mint stampede.
 */
export const CLIENT_REAUTH_INTERVAL_MS = 45 * 60 * 1000;
export const CLIENT_REAUTH_JITTER_MS = 5 * 60 * 1000;

export const HOST_STANDING_BOUND_MS = 15 * 60 * 1000;

export const RELAY_DIAL_TIMEOUT_MS = 10_000;

/** Budget for the relay `attach_ack` control frame after the socket opens. */
export const ATTACH_ACK_TIMEOUT_MS = 10_000;

export const NOISE_HANDSHAKE_TIMEOUT_MS = 15_000;

export const SESSION_OPEN_ACK_TIMEOUT_MS = 15_000;

/** Budget for a single unary `response` after its `request` frame is sent. */
export const UNARY_RESPONSE_TIMEOUT_MS = 30_000;

export const RECONNECT_INITIAL_BACKOFF_MS = 1_000;
export const RECONNECT_MAX_BACKOFF_MS = 30_000;

/**
 * How long a session must stay ready before its backoff ladder is considered paid off and resets to the immediate rung.
 * Partial credit is therefore never awarded.
 */
export const RECONNECT_STABLE_RESET_MS = 30_000;

export const DIAL_FAILURE_RESTATE_MS = 5 * 60 * 1000;

/**
 * The torn-to-zero session stays cached and connected for this window; a re-acquire inside it adopts the warm, already-ready session.
 * Bounded so an abandoned session (host deregistered, user signed out) never outlives the window - within it the session's own re-auth/standing machinery still governs.
 */
export const REMOTE_SESSION_LINGER_MS = 60_000;

/**
 * Negative-cache window for an attach-grant `plan_restricted` verdict.
 * Without a cache, the next registry/render acquisition immediately replaces that closed session and asks authn again, producing a cross-session request loop even though each individual session correctly stopped.
 */
export const PLAN_RESTRICTED_REPROBE_MS = HOST_STANDING_BOUND_MS;

export const PLAN_RESTRICTED_FATAL_CODE = "PLAN_RESTRICTED";
export const PLAN_RESTRICTED_CLOSED_REASON = "plan-restricted";

export function planRestrictedClosedReason(reprobeAt: number): string {
  return `${PLAN_RESTRICTED_CLOSED_REASON}:${reprobeAt}`;
}

export function planRestrictedReprobeAtFromClosedReason(
  reason: string | null,
): number | null {
  if (reason === null) return null;
  const prefix = `${PLAN_RESTRICTED_CLOSED_REASON}:`;
  if (!reason.startsWith(prefix)) return null;
  const value = Number(reason.slice(prefix.length));
  return Number.isFinite(value) ? value : null;
}

/**
 * Relay keepalive cadence.
 * The client sends the `relay-ping` string on this interval; the relay auto-responds `relay-pong` without waking the DO (`setWebSocketAutoResponse`).
 */
export const RELAY_PING_INTERVAL_MS = 25_000;
export const RELAY_PONG_TIMEOUT_MS = 60_000;

/**
 * Ceiling on how far measurement may stretch the awaiting window, as a multiple of {@link RELAY_AWAITING_PONG_TIMEOUT_MS}.
 * One estimator sizes both windows, and they are not the same kind of window.
 */
export const RELAY_AWAITING_DEADLINE_CAP_MULTIPLE = 3;

export const RELAY_WAKE_PROBE_TIMEOUT_MS = 10_000;

/**
 * The wake-probe deadline for a runtime that knows it was just backgrounded briefly (a mobile app switch measured under {@link WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS}).
 */
export const RELAY_WAKE_PROBE_TIMEOUT_BACKGROUNDED_MS = 3_000;

/**
 * Background dwell beyond which a resuming mobile runtime stops probing its old socket and re-dials outright.
 * A resume that cannot state its background duration (desktop, web, a shell that missed the hidden edge) keeps the default probe path - forcing a redial there would tear down healthy desktop sockets on every lid-open.
 */
export const WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS = 10_000;

/**
 * How often the keepalive loop wakes.
 * Distinct from how often it pings: the loop now runs two cadences (below) and a single timer that ticks at the faster of them is what lets it switch between them without tearing the timer down and re-arming it.
 */
export const RELAY_PING_TICK_MS = 5_000;

/**
 * The awaiting cadence: used once this client has sent application traffic that the relay has not answered with anything at all.
 * A half-open socket is precisely "I send, nothing comes back", so that condition is the detector, and it is the only state in which paying for a 5 s cadence is worth it.
 */
export const RELAY_AWAITING_PING_INTERVAL_MS = 5_000;
export const RELAY_AWAITING_PONG_TIMEOUT_MS = 12_000;

/**
 * How long after a completed attach the session waits before logging that its ready boundary is still blocked by streams with NO restore evidence (no delivered frame and no in-flight chunk).
 * The log line is the only artifact that attributes that state to a method.
 */
export const RESTORE_STALL_LOG_AFTER_MS = 8_000;

/**
 * Progress deadline for one stream's IN-flight chunk reassembly: the longest acceptable gap between two accepted chunks of the same message.
 * This is the only deadline that speaks for a partial transfer.
 */
export const REASSEMBLY_PROGRESS_TIMEOUT_MS = 20_000;

export const MAX_TERMINAL_STREAM_IDS = 256;
