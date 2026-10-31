import { appLogger, describeLogError } from "@/lib/logger";

/**
 * Whether the voice is audibly speaking, read from the remote track itself:
 * the vendor emits no playback-done event, and its output transcript runs
 * ahead of the sound. The probe's meter: RMS above {@link SPEAKING_RMS} with
 * a {@link SPEAKING_HANGOVER_MS} hangover, sampled every {@link SAMPLE_MS}.
 */
export const SPEAKING_RMS = 0.01;
export const SPEAKING_HANGOVER_MS = 500;
const SAMPLE_MS = 100;
const FFT_SIZE = 1024;

/**
 * Watches `stream` and reports each change of the speaking state. Returns the
 * stop function; stopping closes the context it opened. A browser that
 * refuses the context leaves `onSpeaking` silent, which the scheduler reads as
 * "not playing" and falls back to the output transcript's hangover.
 */
export function watchAudioLevel(
  stream: MediaStream,
  onSpeaking: (speaking: boolean) => void,
): () => void {
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch (error) {
    appLogger.warn("[voice] audio level context failed", {
      error: describeLogError(error),
    });
    return () => undefined;
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let speaking = false;
  let lastLoudAt = 0;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (rms >= SPEAKING_RMS) lastLoudAt = now;
    const next = now - lastLoudAt < SPEAKING_HANGOVER_MS;
    if (next !== speaking) {
      speaking = next;
      onSpeaking(speaking);
    }
  }, SAMPLE_MS);
  return () => {
    clearInterval(timer);
    source.disconnect();
    void context.close().catch((error: unknown) => {
      appLogger.warn("[voice] audio level context close failed", {
        error: describeLogError(error),
      });
    });
  };
}
