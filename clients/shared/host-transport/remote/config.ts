/**
 * Timing / sizing knobs for the client remote transport (Architecture §3, §4b).
 *
 * All values are explicit constants (no defaults baked into signatures, per the
 * repo style rule) so every caller passes them deliberately and a reviewer can
 * audit the security-relevant bounds (re-auth deadlines, chunk cap) in one
 * place. The re-auth values MUST stay under the relay's derived deadlines
 * (workers/relay-do): client leg `baseInterval = 60 min`, host leg `= 15 min`.
 */

/**
 * Bulk chunk cap (audit C2). A logical message larger than this is split across
 * multiple mux frames so a keystroke (interactive class) never queues behind a
 * megabyte frame. Deliberately far under the relay's 1 MiB per-frame cap.
 */
export const BULK_CHUNK_SIZE_BYTES = 64 * 1024;

/**
 * Initial per-session send credits for the bulk (low-priority) class. Interactive
 * and session-control frames are never credit-gated (they must not stall on a
 * slow peer); only bulk frames draw down credits. The peer replenishes via
 * `credit` control frames as it drains its receive buffer.
 */
export const INITIAL_BULK_SEND_CREDITS = 512;

/**
 * How many inbound bulk frames the client consumes before granting a fresh
 * batch of credits back to the peer. Keeps the credit-return traffic coarse so
 * it does not itself become chatter.
 */
export const INBOUND_CREDIT_GRANT_BATCH = 256;

/**
 * Client-leg re-auth cadence to the relay (§4b, R4-D2). The client re-presents a
 * fresh CS attach-grant on the live socket well before the relay's 60-min
 * client-leg deadline; jitter spreads a fleet so a relay is not hit by a
 * synchronized mint stampede.
 */
export const CLIENT_REAUTH_INTERVAL_MS = 45 * 60 * 1000;
export const CLIENT_REAUTH_JITTER_MS = 5 * 60 * 1000;

/**
 * Peer-enforced host standing (R4-D2). A revoked host will not enforce its own
 * death, so the client independently fails the session if the host has not
 * proven fresh standing within this window. The host proves standing by its
 * relay re-attach (surfaced to the client as a `host_attached` control frame)
 * and/or an in-channel `reauth_notice` mux frame (reserved contract for T11).
 * Matches the relay's 15-min host-leg deadline.
 */
export const HOST_STANDING_BOUND_MS = 15 * 60 * 1000;

/** Dial timeout for the persistent relay socket (shared with the local transports). */
export const RELAY_DIAL_TIMEOUT_MS = 10_000;

/** Budget for the relay `attach_ack` control frame after the socket opens. */
export const ATTACH_ACK_TIMEOUT_MS = 10_000;

/** Budget for each Noise handshake message round-trip through the relay. */
export const NOISE_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Budget for the in-channel session `openAck` after `open{bearer}` is sent. */
export const SESSION_OPEN_ACK_TIMEOUT_MS = 15_000;

/** Budget for a single unary `response` after its `request` frame is sent. */
export const UNARY_RESPONSE_TIMEOUT_MS = 30_000;

/** Reconnect backoff bounds for the whole session (per-channel ready boundary reset). */
export const RECONNECT_INITIAL_BACKOFF_MS = 1_000;
export const RECONNECT_MAX_BACKOFF_MS = 30_000;

/**
 * Relay keepalive cadence. The client sends the `relay-ping` string on this
 * interval; the relay auto-responds `relay-pong` WITHOUT waking the DO
 * (`setWebSocketAutoResponse`). Missing `PONG_TIMEOUT` worth of pongs means the
 * socket is dead (e.g. half-open after a device sleep) → drop and reconnect. No
 * E2E idle ping exists (R4-C1); this is the whole liveness floor at the relay leg.
 */
export const RELAY_PING_INTERVAL_MS = 25_000;
export const RELAY_PONG_TIMEOUT_MS = 60_000;
