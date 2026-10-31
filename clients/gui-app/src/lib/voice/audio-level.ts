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

export interface AudioLevelWatch {
  /**
   * Whether the detector is actually listening. `false` when the browser
   * refused the audio context: `onSpeaking` then never fires, and the
   * scheduler must not read its silence as quiet.
   */
  readonly available: boolean;
  /**
   * Stops watching. A watch that last reported speaking reports quiet on the
   * way out, so its contribution never outlives it; nothing fires after.
   */
  stop(): void;
}

/** Watches `stream` and reports each change of the speaking state. */
export function watchAudioLevel(
  stream: MediaStream,
  onSpeaking: (speaking: boolean) => void,
): AudioLevelWatch {
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch (error) {
    appLogger.warn("[voice] audio level context failed", {
      error: describeLogError(error),
    });
    return { available: false, stop: () => undefined };
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let speaking = false;
  let stopped = false;
  let lastLoudAt = 0;
  const report = (next: boolean): void => {
    if (next === speaking) return;
    speaking = next;
    onSpeaking(speaking);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (rms >= SPEAKING_RMS) lastLoudAt = now;
    report(now - lastLoudAt < SPEAKING_HANGOVER_MS);
  }, SAMPLE_MS);
  return {
    available: true,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      report(false);
      source.disconnect();
      void context.close().catch((error: unknown) => {
        appLogger.warn("[voice] audio level context close failed", {
          error: describeLogError(error),
        });
      });
    },
  };
}
