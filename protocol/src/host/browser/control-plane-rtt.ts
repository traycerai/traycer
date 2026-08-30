/**
 * The one derivation both ends of the screencast contract size their deadlines
 * with (ticket 18).
 *
 * The host measures the control-plane round trip (`rttProbe`/`rttProbeAck` in
 * `./contracts`) and stamps its smoothed estimate on every probe, so the viewer
 * reads the same number without measuring anything. What lives HERE is only the
 * arithmetic - what each side spends it on stays on that side, as one k-table
 * per side, because the windows are not the same windows.
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
 * `max(floorMs, roundTrips x rtt)`.
 *
 * `rttMs === null` - nothing measured yet, no video plane, a peer too old to
 * answer a probe - returns the floor unchanged, which is what makes every call
 * site behave exactly as the literal it replaced until a measurement exists.
 * Measurement can only ever lengthen a window, never shorten one.
 *
 * `floorMs` is passed rather than read off the spec because one consumer (the
 * JPEG pump's stalled window) floors on a value injected into the driver, not
 * on a constant.
 */
export function deriveDeadlineMs(
  spec: ControlPlaneDeadlineSpec,
  rttMs: number | null,
  floorMs: number,
): number {
  if (rttMs === null) return floorMs;
  const clamped = Math.min(Math.max(rttMs, 0), MAX_CONTROL_PLANE_RTT_MS);
  return Math.max(floorMs, Math.round(spec.roundTrips * clamped));
}
