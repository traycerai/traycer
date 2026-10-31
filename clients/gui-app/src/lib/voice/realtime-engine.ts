import {
  VoiceEngineError,
  type VoiceEngine,
  type VoiceEngineConnectInput,
} from "./engine";

/**
 * The fallback engine's place behind the seam: the vendor's turn-based
 * realtime model with native tools, should the live model's delegation
 * contract change. Not built; every method refuses with `NOT_IMPLEMENTED`
 * so the seam's full surface exists for it and a consumer that reaches it
 * fails loudly rather than silently doing nothing.
 */
export function createRealtimeEngine(): VoiceEngine {
  const refuse = (): never => {
    throw new VoiceEngineError(
      "NOT_IMPLEMENTED",
      "The realtime voice engine is not implemented.",
    );
  };
  return {
    connect: (_input: VoiceEngineConnectInput): Promise<void> =>
      Promise.reject(
        new VoiceEngineError(
          "NOT_IMPLEMENTED",
          "The realtime voice engine is not implemented.",
        ),
      ),
    appendCommentary: refuse,
    appendThinking: refuse,
    close: refuse,
  };
}
