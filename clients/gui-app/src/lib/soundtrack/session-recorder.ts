import { appLogger, describeLogError } from "@/lib/logger";
import type { MixDirectorId } from "./directors";
import type { SoundtrackManifest } from "./manifest";
import { MIX_TUNING } from "./mix-tuning";
import type {
  CaptureSummary,
  MixCapture,
  RecordingOpenResult,
  RecordingQuality,
  RecordingSaveChannel,
  RecordingWriteResult,
} from "./recording";
import type { SoundtrackPorts } from "./session";
import { LOG_CLOCK_KEYS, type SoundtrackLogEvent } from "./session-log";
import { wavHeader } from "./wav";

/** What the log's header line looks like, for a reader to check. */
export const RECORDING_LOG_FORMAT = 1;

// Each second, what was captured and logged goes to disk, and the readout and
// the limit are checked.
const TICK_MS = 1000;
// Log times to 10 µs: half a frame at 48 kHz.
const LOG_TIME_STEPS_PER_SECOND = 100_000;
const CHANNELS = 2;

export type RecordingStopReason =
  /** The length the person chose. */
  | "limit"
  /** The switch turned off. */
  | "switch"
  /** The music, and with it the session, turned off or closed. */
  | "music-off"
  /** The page going away, with no time to wait for the last of the audio. */
  | "unload"
  /** The disk would not take more. */
  | "write-failed"
  /** The capture stopped, or the files could not be reached. */
  | "failed";

export type RecordingOutcome =
  | {
      readonly kind: "saved";
      readonly recordingId: string;
      readonly name: string;
      /** Audio time recorded, which a suspended context does not add to. */
      readonly durationSeconds: number;
      readonly reason: RecordingStopReason;
    }
  /** Nothing was kept: the files would not open, or the capture would not start. */
  | { readonly kind: "failed" }
  /** Stopped before the first frame, as a switch flicked on and off is. */
  | { readonly kind: "empty" };

interface SessionRecorderOptions {
  readonly channel: RecordingSaveChannel;
  readonly ports: Pick<SoundtrackPorts, "output" | "log" | "captureMix">;
  readonly quality: RecordingQuality;
  /** Null records until it is turned off. */
  readonly limitSeconds: number | null;
  readonly manifest: SoundtrackManifest;
  readonly director: MixDirectorId;
  /** Once the log listens, so that the session can say what is sounding. */
  readonly onListening: () => void;
  /** Each second, with the audio time recorded so far. */
  readonly onProgress: (elapsedSeconds: number) => void;
  /** Once, when both files are finished or nothing could be kept. */
  readonly onStopped: (outcome: RecordingOutcome) => void;
}

type RecorderState = "opening" | "recording" | "stopping" | "stopped";

interface TrackSetSummary {
  readonly tracks: readonly string[];
  readonly digest: string;
}

interface OpenedRecording {
  readonly recordingId: string;
  readonly name: string;
  readonly capture: MixCapture;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Which set was playing: its tracks by name, and a digest of the definitions
 * and views the engine reads, which a re-signing of the samples' links leaves
 * as it was.
 */
async function describeTrackSet(
  manifest: SoundtrackManifest,
): Promise<TrackSetSummary> {
  const definitions = new TextEncoder().encode(
    JSON.stringify({ tracks: manifest.tracks, views: manifest.views }),
  );
  return {
    tracks: manifest.tracks.map((track) => track.name),
    digest: `sha256:${hex(await crypto.subtle.digest("SHA-256", definitions))}`,
  };
}

/**
 * One recording of the mix and of what the engine decided, from the switch to
 * whichever stop comes first. The audio and the log are appended as they are
 * made, a second at a time, so a crash keeps all but the last second or so.
 *
 * It never reaches into the mix: a capture that fails, a write the disk
 * refuses or a channel that is gone stops the recording, logs why, and
 * leaves the music as it was.
 *
 * Log times count from the first audio frame on the audio clock, so a
 * context the app suspends neither runs the limit down nor moves the log
 * against the audio.
 */
export class SessionRecorder {
  private readonly options: SessionRecorderOptions;
  private state: RecorderState = "opening";
  private opened: OpenedRecording | null = null;
  /** The audio clock time of the first frame; null until it is known. */
  private firstFrameAt: number | null = null;
  private audio: Uint8Array[] = [];
  private events: SoundtrackLogEvent[] = [];
  /** Audio bytes the disk has taken, past a WAV's header. */
  private writtenDataBytes = 0;
  private readonly writes = new Set<Promise<void>>();
  private timer: number | null = null;
  /** A stop asked for while the files were still opening. */
  private stopWhenOpen: RecordingStopReason | null = null;
  private trackSet: TrackSetSummary | null = null;

