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
const RECORDING_LOG_FORMAT = 1;

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
  /** The app quitting, which waits a moment for the files to finish. */
  | "quit"
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

/** A write or a close that did not land, which the outcome says over the reason. */
type IoFailure = "write-failed" | "failed";

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
 * against the audio. A recording started during a pause simply has no first
 * frame until the music plays.
 */
export class SessionRecorder {
  private readonly options: SessionRecorderOptions;
  private state: RecorderState = "opening";
  /** Once `open` answers; the files can be closed from then on. */
  private recordingId: string | null = null;
  private opened: OpenedRecording | null = null;
  /** The audio clock time of the first frame; null until it is known. */
  private firstFrameAt: number | null = null;
  private audio: Uint8Array[] = [];
  private events: SoundtrackLogEvent[] = [];
  /** Audio bytes sent, and those the disk has taken, past a WAV's header. */
  private sentDataBytes = 0;
  private writtenDataBytes = 0;
  private readonly writes = new Set<Promise<void>>();
  private timer: number | null = null;
  /** A stop asked for while the files were still opening. */
  private stopWhenOpen: RecordingStopReason | null = null;
  private trackSet: TrackSetSummary | null = null;
  private stopReason: RecordingStopReason | null = null;
  /** The audio clock as the stop was asked for; null until one is. */
  private stoppedAtClock: number | null = null;
  /** The first write or capture that failed, kept through the stop. */
  private failure: IoFailure | null = null;
  /** The page is going: nothing more waits, and the close goes now. */
  private unloading = false;
  private endSent = false;
  private closeAsked = false;
  /** The one close sent, answering what failed in it, or null. */
  private closing: Promise<IoFailure | null> | null = null;
  private unsubscribeFinish: (() => void) | null = null;

