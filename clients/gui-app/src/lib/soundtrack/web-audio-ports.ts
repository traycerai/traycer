import { appLogger, describeLogError } from "@/lib/logger";
import { WebAudioDimFilter, WebAudioLevel, WebAudioOutput } from "./output";
import type { SoundtrackPorts } from "./session";
import { ManifestStemSource, type StemManifest } from "./stems";

// Closing cuts what is still on its way to the speakers, which over Bluetooth
// is a few hundred milliseconds of a fade that has finished on the clock.
const CLOSE_AFTER_FADE_SECONDS = 0.5;

/**
 * Opens the audio device: speakers ← volume ← a chime's duck ← low-pass ← the
 * mix. Only ever call this from a gesture of the person's, because the
 * `AudioContext` constructor can block the thread for 20 seconds on a Mac with
 * no output (see `lib/notifications/notification-chime.ts`), and because a
 * context made without one starts suspended. It throws where there is no audio
 * to open.
 */
export function openWebAudioPorts(
  stems: StemManifest,
  volume: number,
): SoundtrackPorts {
  const context = new AudioContext();
  const level = new WebAudioLevel(context, context.destination, volume);
  const dim = new WebAudioDimFilter(context, level.input);
  const output = new WebAudioOutput(context, dim.input);
  if (context.state === "suspended") {
    void context.resume().catch((error: unknown) => {
      appLogger.warn("[soundtrack] could not resume the audio context", {
        error: describeLogError(error),
      });
    });
  }
  return {
    output,
    stems: new ManifestStemSource(stems, output),
    setDimmed: (dimmed) => {
      dim.setDimmed(dimmed);
    },
    setVolume: (next) => {
      level.setVolume(next);
    },
    duck: (chimeSeconds) => {
      level.duck(chimeSeconds);
    },
    close: (afterSeconds) => {
      window.setTimeout(
        () => {
          void context.close().catch((error: unknown) => {
            appLogger.warn("[soundtrack] could not close the audio context", {
              error: describeLogError(error),
            });
          });
        },
        (afterSeconds + CLOSE_AFTER_FADE_SECONDS) * 1000,
      );
    },
  };
}
