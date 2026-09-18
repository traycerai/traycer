import type {
  ConnectionManifest,
  SchemaVersion,
} from "@traycer/protocol/framework/index";
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

/**
 * The STREAM counterpart of {@link NegotiatedManifestRecorder}: what a
 * subscribe on each named method would negotiate with this host, published at
 * the same `openAck`.
 *
 * A computed map rather than the peer's raw manifest, because a stream version
 * is not a manifest lookup - it is the result of checking the two manifests
 * against this composition's served majors, which only the session can do. A
 * method the pairing cannot bridge is ABSENT from the map rather than present
 * with a null, so a reader can tell "this host cannot serve it" from "this host
 * has not been asked yet".
 */
export type NegotiatedStreamVersionRecorder = (
  hostId: string,
  versions: ReadonlyMap<string, SchemaVersion>,
) => void;