  constructor(options: SessionRecorderOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { channel, ports, quality, manifest } = this.options;
    // From the first wait on: a page going away or the app quitting while the
    // files open still closes what did open.
    window.addEventListener("pagehide", this.onPageHide);
    this.unsubscribeFinish = channel.onFinishRequested(this.onFinishRequested);
    let opened: RecordingOpenResult;
    try {
      // Ahead of the files, so that the header can go the moment time starts.
      this.trackSet = await describeTrackSet(manifest);
      opened = await channel.open(quality);
    } catch (error) {
      this.fail("could not open its files", error);
      return;
    }
    if (opened.kind !== "opened") {
      this.fail("could not open its files", null);
      return;
    }
    const { recordingId, name } = opened;
    this.recordingId = recordingId;
    if (this.stopAsked() !== null) {
      this.abandon();
      return;
    }
    let capture: MixCapture;
    try {
      capture = await ports.captureMix(quality);
    } catch (error) {
      this.fail("could not capture the mix", error);
      return;
    }
    this.opened = { recordingId, name, capture };
    this.state = "recording";
    const asked = this.stopAsked();
    if (asked !== null) {
      this.stop(asked);
      return;
    }
    ports.log.listen(this.onEvent);
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
        this.ioFailed("failed");
      },
    });
    // A capture that could not start has stopped the recording already.
    if (this.stopped()) return;
    this.options.onListening();
    this.timer = window.setTimeout(this.tick, TICK_MS);
  }

  /**
   * Finishes both files once; later calls, and a stop already under way, do
   * nothing, except that a page going away cuts short the wait for the last
   * of the audio and the writes.
   */
  stop(reason: RecordingStopReason): void {
    if (this.state === "stopped") return;
    if (this.state === "stopping") {
      if (reason === "unload") this.finishNow();
      return;
    }
    if (this.state === "opening") {
      this.stopWhenOpen ??= reason;
      // The page can be gone before the capture answers; what is known to be
      // open is closed now.
      if (reason === "unload" && this.recordingId !== null) {
        void this.closeFiles(null);
      }
      return;
    }
    this.state = "stopping";
    this.stopReason = reason;
    this.stoppedAtClock = this.options.ports.output.currentTime();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.options.ports.log.unlisten(this.onEvent);
    const { opened } = this;
    if (opened === null) return;
    const stopping = opened.capture.stop();
    if (reason === "unload") {
      // Observed, and nothing more. The files are already being finished and
      // closed below, so this must not wait for the capture, reopen anything
      // or finish a second time; it is here because the promise would
      // otherwise go unanswered and reject into the window.
      //
      // It is NOT what decides how a late failure is reported, and does not
      // make that deterministic: the capture's own `onError` can already have
      // reached `ioFailed` and set `failure`, and the outcome is published
      // from `closeFiles`, after this. On an unload, reporting is best-effort
      // either way.
      void stopping.catch((error: unknown) => {
        appLogger.warn("[soundtrack] a capture failed as the page went away", {
          error: describeLogError(error),
        });
      });
      this.finishNow();
      return;
    }
    // Both ways, and neither silently: a capture that cannot account for its
    // audio REJECTS, and a rejection left unhandled here would be an unhandled
    // rejection and a recording that never finishes its files at all, because
    // nothing else calls `finish`. What it must not become is a clean ending —
    // the failure is recorded first, so the outcome's reason says the capture
    // failed rather than naming whatever asked it to stop.
    void stopping.then(
      (summary) => {
        this.finish(summary);
      },
      (error: unknown) => {
        appLogger.warn("[soundtrack] a recording's capture did not finish", {
          error: describeLogError(error),
        });
        this.failure ??= "failed";
        this.finish(null);
      },
    );
  }

  /** A stop asked for while the files opened, which any wait there can bring. */
  private stopAsked(): RecordingStopReason | null {
    return this.stopWhenOpen;
  }

  private stopped(): boolean {
    return this.state === "stopping" || this.state === "stopped";
  }

  /**
   * Audio time recorded: the clock at the stop, less the origin.
   *
   * Kept as the two readings and subtracted here, rather than subtracted at
   * the stop, because the origin can be set AFTER the stop — the first frame
   * arrives over a `MessagePort` and the dispatch can lose the race. Measured
   * at the stop, such a recording reported a duration of zero over a file with
   * audio in it.
   */
  private recordedSeconds(): number {
    const { stoppedAtClock, firstFrameAt } = this;
    if (stoppedAtClock === null || firstFrameAt === null) return 0;
    return Math.max(0, stoppedAtClock - firstFrameAt);
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

  private readonly onFinishRequested = (): void => {
    this.stop("quit");
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
    // A first frame that arrives while this is STOPPING still sets the origin,
    // and has to. The capture reports it over a `MessagePort`, so an ordinary
    // stop can beat the dispatch; refusing it would leave `firstFrameAt` null,
    // which makes `flush` skip the audio that did arrive and closes a
    // recording with frames in it as `empty`.
    //
    // What refuses is a recording whose files are going or gone, and the test
    // for that is `closeAsked` rather than the state: `state` only becomes
    // `stopped` once the close ANSWERS, so a page going away leaves a window
    // in which it still reads `stopping` and the files have already been told
    // to close. Nothing may be written in it.
    if (this.closeAsked || this.state === "opening") return;
    if (this.firstFrameAt !== null) return;
    if (opened === null || trackSet === null) return;
    this.firstFrameAt = clockSeconds;
    const { director, quality } = this.options;
    if (quality === "lossless") {
      this.send(
        "audio",
        wavHeader(opened.capture.sampleRate, CHANNELS, null),
        0,
      );
    }
    this.sendLines([
      JSON.stringify({
        type: "header",
        format: RECORDING_LOG_FORMAT,
        trackSet,
        tuning: MIX_TUNING,
        director,
        quality,
        sampleRate: opened.capture.sampleRate,
        // Add to a log time to find it in the audio file.
        audioOffsetSeconds: opened.capture.audioOffsetSeconds,
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

  /**
   * What has been captured and logged since the last flush, to disk. Until the
   * first frame, which a recording started during a pause waits for, a log time
   * has nothing to count from and nothing need reach the disk: one stopped
   * before it leaves no files.
   */
  private flush(): void {
    if (this.firstFrameAt === null) return;
    if (this.audio.length > 0) {
      const bytes = concat(this.audio);
      this.audio = [];
      this.send("audio", bytes, bytes.length);
    }
    if (this.events.length > 0) {
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
    if (file === "audio") this.sentDataBytes += dataBytes;
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
          this.ioFailed("failed");
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
    this.ioFailed(result.kind === "write-failed" ? "write-failed" : "failed");
  }

  /** Stops the recording, and keeps the failure for the outcome if it is stopping already. */
  private ioFailed(failure: IoFailure): void {
    this.failure ??= failure;
    this.stop(failure);
  }

  /** The page is going: what has arrived, the end line and the close go now. */
  private finishNow(): void {
    this.unloading = true;
    this.finish(null);
  }

  /**
   * The last of the audio and the log, an end line saying why, and the WAV's
   * sizes over its placeholder, behind every write still on its way.
   */
  private finish(summary: CaptureSummary | null): void {
    if (!this.endSent) {
      this.endSent = true;
      this.flush();
      if (this.firstFrameAt !== null) {
        this.sendLines([
          this.logLine({
            type: "recording-end",
            t: this.options.ports.output.currentTime(),
            reason: this.stopReason,
            frames: summary?.frames ?? null,
            droppedFrames: summary?.droppedFrames ?? null,
          }),
        ]);
      }
    }
    if (this.unloading) {
      // Nothing waits on a page that is going: the writes are on their way in
      // order, and the close goes behind them.
      this.close();
      return;
    }
    void Promise.allSettled([...this.writes]).then(() => {
      this.close();
    });
  }

  private close(): void {
    const { opened } = this;
    if (this.closeAsked || opened === null) return;
    this.closeAsked = true;
    const { quality, onStopped } = this.options;
    // A page going away does not wait to hear back: what it sent is ahead of
    // the close in the same queue, and almost always lands.
    const dataBytes = this.unloading
      ? this.sentDataBytes
      : this.writtenDataBytes;
    const header =
      quality === "lossless" && this.firstFrameAt !== null
        ? wavHeader(opened.capture.sampleRate, CHANNELS, dataBytes)
        : null;
    const reason = this.stopReason ?? "failed";
    void this.closeFiles(header).then((closeFailure) => {
      this.state = "stopped";
      // A write that failed while stopping, or a close that did not land,
      // says more about the files than why the recording stopped.
      const closedReason = this.failure ?? closeFailure ?? reason;
      if (this.firstFrameAt !== null) {
        onStopped({
          kind: "saved",
          recordingId: opened.recordingId,
          name: opened.name,
          durationSeconds: this.recordedSeconds(),
          reason: closedReason,
        });
        return;
      }
      const failed =
        closedReason === "failed" || closedReason === "write-failed";
      onStopped({ kind: failed ? "failed" : "empty" });
    });
  }

  /**
   * Closes both files, once: a later call answers the first close. Nothing is
   * left for a page going away or a quit to do after it.
   */
  private closeFiles(header: Uint8Array | null): Promise<IoFailure | null> {
    if (this.closing !== null) return this.closing;
    const { recordingId } = this;
    this.release();
    if (recordingId === null) {
      this.closing = Promise.resolve("failed");
      return this.closing;
    }
    this.closing = this.options.channel.close(recordingId, header).then(
      (result) => {
        if (result.kind === "ok") return null;
        appLogger.warn("[soundtrack] a recording's close was refused", {
          result: result.kind,
        });
        return result.kind === "write-failed" ? "write-failed" : "failed";
      },
      (error: unknown) => {
        appLogger.warn("[soundtrack] a recording's files did not close", {
          error: describeLogError(error),
        });
        return "failed";
      },
    );
    return this.closing;
  }

  private release(): void {
    window.removeEventListener("pagehide", this.onPageHide);
    this.unsubscribeFinish?.();
    this.unsubscribeFinish = null;
  }

  /** Stopped before the capture began: what opened is closed, and nothing kept. */
  private abandon(): void {
    void this.closeFiles(null).then(() => {
      this.state = "stopped";
      this.options.onStopped({ kind: "empty" });
    });
  }

  /** A start that got no further: what did open is closed, and nothing kept. */
  private fail(what: string, error: unknown): void {
    appLogger.warn(`[soundtrack] a recording ${what}`, {
      error: error === null ? null : describeLogError(error),
    });
    this.state = "stopped";
    if (this.recordingId === null) {
      this.release();
    } else {
      void this.closeFiles(null);
    }
    this.options.onStopped({ kind: "failed" });
  }
}
