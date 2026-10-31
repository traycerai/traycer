/**
 * The voice engine seam: everything the app needs from the speech vendor, and
 * nothing of the vendor's own. The app's one engine today is
 * `gpt-live-engine.ts`; `realtime-engine.ts` is the fallback's place. Nothing
 * outside `lib/voice/` imports a vendor type, and nothing in here names one.
 *
 * The contract is full duplex: the person's microphone goes in as one track,
 * the voice comes back as one remote stream, and the events below are the
 * only facts the app learns about the conversation. The app never sees audio
 * and keeps no transcript beyond what the store holds for one utterance.
 */

/**
 * What the engine reports, in the order the session produces it. Every
 * handler is required: a consumer that cares about none of a fact passes a
 * no-op, so an added fact cannot be silently ignored.
 */
export interface VoiceEngineEvents {
  /** A fragment of what the person said, as the vendor transcribed it. */
  readonly onInputTranscriptDelta: (text: string) => void;
  /** A fragment of what the voice said. */
  readonly onOutputTranscriptDelta: (text: string) => void;
  /**
   * The vendor handed a spoken request to the app: the utterance boundary.
   * The id is the delegation's, which the app's commentary and thinking
   * appends about that request name.
   */
  readonly onDelegationCreated: (delegationId: string) => void;
  /** The vendor's periodic usage report. */
  readonly onUsage: (usage: VoiceUsage) => void;
  /**
   * The session is over, from either side. Fires once, after which no other
   * event does; the engine's own `close` ends in this event too.
   */
  readonly onClosed: (reason: VoiceEngineCloseReason) => void;
}

export interface VoiceUsage {
  /** Billed seconds so far, cumulative. */
  readonly seconds: number;
  /**
   * How full the session's context is, 0 to 1; `null` when the vendor did
   * not say. The app re-mints before the vendor's own replacement point.
   */
  readonly contextUsageRatio: number | null;
}

export type VoiceEngineCloseReason =
  /** The app asked (`close`). */
  | "app"
  /** The vendor ended the session on its own (its cap, a server-side close). */
  | "vendor"
  /** The peer connection dropped. */
  | "connection"
  /** The data channel or the exchange failed before the session was up. */
  | "failed";

/**
 * The SDP exchange the app performs on the engine's behalf: the engine
 * produces an offer, the app's server mints the session and answers it. The
 * function resolves with the answer SDP alone; everything else the server
 * said about the session is the app's to keep.
 */
export type VoiceSdpExchange = (offerSdp: string) => Promise<string>;

export interface VoiceEngineConnectInput {
  /** The person's microphone, one audio track. The engine never stops it. */
  readonly micTrack: MediaStreamTrack;
  readonly exchangeSdp: VoiceSdpExchange;
  /** The voice's audio, once the peer delivers it. */
  readonly onRemoteAudio: (stream: MediaStream) => void;
  readonly events: VoiceEngineEvents;
}

/**
 * One voice session, start to end. `connect` resolves once the vendor
 * reports the session started; it rejects, with `onClosed("failed")` already
 * delivered, when the exchange or the peer fails first.
 */
export interface VoiceEngine {
  connect(input: VoiceEngineConnectInput): Promise<void>;
  /**
   * Gives the voice something to say: prose it paraphrases for the person.
   * Under a delegation id it is the answer to that request; under `null` it is
   * an interjection about something else.
   */
  appendCommentary(text: string, delegationId: string | null): void;
  /**
   * State the voice needs about a request and must not say (where the post
   * landed, that it is queued). Always under the request's delegation.
   */
  appendThinking(text: string, delegationId: string): void;
  /**
   * Ends the session from the app's side: asks the vendor to close, waits
   * briefly for its confirmation, then tears the peer down. Idempotent.
   */
  close(): void;
}

/** A factory, so the controller picks an engine without naming its module. */
export type VoiceEngineFactory = () => VoiceEngine;

export class VoiceEngineError extends Error {
  constructor(
    readonly code:
      | "NOT_IMPLEMENTED"
      | "EXCHANGE_FAILED"
      | "PEER_FAILED"
      | "NOT_CONNECTED",
    message: string,
  ) {
    super(message);
    this.name = "VoiceEngineError";
  }
}
