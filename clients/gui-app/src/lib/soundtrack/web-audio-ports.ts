import { appLogger, describeLogError } from "@/lib/logger";
import { reissueStemManifest } from "./manifest";
import { MIX_TUNING } from "./mix-tuning";
import { WebAudioDimFilter, WebAudioLevel, WebAudioOutput } from "./output";
import type { SoundtrackPorts } from "./session";
import { SoundtrackLogRelay } from "./session-log";
import { ManifestStemSource, type StemManifest } from "./stems";

// Closing or suspending cuts what is still on its way to the speakers, which
// over Bluetooth is a few hundred milliseconds of a fade that has finished on
// the clock.
const DRAIN_AFTER_FADE_SECONDS = 0.5;

/**
 * The rate the mix runs at, asked for rather than taken from the device.
 *
 * A recording encodes Opus, which is a 48 kHz codec, and the capture refuses
 * any other rate instead of resampling behind the file's back: 48 kHz here is
 * what makes a captured frame and an encoded sample the same thing. The device
 * may well be at 44.1 kHz, in which case the context resamples on its way to
 * the speakers, which is the right place for it to happen.
 */
const MIX_SAMPLE_RATE = 48_000;

/**
 * Opens the audio device: speakers ← volume ← a chime's duck ← low-pass ← the
 * mix. A recording takes its copy where the low-pass hands over. Only ever call
 * this from a gesture of the person's, because the `AudioContext` constructor
 * can block the thread for 20 seconds on a Mac with no output (see
 * `lib/notifications/notification-chime.ts`), and because a context made without
 * one starts suspended. It throws where there is no audio to open.
 */
export function openWebAudioPorts(
  stems: StemManifest,
  volume: number,
): SoundtrackPorts {
  const context = new AudioContext({ sampleRate: MIX_SAMPLE_RATE });
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
  let suspending: number | null = null;
  const cancelSuspending = (): void => {
    if (suspending !== null) window.clearTimeout(suspending);
    suspending = null;
  };
  return {
    output,
    stems: new ManifestStemSource(stems, output, reissueStemManifest),
    setDimmed: (dimmed) => {
      dim.setDimmed(dimmed);
    },
    setVolume: (next) => {
      level.setVolume(next);
    },
    duck: (chimeSeconds) => {
      level.duck(chimeSeconds);
    },
    log: new SoundtrackLogRelay(),
    captureMix: async (quality) => {
      const { openMixCapture } = await import("./mix-capture");
      return openMixCapture(context, (node) => dim.tap(node), quality);
    },
    pause: () => {
      level.setAudible(false);
      suspending = window.setTimeout(
        () => {
          suspending = null;
          void context.suspend().catch((error: unknown) => {
            appLogger.warn("[soundtrack] could not suspend the audio context", {
              error: describeLogError(error),
            });
          });
        },
        (MIX_TUNING.pauseFadeSeconds + DRAIN_AFTER_FADE_SECONDS) * 1000,
      );
    },
    resume: (onRefused) => {
      cancelSuspending();
      void context.resume().catch((error: unknown) => {
        appLogger.warn("[soundtrack] could not resume the audio context", {
          error: describeLogError(error),
        });
        onRefused();
      });
      level.setAudible(true);
    },
    close: (afterSeconds) => {
      cancelSuspending();
      window.setTimeout(
        () => {
          void context.close().catch((error: unknown) => {
            appLogger.warn("[soundtrack] could not close the audio context", {
              error: describeLogError(error),
            });
          });
        },
        (afterSeconds + DRAIN_AFTER_FADE_SECONDS) * 1000,
      );
    },
  };
}