  constructor(options: SessionRecorderOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { channel, ports, quality, manifest } = this.options;
    let opened: RecordingOpenResult;
    try {
      // Ahead of the files, so that the header can go the moment time starts.
      this.trackSet = await describeTrackSet(manifest);
      opened = await channel.open(quality);
    } catch (error) {
      this.fail("could not open its files", error, null);
      return;
    }
    if (opened.kind !== "opened") {
      this.fail("could not open its files", null, null);
      return;
    }
    const { recordingId, name } = opened;
    let capture: MixCapture;
    try {
      capture = await ports.captureMix(quality);
    } catch (error) {
      this.fail("could not capture the mix", error, recordingId);
      return;
    }
    this.opened = { recordingId, name, capture };
    if (this.stopWhenOpen !== null) {
      this.state = "recording";
      this.stop(this.stopWhenOpen);
      return;
    }
    this.state = "recording";
    if (quality === "lossless") {
      this.send("audio", wavHeader(capture.sampleRate, CHANNELS, null), 0);
    }
    ports.log.listen(this.onEvent);
    window.addEventListener("pagehide", this.onPageHide);
    capture.start({
      onFirstFrame: (clockSeconds) => {
        this.writeHeader(clockSeconds);
      },
      onChunk: (bytes) => {
        if (this.state === "stopped") return;
        this.audio.push(bytes);
      },
      onError: (error) => {
        appLogger.warn("[soundtrack] a recording's capture stopped", {
          error: describeLogError(error),
        });
        this.stop("failed");
      },
    });
    // A capture that could not start has stopped the recording already.
    if (this.stopped()) return;
    this.options.onListening();
    this.timer = window.setTimeout(this.tick, TICK_MS);
  }

  /** Finishes both files once; later calls, and a stop already under way, do nothing. */
  stop(reason: RecordingStopReason): void {
    if (this.state === "stopping" || this.state === "stopped") return;
    if (this.state === "opening") {
      this.stopWhenOpen ??= reason;
      return;
    }
    this.state = "stopping";
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    window.removeEventListener("pagehide", this.onPageHide);
    this.options.ports.log.unlisten(this.onEvent);
    const elapsedSeconds = this.elapsed();
    const opened = this.opened;
    if (opened === null) return;
    const stopping = opened.capture.stop();
    // The page is going: what has arrived goes now, behind no wait.
    if (reason === "unload") {
      this.finish(opened, elapsedSeconds, reason, null);
      return;
    }
    void stopping.then((summary) => {
      this.finish(opened, elapsedSeconds, reason, summary);
    });
  }

  private stopped(): boolean {
    return this.state === "stopping" || this.state === "stopped";
  }

  /** Audio time since the first frame. */
  private elapsed(): number {
    if (this.firstFrameAt === null) return 0;
    return Math.max(
      0,
      this.options.ports.output.currentTime() - this.firstFrameAt,
    );
  }

  private readonly onEvent = (event: SoundtrackLogEvent): void => {
    this.events.push(event);
  };

  private readonly onPageHide = (): void => {
    this.stop("unload");
  };

  private readonly tick = (): void => {
    this.timer = null;
    if (this.state !== "recording") return;
    const { limitSeconds, onProgress } = this.options;
    const elapsed = this.elapsed();
    onProgress(elapsed);
    if (limitSeconds !== null && elapsed >= limitSeconds) {
      this.stop("limit");
      return;
    }
    this.flush();
    const untilLimitMs =
      limitSeconds === null
        ? Number.POSITIVE_INFINITY
        : (limitSeconds - elapsed) * 1000;
    this.timer = window.setTimeout(
      this.tick,
      Math.max(0, Math.min(TICK_MS, untilLimitMs)),
    );
  };

  /** The first line of the log, once the first frame says where time starts. */
  private writeHeader(clockSeconds: number): void {
    const { opened, trackSet } = this;
    if (this.state !== "recording" || this.firstFrameAt !== null) return;
    if (opened === null || trackSet === null) return;
    this.firstFrameAt = clockSeconds;
    const { director, quality } = this.options;
    this.sendLines([
      JSON.stringify({
        type: "header",
        format: RECORDING_LOG_FORMAT,
        trackSet,
        tuning: MIX_TUNING,
        director,
        quality,
        sampleRate: opened.capture.sampleRate,
        startedAt: new Date().toISOString(),
      }),
    ]);
  }

  private logLine(value: object): string {
    const origin = this.firstFrameAt ?? 0;
    return JSON.stringify(value, (key, field: unknown) =>
      LOG_CLOCK_KEYS.has(key) && typeof field === "number"
        ? Math.round((field - origin) * LOG_TIME_STEPS_PER_SECOND) /
          LOG_TIME_STEPS_PER_SECOND
        : field,
    );
  }

