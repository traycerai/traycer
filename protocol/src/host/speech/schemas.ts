/**
 * Shared shapes for the host-hosted speech-to-text (dictation) surface.
 *
 * Dictation runs entirely on-device inside the host (Sherpa ONNX): the
 * renderer streams PCM16 mono audio over `speech.dictate`, the host buffers
 * the utterance and decodes it with an offline transducer in a worker thread.
 * Models are downloaded once into `~/.traycer/models/stt/`; the unary contracts
 * (`speech.getModelStatus` / `speech.ensureModel`) drive that lifecycle so the
 * mic only appears once the model is ready.
 *
 * Allowed dependencies: `zod` and other protocol modules only - browser-safe.
 */
import { z } from "zod";

// The model's expected PCM rate: 16 kHz mono 16-bit little-endian. The renderer
// captures at its AudioContext rate (which the browser may pin to the hardware
// rate) and reports that rate on the wire; the host resamples to this.
export const SPEECH_INPUT_SAMPLE_RATE = 16000;

export const speechDownloadStateSchema = z.enum([
  "absent",
  "downloading",
  "ready",
  "error",
]);
export type SpeechDownloadState = z.infer<typeof speechDownloadStateSchema>;

// On-disk model state, as reported by the model manager.
export const speechModelDiskStatusSchema = z.object({
  modelId: z.string(),
  installed: z.boolean(),
  downloadState: speechDownloadStateSchema,
  // 0..1 while `downloadState === "downloading"`, otherwise null.
  downloadProgress: z.number().nullable(),
  // On-disk size of the resolved model directory once installed, else null.
  sizeBytes: z.number().nullable(),
  // Populated only when `downloadState === "error"`.
  errorMessage: z.string().nullable(),
});
export type SpeechModelDiskStatus = z.infer<typeof speechModelDiskStatusSchema>;

// Full status the `speech.*` RPCs return: disk state plus whether the on-device
// engine (sherpa addon) is even available on this build/platform. The renderer
// gates the mic on `engineAvailable && downloadState === "ready"`, so it never
// downloads a model or prompts for the mic where dictation can't run.
export const speechModelStatusSchema = speechModelDiskStatusSchema.extend({
  engineAvailable: z.boolean(),
});
export type SpeechModelStatus = z.infer<typeof speechModelStatusSchema>;
