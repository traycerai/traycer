/**
 * `speech.dictate@1.0` - on-device dictation.
 *
 * The renderer opens one subscription per dictation session, streams PCM16
 * mono audio as `audio` client frames (raw bytes ride the paired binary WS
 * frame), and on `flush` receives a final `transcript` frame followed by
 * `flushed`. The host buffers the whole utterance and decodes it with an
 * offline transducer (Sherpa ONNX, in a worker thread); nothing leaves the
 * device. Utterances are segmented client-side (mic start/stop), so there is no
 * server-side VAD.
 *
 * Mirrors `terminal.subscribe`'s frame conventions: every text frame declares
 * `hasBinaryPayload: false`; the single binary-carrying client frame (`audio`)
 * declares `hasBinaryPayload: true`.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

export const speechDictateOpenRequestSchema = z.object({
  // BCP-47-ish language hint or "auto". Single-language models may ignore it.
  language: z.string(),
  // Sample rate (Hz) of the PCM the client streams - the renderer's actual
  // AudioContext rate, which the browser may pin to the hardware rate (e.g.
  // 48000) regardless of the requested 16000. The host resamples to the
  // model's rate, so the client must report the true capture rate here.
  sampleRate: z.number().int().positive(),
});
export type SpeechDictateOpenRequest = z.infer<
  typeof speechDictateOpenRequestSchema
>;

export const speechDictateServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    ...textFrameFields,
    modelId: z.string(),
    sampleRate: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("transcript"),
    ...textFrameFields,
    text: z.string(),
    isFinal: z.boolean(),
  }),
  // Sent after a `flush`/`stop` once the host has finished transcribing all
  // buffered audio - the client waits for this before closing so a slow decode
  // never drops the final transcript.
  z.object({
    kind: z.literal("flushed"),
    ...textFrameFields,
  }),
  z.object({
    kind: z.literal("error"),
    ...textFrameFields,
    code: z.string(),
    message: z.string(),
  }),
]);
export type SpeechDictateServerFrame = z.infer<
  typeof speechDictateServerFrameSchema
>;

export const speechDictateClientFrameSchema = z.discriminatedUnion("kind", [
  // Raw PCM16 mono bytes ride the paired binary WS frame - the only client
  // frame that carries a binary payload.
  z.object({
    kind: z.literal("audio"),
    hasBinaryPayload: z.literal(true),
  }),
  // Finalize the utterance (user pressed stop / released push-to-talk): the
  // host transcribes the buffered audio and replies `flushed`. The renderer
  // then closes the socket, which ends the session (onClose).
  z.object({
    kind: z.literal("flush"),
    ...textFrameFields,
  }),
]);
export type SpeechDictateClientFrame = z.infer<
  typeof speechDictateClientFrameSchema
>;

export const speechDictateV10 = defineStreamRpcContract({
  method: "speech.dictate",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: speechDictateOpenRequestSchema,
  serverFrameSchema: speechDictateServerFrameSchema,
  clientFrameSchema: speechDictateClientFrameSchema,
});
