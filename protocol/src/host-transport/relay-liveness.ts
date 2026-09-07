/**
 * Path-RTT estimation for the relay keepalive, shared by both legs of the relay socket (the host's uplink and the client's session socket).
 */
import { deriveRttDeadlineMs } from "./rtt-deadlines";

/** Smoothing weights, RFC 6298 §2 (`alpha = 1/8`, `beta = 1/4`). */
const RTT_ALPHA = 1 / 8;
const RTT_VAR_BETA = 1 / 4;

/**
 * A sample above this is not a path measurement - it is a suspended runtime, an event-loop stall, or a pong answered out of a queue it sat in for minutes.
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
  /** Retires the open run WITHOUT sampling it, and marks the next one ambiguous. */
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
   * Karn's algorithm (RFC 6298 §3): once a second ping goes out with the first still unanswered, the next `relay-pong` cannot be attributed to either of them, so that exchange measures nothing.
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
