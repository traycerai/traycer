import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type { ServedMajorsByMethod } from "@traycer/protocol/framework/capability-manifest";

/** Probe sizing for {@link IRemoteSession.wake}. */
export type WakeProbeTuning = {
  readonly timeoutMs: number;
  readonly immediateRedialOnFailure: boolean;
};

export type ServerClockVerdict = "unknown" | "ok" | "skewed";

export interface ServerClockState {
  readonly verdict: ServerClockVerdict;
}

/**
 * Runtime-neutral wall-clock trust signal. Client transports wrap the shared
 * tracker; host dialers pass `null`.
 */
export interface ServerClockSkewSignal {
  canMakeValidBearersLookExpired(): boolean;
  currentState(): ServerClockState;
  subscribeToRecovery(listener: () => void): () => void;
}

export function clockSkewStreamReason(state: ServerClockState): string {
  return state.verdict;
}

export type ServedStreamMajors = ServedMajorsByMethod;

export type NegotiatedManifestRecorder = (
  hostId: string,
  manifest: ConnectionManifest,
) => void;
