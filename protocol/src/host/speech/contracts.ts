/**
 * Unary `speech.*` RPC contracts for the on-device dictation model lifecycle.
 *
 * The live audio stream is carried by the `speech.dictate` streaming contract
 * (co-located in `./subscribe.ts`). These contracts only manage the model
 * files the recognizer needs: a status read and an idempotent "ensure
 * downloaded" trigger. Schemas live in `./schemas.ts`.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { speechModelStatusSchema } from "@traycer/protocol/host/speech/schemas";

// `speech.getModelStatus@1.0` - reports whether the dictation model is present
// on disk and, while downloading, how far along. `modelId: null` selects the
// host's default model.
export const speechGetModelStatusRequestSchema = z.object({
  modelId: z.string().nullable(),
});
export type SpeechGetModelStatusRequest = z.infer<
  typeof speechGetModelStatusRequestSchema
>;

export const speechGetModelStatusResponseSchema = speechModelStatusSchema;
export type SpeechGetModelStatusResponse = z.infer<
  typeof speechGetModelStatusResponseSchema
>;

// `speech.ensureModel@1.0` - idempotently kicks off the model download and
// returns the status snapshot immediately; the renderer polls
// `speech.getModelStatus` for progress and completion.
export const speechEnsureModelRequestSchema = z.object({
  modelId: z.string().nullable(),
});
export type SpeechEnsureModelRequest = z.infer<
  typeof speechEnsureModelRequestSchema
>;

export const speechEnsureModelResponseSchema = speechModelStatusSchema;
export type SpeechEnsureModelResponse = z.infer<
  typeof speechEnsureModelResponseSchema
>;

export const speechGetModelStatusV10 = defineRpcContract({
  method: "speech.getModelStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: speechGetModelStatusRequestSchema,
  responseSchema: speechGetModelStatusResponseSchema,
});

export const speechEnsureModelV10 = defineRpcContract({
  method: "speech.ensureModel",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: speechEnsureModelRequestSchema,
  responseSchema: speechEnsureModelResponseSchema,
});

// `speechDictateV10` is intentionally NOT re-exported here - it lives in
// `./subscribe.ts` and the barrel (`./index.ts`) already surfaces it from there.
// Re-exporting it would duplicate it on the barrel.
