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
 * megabyte frame. Single-sourced from the protocol's shared chunking module -
 * both peers import the same constant, so it can no longer drift by hand.
 */
export { BULK_CHUNK_SIZE_BYTES } from "@traycer/protocol/host-transport/chunking";

/**
 * LEGACY initial per-session send credits for the bulk (low-priority) class,
 * used only against a peer that did NOT advertise
 * `SESSION_CAPABILITY_FINE_CREDITS`. Interactive and session-control frames
 * are never credit-gated (they must not stall on a slow peer); only bulk
 * frames draw down credits.
 *
 * 512 frames × 64 KiB is a 32 MiB un-granted window — larger than an entire
 * epic bootstrap — which is why it has to stay reachable but must not stay
 * default: it lets a sender push a whole snapshot with the receiver's drain
 * rate having no influence at all. Against a peer that advertised fine
 * credits the session adopts `FINE_INITIAL_BULK_SEND_CREDITS` instead; see the
 * skew table on that constant for why the shrink cannot be unilateral.
 */
export const INITIAL_BULK_SEND_CREDITS = 512;

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
 * How long a session must stay READY before its backoff ladder is considered
 * paid off and resets to the immediate rung.
 *
 * Previously the ladder reset the instant the ready boundary was reached,
 * which is the classic flapping bug: a host that accepts a session and drops
 * it two seconds later gets re-dialled at the fastest rung forever, because
 * every doomed attempt "succeeded" long enough to clear the counter. Requiring
 * sustained health instead means a genuine one-off blip still recovers at the
 * immediate rung, while a genuinely sick host backs off exactly as intended.
 *
 * The reset timer is armed at the ready boundary and cancelled on any
 * connection loss: `dropConnection` covers socket/session drops, while
 * `onHostDetached` clears it directly because that relay control edge keeps
 * the socket alive and does not enter `dropConnection`. Partial credit is
 * therefore never awarded.
 *
 * COLLISION WARNING, for whoever changes this number. It is currently equal to
 * {@link RECONNECT_MAX_BACKOFF_MS}, and the two are independent concepts - a
 * probation window and a backoff ceiling - that nothing requires to match.
 * `remote-session.test.ts` identifies timers by their DELAY, so while these are
 * equal the probation timer and a capped redial are indistinguishable to a spy
 * assertion. That has already cost: an assertion of the form
 * `toHaveBeenCalledWith(fn, 30_000)` was satisfied by the probation timer and
 * passed for months against a backoff armed at 16s. Three call sites in that
 * file now clear or fingerprint spies specifically to work around it. Moving
 * either constant is safe; assuming they are the same one is not.
 */
export const RECONNECT_STABLE_RESET_MS = 30_000;

/**
 * How often the session's `DialFailureLog` re-states an UNCHANGED failure
 * cause. At the 30s backoff cap this suppresses ~9 of every 10 attempts while
 * keeping the cause present in any 5-minute log tail (mirrors the host
 * uplink's `UPLINK_FAILURE_RESTATE_MS` - the two halves of the tunnel log
 * with the same cadence).
 */
export const DIAL_FAILURE_RESTATE_MS = 5 * 60 * 1000;

/**
 * Keep-warm linger for the shared remote session after its LAST consumer
 * releases (the S1 ticket deferred this; the cost is now measured: every
 * settings-panel open against a remote host paid a fresh grant mint + relay
 * dial + Noise handshake (~1-2s of visible "connecting"), and a release that
 * landed mid-establishment tore the dial down in flight - a double
 * mint/attach was observed on one panel open). The torn-to-zero session stays
 * cached and connected for this window; a re-acquire inside it adopts the
 * warm, already-ready session. Bounded so an abandoned session (host
 * deregistered, user signed out) never outlives the window - within it the
 * session's own re-auth/standing machinery still governs.
 */
export const REMOTE_SESSION_LINGER_MS = 60_000;

/**
 * Relay keepalive cadence. The client sends the `relay-ping` string on this
 * interval; the relay auto-responds `relay-pong` WITHOUT waking the DO
 * (`setWebSocketAutoResponse`). Missing `PONG_TIMEOUT` worth of pongs means the
 * socket is dead (e.g. half-open after a device sleep) → drop and reconnect. No
 * E2E idle ping exists (R4-C1); this is the whole liveness floor at the relay leg.
 */
export const RELAY_PING_INTERVAL_MS = 25_000;
export const RELAY_PONG_TIMEOUT_MS = 60_000;

