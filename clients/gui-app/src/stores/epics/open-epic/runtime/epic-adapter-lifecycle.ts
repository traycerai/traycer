/**
 * What HAPPENS when a connection's adapter selection changes - the mid-session
 * host upgrade, expressed as a state machine rather than as an ordering the
 * runtime has to remember.
 *
 * Every long-lived tab hits this exactly once, which the seam's own doc calls
 * out as "the single most likely path to ship untested". So the transition is
 * modelled as data: given what is installed and what the manifest now says,
 * this answers with the ORDERED steps to take. The runtime executes them; it
 * does not decide them, and a test can assert the decision without a socket.
 *
 * ## Why the steps are ordered and not a set
 *
 * The order is the contract, and it is the same order every replacement in this
 * runtime already uses:
 *
 *  1. **detach the outgoing adapters with `"superseded"`** - not `"disposed"`
 *     (the session is not going away) and not `"transport-only"` (the replica
 *     is not being retained). A different adapter set is taking over this lane,
 *     which is exactly what that member means. Detaching FIRST is what stops a
 *     frame from the old set landing in the rebuilt replica.
 *  2. **reset the replicas** with `{origin: "authority", reason:
 *     "manifest-changed"}`. Authority-origin because the host's manifest
 *     changed under us - this is not a client-requested reseed, and passing a
 *     client intent would put a fabricated provenance into logs and the replay
 *     harness.
 *  3. **bump the replica generation**, so the consumer republishes the live
 *     `Y.Doc` / `Awareness` handles it holds by reference.
 *  4. **attach the incoming set**, which takes fresh snapshots because a reset
 *     replica offers no resume cursor.
 *
 * ## The first install is NOT a replacement
 *
 * Installing an arm where none was installed detaches nothing, resets nothing
 * and bumps nothing - there is no replica to replace and no generation anyone
 * has observed. Treating it as a replacement would make every cold open emit an
 * `authority` reset before its first frame, which is a fabricated authority
 * event on the most ordinary path there is.
 *
 * ## Holding through unknown
 *
 * An undecided verdict produces NO steps at all, which is what makes a
 * reconnect safe: `WsStreamClient.resetMethodSupport` clears the whole support
 * map on every reconnect, so a healthy reconnect on a lane host passes through
 * a window where every lane method reads `"unknown"`. Emitting a replacement
 * there would tear down and rebuild the replica twice for a link that never
 * changed.
 */
import type { ReplicaResetCause } from "@traycer-clients/shared/replica-runtime";
import {
  epicAdapterFingerprint,
  settleEpicAdapterArm,
  type EpicAdapterArm,
  type EpicAdapterVerdict,
} from "./epic-adapter-selection";

/**
 * The reset every manifest-driven replacement carries.
 *
 * A module constant rather than a literal at the call site: `"manifest-changed"`
 * is one of six `ReplicaReplacementReason` members and the only one that means
 * "the host started or stopped serving the lanes", so a second literal
 * somewhere else is a second answer to the same question.
 */
export const MANIFEST_CHANGED_RESET: ReplicaResetCause = {
  origin: "authority",
  reason: "manifest-changed",
};

/**
 * One step in a selection transition, in the order it must be executed.
 *
 * A closed union rather than a bag of booleans, because the steps are not
 * independent: a reset without a preceding detach lets the old set's next frame
 * land in the rebuilt replica, and an attach before the reset seeds a replica
 * that is about to be emptied.
 */
export type EpicAdapterTransitionStep =
  | { readonly kind: "detach"; readonly arm: EpicAdapterArm }
  | { readonly kind: "reset"; readonly cause: ReplicaResetCause }
  | { readonly kind: "bump-generation" }
  | { readonly kind: "attach"; readonly arm: EpicAdapterArm };

export interface EpicAdapterTransition {
  /** What is installed after these steps run. `null` while undecided. */
  readonly installed: EpicAdapterArm | null;
  /** The fingerprint of {@link installed}, or `null` when nothing is installed. */
  readonly fingerprint: string | null;
  /** Empty when nothing changes - the overwhelmingly common case. */
  readonly steps: readonly EpicAdapterTransitionStep[];
}

/**
 * Decide the transition from what is installed to what the manifest now says.
 *
 * Pure and total: the same inputs always produce the same steps, and there is
 * no arm it declines to answer for. That is what lets the mid-session upgrade
 * be asserted as a value rather than reconstructed from spy call order.
 */
export function planEpicAdapterTransition(
  installed: EpicAdapterArm | null,
  verdict: EpicAdapterVerdict,
): EpicAdapterTransition {
  const next = settleEpicAdapterArm(installed, verdict);
  if (next === null) {
    // Undecided with nothing installed: attach nothing, and in particular do
    // not open `epic.subscribe@1` speculatively. The status-lane probe is what
    // resolves this, and it is the runtime's first action.
    return { installed: null, fingerprint: null, steps: [] };
  }
  if (next === installed) {
    // Either the manifest said the same thing, or it said nothing and the HOLD
    // rule kept what was there. No steps: a fingerprint that has not moved must
    // not cost a replacement.
    return {
      installed: next,
      fingerprint: epicAdapterFingerprint(next),
      steps: [],
    };
  }
  if (installed === null) {
    // First install. Nothing to detach, nothing to reset, and no generation
    // anyone has observed yet.
    return {
      installed: next,
      fingerprint: epicAdapterFingerprint(next),
      steps: [{ kind: "attach", arm: next }],
    };
  }
  return {
    installed: next,
    fingerprint: epicAdapterFingerprint(next),
    steps: [
      { kind: "detach", arm: installed },
      { kind: "reset", cause: MANIFEST_CHANGED_RESET },
      { kind: "bump-generation" },
      { kind: "attach", arm: next },
    ],
  };
}
