/**
 * The one RTT-to-deadline derivation every plane sizes its windows with.
 *
 * Two very different measurements feed it: the screencast control plane's
 * `rttProbe`/`rttProbeAck` round trip (the host measures, stamps its smoothed
 * estimate on every probe, and the viewer reads the same number without
 * measuring anything) and the relay keepalive's `relay-ping`/`relay-pong`.
 * What lives HERE is only the arithmetic - what each side spends it on stays
 * on that side, as one k-table per side, because the windows are not the same
 * windows.
 *
 * It sits in `host-transport` rather than under a domain because the relay
 * keepalive is transport machinery and must not import the browser domain.
 */

/**
 * What one deadline covers, in round trips of the control plane, plus the
 * literal it may never go below. Multipliers are counted (how many round trips
 * must complete inside the window), not tuned.
 */
export type ControlPlaneDeadlineSpec = {
  readonly floorMs: number;
  readonly roundTrips: number;
};

/**
 * A sample above this is not a link measurement - it is an event-loop stall, a
 * suspended renderer, or a peer answering a probe it had queued for minutes.
 * Clamping (rather than discarding) keeps a genuinely awful link measurable
 * while bounding every derived deadline by construction.
 */
export const MAX_CONTROL_PLANE_RTT_MS = 3_000;

/**
 * `max(floorMs, roundTrips x (rtt + 4 x rttvar))`.
 *
 * The variance term is RFC 6298's: a deadline that decides whether silence
 * means DEATH has to cover the path's jitter tail, not just its median, or a
 * link measured at 105ms with a 523ms p99 gets torn down for being itself. A
 * window that is a BUDGET for work that must fit rather than a liveness
 * verdict passes `varianceMs: 0` - one outlier lengthening a budget is a cost
 * with nothing bought.
 *
 * `rttMs === null` - nothing measured yet, no video plane, a peer too old to
 * answer a probe - returns the floor unchanged, which is what makes every call
 * site behave exactly as the literal it replaced until a measurement exists.
 * Measurement can only ever lengthen a window, never shorten one.
 *
 * `maxRttMs` is a parameter rather than a constant because the callers clamp
 * different things: a screencast probe over an established subscription (3s)
 * and a relay keepalive that also spans device sleep (10s).
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
 * The variance-free screencast case, against the spec's own floor - what every
 * entry of both k-tables (the host's and the viewer's) is read through.
 *
 * A caller that floors on something other than the spec's literal (the JPEG
 * pump's stalled window floors on a value injected into the driver) calls
 * {@link deriveRttDeadlineMs} directly.
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
