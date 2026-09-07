/** Which way a pulse travels along a drawn edge. */
import type {
  CommGraphPulse,
  CommGraphPulseKind,
} from "@/lib/comm-graph/comm-graph-timeline";

export interface CommGraphEdgeTravel {
  readonly kind: CommGraphPulseKind;
  /** True when the message runs target→source along the drawn path. */
  readonly reversed: boolean;
}

/**
 * `null` when this pulse is not a traveling one for THIS edge: a node pulse (a half-edge whose counterpart is off-canvas), a pulse on another pair, or no pulse at all.
 */
export function commGraphEdgeTravel(
  pulse: CommGraphPulse | null,
  edgeId: string,
  sourceAgentId: string,
  targetAgentId: string,
): CommGraphEdgeTravel | null {
  if (pulse === null) return null;
  if (pulse.kind !== "edge") return null;
  if (pulse.edgeId !== edgeId) return null;
  // A pulse whose endpoints are not this edge's endpoints is not describable as a traversal of it.
  // Should not happen - the pair id is derived from the same two ids - but guessing a direction would be worse than declining to animate.
  if (
    pulse.fromAgentId === sourceAgentId &&
    pulse.toAgentId === targetAgentId
  ) {
    return { kind: pulse.pulseKind, reversed: false };
  }
  if (
    pulse.fromAgentId === targetAgentId &&
    pulse.toAgentId === sourceAgentId
  ) {
    return { kind: pulse.pulseKind, reversed: true };
  }
  return null;
}

/**
 * SVG `keyPoints` for `<animateMotion>`: the fraction of the path at each key time.
 * Reversing the travel is a matter of walking the SAME path backwards, not of computing a second path - so the geometry stays single-sourced in `commGraphEdgeEndpoints`.
 */
export function commGraphTravelKeyPoints(reversed: boolean): string {
  return reversed ? "1;0" : "0;1";
}
