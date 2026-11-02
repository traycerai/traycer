import { appLogger, describeLogError } from "@/lib/logger";

/**
 * Whether the voice is audibly speaking, read from the remote track itself:
 * the vendor emits no playback-done event, and its output transcript runs
 * ahead of the sound. The probe's meter: RMS above {@link SPEAKING_RMS} with
 * a {@link SPEAKING_HANGOVER_MS} hangover, sampled every {@link SAMPLE_MS}.
 */
export const SPEAKING_RMS = 0.01;
const SPEAKING_HANGOVER_MS = 500;
const SAMPLE_MS = 100;
const FFT_SIZE = 1024;

export interface AudioLevelWatch {
  /**
   * Stops watching. A watch that last reported speaking reports quiet on the
   * way out, so its contribution never outlives it; nothing fires after.
   */
  stop(): void;
}

/**
 * Watches `stream` and reports each change of the speaking state, and
 * whether its word can be trusted. A detector is HEALTHY only once its
 * context is running and it has observed signal on the stream at all: a
 * context that constructed but stays suspended, or an analyser that reads
 * silence from a stream that is sounding, is no detector, and `onHealthy`
 * says so until it proves otherwise. The consumer falls back to a
 * conservative hold while it is not trusted.
 */
export function watchAudioLevel(
  stream: MediaStream,
  onSpeaking: (speaking: boolean) => void,
  onHealthy: (healthy: boolean) => void,
): AudioLevelWatch {
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch (error) {
    appLogger.warn("[voice] audio level context failed", {
      error: describeLogError(error),
    });
    onHealthy(false);
    return { stop: () => undefined };
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let speaking = false;
  let stopped = false;
  let healthy = false;
  let observedSignal = false;
  let lastLoudAt = 0;
  onHealthy(false);
  if (context.state === "suspended") {
    void context.resume().catch((error: unknown) => {
      appLogger.warn("[voice] audio level context resume failed", {
        error: describeLogError(error),
      });
    });
  }
  const report = (next: boolean): void => {
    if (next === speaking) return;
    speaking = next;
    onSpeaking(speaking);
  };
  const reportHealth = (next: boolean): void => {
    if (next === healthy) return;
    healthy = next;
    onHealthy(healthy);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    if (rms > 0) observedSignal = true;
    reportHealth(context.state === "running" && observedSignal);
    const now = Date.now();
    if (rms >= SPEAKING_RMS) lastLoudAt = now;
    report(now - lastLoudAt < SPEAKING_HANGOVER_MS);
  }, SAMPLE_MS);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      report(false);
      reportHealth(false);
      source.disconnect();
      void context.close().catch((error: unknown) => {
        appLogger.warn("[voice] audio level context close failed", {
          error: describeLogError(error),
        });
      });
    },
  };
}