/**
 * Deadline for the answer to a WAKE-time ping (`RelaySocket.pokeKeepalive`),
 * as opposed to the 60s the scheduled keepalive allows.
 *
 * A runtime that was frozen (OS sleep, a suspended WebView) comes back holding
 * a socket the network may have dropped underneath it without ever delivering a
 * close - and `RELAY_PONG_TIMEOUT_MS` only catches that once the silence is a
 * full minute old, which on a phone is most of an app switch. The pong is
 * auto-answered at the relay's edge without waking the durable object, so the
 * only thing between the two ends is round-trip time; a deadline in the dial
 * timeout's league is generous for a link that works and quick for one that
 * does not. A false positive costs exactly one redial.
 */
export const RELAY_WAKE_PROBE_TIMEOUT_MS = 10_000;

/**
 * The wake-probe deadline for a runtime that KNOWS it was just backgrounded
 * briefly (a mobile app switch measured under
 * {@link WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS}).
 *
 * The 10s default above is sized for a desktop wake, where the socket usually
 * survived and a false positive re-dials a healthy localhost link. An iOS app
 * switch inverts the odds: the OS suspends the WebView and typically kills its
 * sockets, so the probe exists to catch the RARE survivor quickly, not to
 * protect the common one. The pong is auto-answered at the relay's edge, so a
 * healthy link answers in round-trip time; 3s is generous for that and cheap
 * to be wrong about - a false positive costs one redial of a socket that was
 * probably dead anyway.
 */
export const RELAY_WAKE_PROBE_TIMEOUT_BACKGROUNDED_MS = 3_000;

/**
 * Background dwell beyond which a resuming mobile runtime stops probing its
 * old socket and re-dials outright.
 *
 * Duration is the discriminator because it tracks what iOS actually does: a
 * quick app switch often returns before the OS has torn the socket down (worth
 * a short probe - see the constant above), while after ~10s of background the
 * socket is almost certainly gone and a probe only delays the redial the user
 * is already waiting on. A resume that cannot state its background duration
 * (desktop, web, a shell that missed the hidden edge) keeps the default probe
 * path - forcing a redial there would tear down healthy desktop sockets on
 * every lid-open.
 */
export const WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS = 10_000;

/**
 * How often the keepalive loop WAKES. Distinct from how often it PINGS: the
 * loop now runs two cadences (below) and a single timer that ticks at the
 * faster of them is what lets it switch between them without tearing the
 * timer down and re-arming it.
 */
export const RELAY_PING_TICK_MS = 5_000;

/**
 * The AWAITING cadence: used once this client has sent application traffic
 * that the relay has not answered with anything at all. A half-open socket is
 * precisely "I send, nothing comes back", so that condition is the detector,
 * and it is the only state in which paying for a 5 s cadence is worth it.
 *
 * The old single pair cost up to ~85 s to notice a dead socket — a 60 s
 * deadline only TESTED every 25 s — during which the app is silently talking
 * to nothing. Here the worst case is one tick plus the deadline, ~17 s.
 *
 * This is affordable only because reattach is cheap: on a flaky link an eager,
 * cheap reattach beats a long silent hang, but that trade inverts if a
 * reattach ever costs a full snapshot again. Anyone lengthening reattach owes
 * these two constants a second look.
 *
 * Idle sessions keep the 25 s/60 s pair above, so a backgrounded app does not
 * pay for a cadence it cannot benefit from. The relay's auto-response strings
 * are untouched by any of this — pings still never wake a hibernating DO.
 *
 * WHAT THIS DEADLINE ACTUALLY BOUNDS, which is stricter than "time to
 * reattach": every write surface is gated on `connectionStatus === "open"`, so
 * a half-open socket is the ONLY interval in which a user can believe they can
 * act when they cannot. Everywhere else a disconnect disables the affordance.
 * So the number to minimise is *how long the app can lie about being
 * connected*, not how long recovery takes.
 *
 * PROVISIONAL: 12 s is derived, not measured. It is bounded below by the cost
 * of being wrong in the other direction — a deadline under the real
 * round-trip of a merely-slow-but-healthy link produces spurious reattaches,
 * which is exactly the "eviction for clients that are merely far away" that
 * governing ruling 1 rejects. Tightening it on argument alone would trade a
 * measured failure mode for an unmeasured one; the flaky-link scenario
 * harness is what should move it.
 */
export const RELAY_AWAITING_PING_INTERVAL_MS = 5_000;
export const RELAY_AWAITING_PONG_TIMEOUT_MS = 12_000;

/**
 * Bounded terminal-stream tombstone frontier, mirroring the host's invariant
 * (R-2 / `r2-host-stream-tombstone`): once a stream fails or closes, its
 * streamId is remembered so a relay-delayed genuine frame for that same
 * streamId can't resurrect a fresh reassembler accumulator after the fact.
 * StreamIds are monotonic and never reused within a session, so the set only
 * needs to cover the recent terminal frontier - past this cap, the oldest
 * tombstone is evicted rather than letting the set grow unboundedly for the
 * life of a long-lived session.
 */
export const MAX_TERMINAL_STREAM_IDS = 256;
