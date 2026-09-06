import {
  preferLiveOverRecord,
  projectFleetUpdateView,
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateObservation,
  type FleetUpdateRecordObservation,
  type FleetUpdateView,
  type FleetUpdateWireObservation,
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
 * ## `nowMs` is a TICKING clock, and that is the point
 *
 * Both call sites used to pass `statusQuery.dataUpdatedAt` — the instant the
 * last `host.status` succeeded — which made every staleness comparison in the
 * projection vacuous (a deadline derived from an instant can never be outrun by
 * that same instant) and, more importantly, froze exactly when it needed to
 * move. A holder probe's proof has a five-second life
 * (`LOCAL_LIVENESS_PROOF_MS`); the thing that must age it out is a clock that
 * keeps running while the host is down, because "the host is down" is the whole
 * situation the proof is used in.
 *
 * The publisher does not save us either: Desktop's status broadcaster keeps its
 * idle loop running through a failing `publish()`, so nothing new lands in the
 * controller query, `dataUpdatedAt` stops advancing, and the payload carrying
 * `liveness: "live"` sits in a cache with `staleTime: Infinity` indefinitely. A
 * deadline measured against that timestamp would therefore never arrive — the
 * proof would hold the lifecycle gate for as long as the surface stayed
 * mounted.
 *
 * So callers pass a renderer tick. The visible consequence is that expiry lands
 * on the first tick AFTER the deadline rather than at an exact five-second
 * wall, which is the intended trade: a coarser clock that cannot stop.
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
  /** A ticking clock. See the note above; never a query's `dataUpdatedAt`. */
  readonly nowMs: number;
  readonly connected: boolean;
}): LocalUpdateProjection {
  const observation = preferLiveOverRecord(
    input.wire,
    input.record,
    input.nowMs,
  );
  if (observation === null) {
    return { observation: null, view: UNKNOWN_FLEET_UPDATE_VIEW };
  }
  return {
    observation,
    view: projectFleetUpdateView({
      observation,
      nowMs: input.nowMs,
      connected: input.connected,
    }),
  };
}
