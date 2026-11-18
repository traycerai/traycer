import {
  isRecordObservation,
  preferLiveOverRecord,
  projectFleetUpdateView,
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateObservation,
  type FleetUpdateRecordObservation,
  type FleetUpdateView,
  type FleetUpdateWireObservation,
  type LocalUpdateClock,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * The record leg, as ONE function: pick between the two observations, then
 * project the winner.
 *
 * Two surfaces consume the durable record for this machine's host — the
 * landing banner's hook and the selected-host Overview — and before this
 * existed only the first of them did. The Overview called
 * `projectFleetUpdateView` directly with the wire observation alone, so the two
 * surfaces disagreed about the same host in exactly the window the record leg
 * is for. Adding a second copy of the pair there would have been the same
 * disagreement with more code: the precedence rule and the clock it is
 * evaluated against have to be one decision, or the banner and the Overview can
 * hold different opinions about which observation won.
 *
 * ## The RECORD leg gets a ticking clock; the WIRE leg keeps its own instant
 *
 * A holder probe's proof has a five-second life (`LOCAL_LIVENESS_PROOF_MS`),
 * and the thing that must age it out is a clock that keeps running while the
 * host is down, because "the host is down" is the whole situation the proof is
 * used in. Neither timestamp within reach can do that job:
 * `statusQuery.dataUpdatedAt` stops advancing because the host is down, and the
 * controller query's own `dataUpdatedAt` stops too — Desktop's status
 * broadcaster keeps its idle loop running through a failing `publish()`, so
 * nothing new lands in a cache with `staleTime: Infinity` and the payload
 * saying `liveness: "live"` sits there indefinitely. A deadline measured
 * against either would never arrive, and the lifecycle gate would be held by a
 * proof nobody is refreshing. So the record leg is evaluated against a renderer
 * tick, and expiry lands on the first tick AFTER the deadline rather than at an
 * exact five-second wall — a coarser clock that cannot stop.
 *
 * The WIRE leg must NOT be evaluated against that tick, and this helper briefly
 * made that mistake by taking one instant for both. The wire read's
 * `freshUntilMs` was derived from the query's own `dataUpdatedAt` with the
 * query's health already folded in, so measuring it against that same instant
 * is not a vacuous comparison — it is the statement that a HEALTHY read is
 * fresh and only health demotes it. Measured against a ticking clock it becomes
 * a race against the round trip: one `host.status` slower than the fresh window
 * (2.5 × the poll delay, so 5 s while the accelerator holds the poll at 2 s)
 * demotes a live attempt to "last seen", DROPS the page-wide lifecycle gate, and disengages
 * the accelerator that was keeping the poll fast — repeating every cycle, on a
 * host that is merely far away. A gate that blinks open mid-apply is the exact
 * failure the gate exists to prevent.
 *
 * Hence {@link LocalUpdateClock}: two named instants, and the projection routes
 * each observation to the one that can answer for it.
 */
export interface LocalUpdateProjection {
  /**
   * Which observation won, or `null` when there was nothing to choose from.
   *
   * Returned beside the view because callers need to know WHICH leg they are
   * rendering, not only what it says: the Overview's pre-@1.3 lifecycle-gate
   * fallback reads the coarse `updateProgress` marker, and that fallback is
   * about a wire frame from a peer that could not report an attempt — it must
   * not be reached for a record-derived view, whose `kind` is already the
   * whole answer.
   */
  readonly observation: FleetUpdateObservation | null;
  /** {@link UNKNOWN_FLEET_UPDATE_VIEW} when `observation` is `null`. */
  readonly view: FleetUpdateView;
}

export function projectLocalUpdate(input: {
  readonly wire: FleetUpdateWireObservation | null;
  readonly record: FleetUpdateRecordObservation | null;
  /** See the note above: the record leg ticks, the wire leg does not. */
  readonly clock: LocalUpdateClock;
  readonly connected: boolean;
}): LocalUpdateProjection {
  const observation = preferLiveOverRecord(
    input.wire,
    input.record,
    input.clock,
  );
  if (observation === null) {
    return { observation: null, view: UNKNOWN_FLEET_UPDATE_VIEW };
  }
  return {
    observation,
    view: projectFleetUpdateView({
      observation,
      // The whole split, in one expression: `projectFleetUpdateView` asks the
      // clock exactly one question per arm — "has this record's proof expired"
      // or "has this wire read gone stale" — so the winner names which instant
      // is entitled to answer. Handing it a single clock is what let the wire
      // arm inherit the record arm's tick.
      nowMs: isRecordObservation(observation)
        ? input.clock.recordNowMs
        : input.clock.wireNowMs,
      connected: input.connected,
    }),
  };
}
