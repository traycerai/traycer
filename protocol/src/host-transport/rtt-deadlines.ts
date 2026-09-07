/**
 * The one RTT-to-deadline derivation every plane sizes its windows with.
 * It sits in `host-transport` rather than under a domain because the relay keepalive is transport machinery and must not import the browser domain.
 */

/**
 * What one deadline covers, in round trips of the control plane, plus the literal it may never go below.
 * Multipliers are counted (how many round trips must complete inside the window), not tuned.
 */
export type ControlPlaneDeadlineSpec = {
  readonly floorMs: number;
  readonly roundTrips: number;
};

/**
 * A sample above this is not a link measurement - it is an event-loop stall, a suspended renderer, or a peer answering a probe it had queued for minutes.
 */
export const MAX_CONTROL_PLANE_RTT_MS = 3_000;

/**
 * `max(floorMs, roundTrips x (rtt + 4 x rttvar))`.
 * Measurement can only ever lengthen a window, never shorten one.
 */
export function deriveRttDeadlineMs(input: {
  readonly floorMs: number;
  readonly roundTrips: number;
  readonly rttMs: number | null;
  readonly varianceMs: number;
  readonly maxRttMs: number;
}): number {
  if (input.rttMs === null) return input.floorMs;
  const clamped = Math.min(Math.max(input.rttMs, 0), input.maxRttMs);
  const variance = Math.min(Math.max(input.varianceMs, 0), input.maxRttMs);
  return Math.max(
    input.floorMs,
    Math.round(input.roundTrips * (clamped + 4 * variance)),
  );
}

/**
 * The variance-free screencast case, against the spec's own floor - what every entry of both k-tables (the host's and the viewer's) is read through.
 */
export function deriveSpecDeadlineMs(
  spec: ControlPlaneDeadlineSpec,
  rttMs: number | null,
): number {
  return deriveRttDeadlineMs({
    floorMs: spec.floorMs,
    roundTrips: spec.roundTrips,
    rttMs,
    varianceMs: 0,
    maxRttMs: MAX_CONTROL_PLANE_RTT_MS,
  });
}
