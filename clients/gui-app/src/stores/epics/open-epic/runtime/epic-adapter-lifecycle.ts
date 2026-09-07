/**
 * Ordered steps for a mid-session adapter change: detach superseded, then reset,
 * then bump generation, then attach. First install and unknown produce no steps.
 */
import type { ReplicaResetCause } from "@traycer-clients/shared/replica-runtime";
import {
  epicAdapterFingerprint,
  settleEpicAdapterArm,
  type EpicAdapterArm,
  type EpicAdapterVerdict,
} from "./epic-adapter-selection";

/** The reset every manifest-driven replacement carries. Keep this the only spelling. */
export const MANIFEST_CHANGED_RESET: ReplicaResetCause = {
  origin: "authority",
  reason: "manifest-changed",
};

/** One step in execution order. Reset without a preceding detach lets old frames land in the rebuilt replica. */
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

/** Pure total transition from installed arm to the manifest's arm. */
export function planEpicAdapterTransition(
  installed: EpicAdapterArm | null,
  verdict: EpicAdapterVerdict,
): EpicAdapterTransition {
  const next = settleEpicAdapterArm(installed, verdict);
  if (next === null) {
    // Undecided with nothing installed: attach nothing, and in particular do not open
    // `epic.subscribe@1` speculatively.
    return { installed: null, fingerprint: null, steps: [] };
  }
  if (next === installed) {
    // Either the manifest said the same thing, or it said nothing and the HOLD rule kept what was
    // there. No steps: a fingerprint that has not moved must not cost a replacement.
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
