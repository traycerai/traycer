import type { BrowserViewWebContents } from "../browser-view-port";
import { describeLogError, log } from "../../app/logger";

/**
 * Records a tile's page as a sequence of JPEG frames.
 *
 * ## Why frames rather than a video file
 *
 * Main has no encoder. Producing an actual video here would mean either bundling
 * ffmpeg (a large binary, per platform, for one feature) or driving Chromium's
 * own capture APIs, which record a *tab* the user has to grant per session. The
 * renderer, on the other hand, already runs in a Chromium with `MediaRecorder`
 * and `canvas.captureStream` - so main produces frames and the renderer encodes
 * them into a real WebM. That split also keeps the expensive part where the user
 * can see it stop.
 *
 * ## Why it is paced by measurement, like the mirror
 *
 * `capturePage` costs what it costs on the host, and a fixed interval either
 * wastes a core or produces a slideshow. Each frame's own duration sets the delay
 * before the next, so a recording settles at whatever rate the machine sustains.
 * A recording is watched afterwards rather than live, so a slower-but-complete
 * capture is the right trade - unlike the mirror, this one never drops a frame to
 * keep up.
 *
 * ## Why it is bounded
 *
 * A recording nobody stops would grow until something failed. Both bounds are
 * hard stops that end the recording cleanly and tell the caller why, so a user
 * who walks away gets a usable file and an explanation rather than a crash.
 */
export interface BrowserRecordingFrame {
  readonly sequence: number;
  readonly jpegBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly capturedAtMs: number;
}

export type BrowserRecordingStopReason =
  | "requested"
  | "duration-limit"
  | "frame-limit"
  | "page-gone";

export interface BrowserRecordingStartInput {
  readonly quality: number;
  readonly onFrame: (frame: BrowserRecordingFrame) => void;
  readonly onStopped: (reason: BrowserRecordingStopReason) => void;
}

/** The cadence bounds, mirroring the mirror's for the same reason. */
const RECORDING_MIN_INTERVAL_MS = 40;
const RECORDING_MAX_INTERVAL_MS = 500;
/** Ten minutes: long enough for any reproduction, short enough to be a file. */
export const RECORDING_MAX_DURATION_MS = 10 * 60 * 1_000;
/** A second bound in frames, for a host fast enough to outrun the clock. */
export const RECORDING_MAX_FRAMES = 18_000;

type RecordingWebContents = Pick<
  BrowserViewWebContents,
  "capturePage" | "isDestroyed"
>;

interface ActiveRecording {
  readonly onFrame: (frame: BrowserRecordingFrame) => void;
  readonly onStopped: (reason: BrowserRecordingStopReason) => void;
  readonly startedAtMs: number;
  readonly quality: number;
  nextSequence: number;
  timer: NodeJS.Timeout | null;
}

/** Pace for the next capture given the last one's cost. */
export function recordingIntervalMs(lastCaptureMs: number): number {
  const cost = Number.isFinite(lastCaptureMs)
    ? Math.max(0, lastCaptureMs)
    : RECORDING_MAX_INTERVAL_MS;
  return Math.min(
    RECORDING_MAX_INTERVAL_MS,
    Math.max(RECORDING_MIN_INTERVAL_MS, Math.round(cost)),
  );
}

/**
 * Why a running recording must stop, or `null` to keep going.
 *
 * Pure so the bounds are testable without waiting ten minutes for one.
 */
export function recordingStopReason(input: {
  readonly elapsedMs: number;
  readonly frameCount: number;
  readonly pageGone: boolean;
}): BrowserRecordingStopReason | null {
  if (input.pageGone) return "page-gone";
  if (input.elapsedMs >= RECORDING_MAX_DURATION_MS) return "duration-limit";
  if (input.frameCount >= RECORDING_MAX_FRAMES) return "frame-limit";
  return null;
}

export class BrowserPageRecording {
  private readonly webContents: RecordingWebContents;
  private active: ActiveRecording | null = null;

  constructor(webContents: RecordingWebContents) {
    this.webContents = webContents;
  }

  isRecording(): boolean {
    return this.active !== null;
  }

  /** Answers whether a recording started; a second request is refused. */
  start(input: BrowserRecordingStartInput, nowMs: number): boolean {
    if (this.active !== null) return false;
    if (this.webContents.isDestroyed()) return false;
    const recording: ActiveRecording = {
      onFrame: input.onFrame,
      onStopped: input.onStopped,
      startedAtMs: nowMs,
      quality: input.quality,
      nextSequence: 0,
      timer: null,
    };
    this.active = recording;
    void this.captureFrame(recording);
    return true;
  }

  stop(reason: BrowserRecordingStopReason): void {
    const recording = this.active;
    if (recording === null) return;
    this.active = null;
    if (recording.timer !== null) clearTimeout(recording.timer);
    recording.onStopped(reason);
  }

  private async captureFrame(recording: ActiveRecording): Promise<void> {
    const startedAt = Date.now();
    const stop = recordingStopReason({
      elapsedMs: startedAt - recording.startedAtMs,
      frameCount: recording.nextSequence,
      pageGone: this.webContents.isDestroyed(),
    });
    if (stop !== null) {
      this.stop(stop);
      return;
    }
    try {
      const image = await this.webContents.capturePage();
      if (this.active !== recording) return;
      const jpegBytes = image.toJPEG(recording.quality);
      if (jpegBytes.byteLength > 0) {
        const size = image.getSize();
        recording.onFrame({
          sequence: recording.nextSequence,
          jpegBytes,
          width: size.width,
          height: size.height,
          capturedAtMs: startedAt,
        });
        recording.nextSequence += 1;
      }
    } catch (error) {
      // A single failed capture is a dropped frame, not a failed recording: a
      // page mid-navigation cannot be captured and is about to be captureable
      // again, and ending the recording there would lose everything before it.
      if (this.active === recording) {
        log.debug("[browser-view] recording frame failed", {
          ...describeLogError(error),
        });
      }
    }
    if (this.active !== recording) return;
    recording.timer = setTimeout(
      () => {
        recording.timer = null;
        void this.captureFrame(recording);
      },
      recordingIntervalMs(Date.now() - startedAt),
    );
  }
}