  /** What has been captured and logged since the last flush, to disk. */
  private flush(): void {
    if (this.audio.length > 0) {
      const bytes = concat(this.audio);
      this.audio = [];
      this.send("audio", bytes, bytes.length);
    }
    // Until the first frame, a log time would have nothing to count from.
    if (this.firstFrameAt !== null && this.events.length > 0) {
      const lines = this.events.map((event) => this.logLine(event));
      this.events = [];
      this.sendLines(lines);
    }
  }

  private sendLines(lines: readonly string[]): void {
    this.send("log", new TextEncoder().encode(`${lines.join("\n")}\n`), 0);
  }

  /** `dataBytes`: how much of `bytes` a WAV's header counts. */
  private send(
    file: "audio" | "log",
    bytes: Uint8Array,
    dataBytes: number,
  ): void {
    const { opened } = this;
    if (opened === null) return;
    const write = this.options.channel
      .append(opened.recordingId, file, bytes)
      .then(
        (result) => {
          if (result.kind === "ok") {
            if (file === "audio") this.writtenDataBytes += dataBytes;
            return;
          }
          this.writeFailed(result);
        },
        (error: unknown) => {
          appLogger.warn("[soundtrack] a recording's write did not arrive", {
            error: describeLogError(error),
          });
          this.stop("failed");
        },
      );
    this.writes.add(write);
    void write.finally(() => {
      this.writes.delete(write);
    });
  }

  private writeFailed(result: RecordingWriteResult): void {
    appLogger.warn("[soundtrack] a recording's write was refused", {
      result: result.kind,
    });
    this.stop(result.kind === "write-failed" ? "write-failed" : "failed");
  }

  /**
   * The last of the audio and the log, an end line saying why, and the WAV's
   * sizes over its placeholder, behind every write still on its way.
   */
  private finish(
    opened: OpenedRecording,
    elapsedSeconds: number,
    reason: RecordingStopReason,
    summary: CaptureSummary | null,
  ): void {
    // A disk that refused a write would refuse the rest of the audio too.
    if (reason === "write-failed") this.audio = [];
    this.flush();
    if (this.firstFrameAt !== null) {
      this.sendLines([
        this.logLine({
          type: "recording-end",
          t: this.options.ports.output.currentTime(),
          reason,
          frames: summary?.frames ?? null,
          droppedFrames: summary?.droppedFrames ?? null,
        }),
      ]);
    }
    if (reason === "unload") {
      // Nothing waits on a page that is going: the writes are on their way in
      // order, and the close goes behind them.
      this.close(opened, elapsedSeconds, reason);
      return;
    }
    void Promise.allSettled([...this.writes]).then(() => {
      this.close(opened, elapsedSeconds, reason);
    });
  }

  private close(
    opened: OpenedRecording,
    elapsedSeconds: number,
    reason: RecordingStopReason,
  ): void {
    this.state = "stopped";
    const { channel, quality, onStopped } = this.options;
    const header =
      quality === "lossless"
        ? wavHeader(opened.capture.sampleRate, CHANNELS, this.writtenDataBytes)
        : null;
    const report = (closedReason: RecordingStopReason): void => {
      if (this.firstFrameAt !== null) {
        onStopped({
          kind: "saved",
          recordingId: opened.recordingId,
          name: opened.name,
          durationSeconds: elapsedSeconds,
          reason: closedReason,
        });
        return;
      }
      const failed =
        closedReason === "failed" || closedReason === "write-failed";
      onStopped({ kind: failed ? "failed" : "empty" });
    };
    void channel.close(opened.recordingId, header).then(
      (result) => {
        report(
          result.kind === "write-failed" && reason !== "failed"
            ? "write-failed"
            : reason,
        );
      },
      (error: unknown) => {
        appLogger.warn("[soundtrack] a recording's files did not close", {
          error: describeLogError(error),
        });
        report(reason);
      },
    );
  }

  /** A start that got no further: what did open is closed, and nothing kept. */
  private fail(what: string, error: unknown, recordingId: string | null): void {
    appLogger.warn(`[soundtrack] a recording ${what}`, {
      error: error === null ? null : describeLogError(error),
    });
    this.state = "stopped";
    if (recordingId !== null) {
      void this.options.channel
        .close(recordingId, null)
        .catch((closeError: unknown) => {
          appLogger.warn("[soundtrack] a recording's files did not close", {
            error: describeLogError(closeError),
          });
        });
    }
    this.options.onStopped({ kind: "failed" });
  }
}
