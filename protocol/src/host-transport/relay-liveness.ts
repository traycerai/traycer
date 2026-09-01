/**
 * Path-RTT estimation for the relay keepalive, shared by both legs of the
 * relay socket (the host's uplink and the client's session socket).
 *
 * ## Why the liveness deadline cannot be a constant
 *
 * `relay-ping`/`relay-pong` is the only round trip either leg has, and the
 * missed-pong deadline sized against it was a fixed number of milliseconds.
 * That number is an assumption about the path, and a relayed control plane
 * breaks it: a jittery link (measured p95 100ms / p99 523ms over a DERP hop)
 * plus a multi-second stall on either end reads exactly like a dead socket to
 * a fixed detector, and the teardown costs the whole session a reattach
 * (F11: ~20 `relay-missed-pongs` teardowns in 10.5h, none of them a dead
 * path).
 *
 * ## Shape
 *
 * Only the per-socket SAMPLING state lives here - the ping/pong run and its
 * Karn ambiguity, so both legs keep nothing but three calls. The arithmetic is
 * {@link deriveRttDeadlineMs}, shared with the screencast control plane rather
 * than re-derived: the relay simply passes the variance term that plane leaves
 * at zero, because THIS deadline is a liveness verdict rather than a budget and
 * has to cover the path's jitter tail.
 *
 * Deliberately its OWN estimator instance per socket - a relay leg and a
 * per-subscriber screencast subscription do not share a path, a lifetime, or
 * a sample rate.
 *
 * `deadlineMs` FLOORS on the constant it replaces, so measurement can only
 * ever lengthen a window. A fast path behaves exactly as it did before this
 * module existed; only a genuinely slow or jittery one gets more room.
 */
import { deriveRttDeadlineMs } from "./rtt-deadlines";

/** Smoothing weights, RFC 6298 §2 (`alpha = 1/8`, `beta = 1/4`). */
const RTT_ALPHA = 1 / 8;
const RTT_VAR_BETA = 1 / 4;

/**
 * A sample above this is not a path measurement - it is a suspended runtime,
 * an event-loop stall, or a pong answered out of a queue it sat in for
 * minutes. Clamped rather than discarded, so an awful path stays measurable
 * while every derived deadline is bounded by construction.
 */
export const MAX_RELAY_PATH_RTT_MS = 10_000;

/**
 * How many round trips a missed-pong window covers. Three, so a single lost
 * pong plus the ping that follows it is still inside the window.
 */
const RELAY_PONG_DEADLINE_ROUND_TRIPS = 3;

export type RelayPathEstimator = {
  /** Opens an unanswered run, or marks the open one ambiguous. */
  readonly notePingSent: (now: number) => void;
  /** Closes the run, sampling it only when exactly one ping was outstanding. */
  readonly notePongReceived: (now: number) => void;
  /**
   * Retires the open run WITHOUT sampling it, and marks the next one
   * ambiguous. The wake probe's ping is the caller: its round trip carries the
   * runtime's own resume cost and would report the path as far worse than it
   * is, and a scheduled ping still outstanding across the suspend would
   * otherwise be credited with the whole sleep.
   */
  readonly retireRun: () => void;
  /**
   * `max(floorMs, 3 x (srtt + 4 x rttvar))`. Returns `floorMs` unchanged until
   * a round trip has completed.
   */
  readonly deadlineMs: (floorMs: number) => number;
};

export function createRelayPathEstimator(): RelayPathEstimator {
  let smoothedMs: number | null = null;
  let varianceMs = 0;
  /**
   * When the OLDEST currently-unanswered keepalive ping went out, or `null`
   * when none is outstanding.
   */
  let pingSentAt: number | null = null;
  /**
   * Karn's algorithm (RFC 6298 §3): once a second ping goes out with the
   * first still unanswered, the next `relay-pong` cannot be attributed to
   * either of them, so that exchange measures nothing. Without this, a pong
   * answering the LAST of three pings would record the whole run as one round
   * trip - and since the estimate only ever LENGTHENS the deadline, the
   * inflation would relax the very detector that was supposed to catch the
   * silence.
   */
  let pingAmbiguous = false;

  const noteRoundTrip = (sampleMs: number): void => {
    const clamped = Math.min(Math.max(sampleMs, 0), MAX_RELAY_PATH_RTT_MS);
    if (smoothedMs === null) {
      smoothedMs = clamped;
      // RFC 6298's first-sample seed: half the sample, so one measurement
      // alone never claims the path is jitter-free.
      varianceMs = clamped / 2;
      return;
    }
    varianceMs =
      (1 - RTT_VAR_BETA) * varianceMs +
      RTT_VAR_BETA * Math.abs(smoothedMs - clamped);
    smoothedMs = (1 - RTT_ALPHA) * smoothedMs + RTT_ALPHA * clamped;
  };

  return {
    notePingSent: (now) => {
      if (pingSentAt === null) {
        pingSentAt = now;
        return;
      }
      pingAmbiguous = true;
    },
    notePongReceived: (now) => {
      if (pingSentAt !== null && !pingAmbiguous) {
        noteRoundTrip(now - pingSentAt);
      }
      pingSentAt = null;
      pingAmbiguous = false;
    },
    retireRun: () => {
      pingSentAt = null;
      pingAmbiguous = true;
    },
    deadlineMs: (floorMs) =>
      deriveRttDeadlineMs({
        floorMs,
        roundTrips: RELAY_PONG_DEADLINE_ROUND_TRIPS,
        rttMs: smoothedMs,
        varianceMs,
        maxRttMs: MAX_RELAY_PATH_RTT_MS,
      }),
  };
}
