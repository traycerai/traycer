import { appLogger, describeLogError } from "@/lib/logger";
import {
  isPcmCaptureMessage,
  PCM_CAPTURE_FINISH,
  PCM_CAPTURE_PROCESSOR,
} from "./pcm-capture-protocol";
import pcmCaptureWorkletUrl from "./pcm-capture-worklet.ts?worker&url";
import type {
  CaptureSummary,
  MixCapture,
  MixCaptureHandlers,
  RecordingQuality,
} from "./recording";

/**
 * The two captures of the mix on a live `AudioContext`. Loaded only when a
 * recording starts (`web-audio-ports.ts`), so a build that never records
 * never fetches it.
 */

/** Sends the mix to `node` as well, until the answer is called. */
export type MixTap = (node: AudioNode) => () => void;

/** Calls `listener` just ahead of each start of the clock, until the answer is called. */
export type ClockStarts = (listener: () => void) => () => void;

const OPUS_MIME_TYPE = "audio/webm;codecs=opus";
const OPUS_BITS_PER_SECOND = 128_000;
// Each slice reaches the disk on the next flush, so a crash loses about this.
const OPUS_TIMESLICE_MS = 1000;
/**
 * Measured, not derived: the recorder's file starts this long before the clock
 * time read as it is started. Chromium gave 6.5 ms headless, with or without
 * the page stalled after the start, and 6.48 to 6.50 ms on a macOS desktop.
 */
const OPUS_AUDIO_OFFSET_SECONDS = 0.0065;
/**
 * How long `stop` waits for the last of the audio before letting go anyway: a
 * context closed under it would otherwise hold the recording open for good.
 */
const STOP_GRACE_MS = 2000;
const CHANNELS = 2;

const NOTHING_COUNTED: CaptureSummary = { frames: null, droppedFrames: null };

/**
 * Feeds `node` a silence that never stops, alongside the mix, until the answer
 * is called. Without it a stream whose mix has gone quiet delivers no frames,
 * and a WebM made of what does arrive comes out shorter than the time it
 * covers, with the log's times drifting off it after every silence. The
 * worklet needs none: it keeps itself running and fills any gap.
 */
function keepRendering(context: AudioContext, node: AudioNode): () => void {
  const silence = new ConstantSourceNode(context, { offset: 0 });
  silence.connect(node);
  silence.start();
  return () => {
    silence.stop();
    silence.disconnect();
  };
}

/** Settles with `value` after `ms` unless `promise` settles first. */
function withGrace<T>(promise: Promise<T>, value: T, ms: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      appLogger.warn("[soundtrack] a recording's capture did not finish", {
        waitedMs: ms,
      });
      resolve(value);
    }, ms);
    void promise.then(
      (settled) => {
        window.clearTimeout(timer);
        resolve(settled);
      },
      () => {
        window.clearTimeout(timer);
        resolve(value);
      },
    );
  });
}

/**
 * Opus in WebM at 128 kbps, a slice a second. Its first frame is taken as the
 * clock time as `MediaRecorder` is started, which on a suspended context is
 * the time the clock will go on from, reported once it does.
 *
 * The recorder stamps its packets by the wall clock, so a context suspended
 * under it leaves a hole in the file as long as the pause, which the log, on
 * the audio clock, does not have. It is paused for as long as the context is:
 * after the context stops, and started ahead of the clock, because it drops
 * what reaches it while paused. Every frame stays in the file, in order, so
 * the offset from the log holds across a pause; only the packets' stamps gain
 * what the device took to start, 15 to 54 ms a pause on a macOS desktop.
 */
class OpusCapture implements MixCapture {
  readonly sampleRate: number;
  readonly audioOffsetSeconds = OPUS_AUDIO_OFFSET_SECONDS;
  private readonly context: AudioContext;
  private readonly tap: MixTap;
  private readonly clockStarts: ClockStarts;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly recorder: MediaRecorder;
  private disconnect: (() => void) | null = null;
  /**
   * Each slice's bytes are read in turn, so they arrive in order. Every link
   * settles: a slice that cannot be read fails the capture instead.
   */
  private delivered: Promise<void> = Promise.resolve();
  /** Set once `onError` is raised; no slice is delivered after it. */
  private failed = false;
  /** Reports the first frame, for a start the context has not run since. */
  private whenRunning: (() => void) | null = null;

  constructor(context: AudioContext, tap: MixTap, clockStarts: ClockStarts) {
    this.context = context;
    this.tap = tap;
    this.clockStarts = clockStarts;
    this.sampleRate = context.sampleRate;
    this.destination = context.createMediaStreamDestination();
    this.destination.channelCount = CHANNELS;
    this.recorder = new MediaRecorder(this.destination.stream, {
      mimeType: OPUS_MIME_TYPE,
      audioBitsPerSecond: OPUS_BITS_PER_SECOND,
    });
  }

  start(handlers: MixCaptureHandlers): void {
    const { recorder } = this;
    const fail = (error: unknown): void => {
      if (this.failed) return;
      this.failed = true;
      this.release();
      handlers.onError(error);
    };
    recorder.addEventListener("dataavailable", (event) => {
      const slice = event.data;
      this.delivered = this.delivered.then(async () => {
        try {
          const bytes = new Uint8Array(await slice.arrayBuffer());
          // Whether it waited in line or was being read, a slice after the
          // failure goes nowhere.
          if (!this.failed) handlers.onChunk(bytes);
        } catch (error) {
          fail(error);
        }
      });
    });
    recorder.addEventListener(
      "error",
      (event) => {
        fail(Reflect.get(event, "error"));
      },
      { once: true },
    );
    const untap = this.tap(this.destination);
    const unkeep = keepRendering(this.context, this.destination);
    const unlisten = this.clockStarts(this.resumeRecorder);
    this.context.addEventListener("statechange", this.followContext);
    this.disconnect = () => {
      untap();
      unkeep();
      unlisten();
      this.context.removeEventListener("statechange", this.followContext);
    };
    try {
      recorder.start(OPUS_TIMESLICE_MS);
    } catch (error) {
      fail(error);
      return;
    }
    // Read in the same task as the start, not at the `start` event: the event
    // waits behind whatever else the page is doing, and the file does not.
    const startedAt = this.context.currentTime;
    if (this.context.state === "running") handlers.onFirstFrame(startedAt);
    else {
      this.whenRunning = () => {
        handlers.onFirstFrame(startedAt);
      };
    }
  }

  stop(): Promise<CaptureSummary> {
    const { recorder } = this;
    if (recorder.state === "inactive") {
      this.release();
      return Promise.resolve(NOTHING_COUNTED);
    }
    const stopped = new Promise<CaptureSummary>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          // The last slice's `dataavailable` comes just before `stop`.
          void this.delivered.then(() => {
            resolve(NOTHING_COUNTED);
          });
        },
        { once: true },
      );
    });
    recorder.stop();
    return withGrace(stopped, NOTHING_COUNTED, STOP_GRACE_MS).finally(() => {
      this.release();
    });
  }

  private readonly resumeRecorder = (): void => {
    if (this.recorder.state === "paused") this.recorder.resume();
  };

  private readonly followContext = (): void => {
    const { state } = this.context;
    if (state === "suspended" && this.recorder.state === "recording") {
      this.recorder.pause();
    }
    if (state !== "running") return;
    // Only a context that came back by some other way than `clockStarts`.
    this.resumeRecorder();
    this.whenRunning?.();
    this.whenRunning = null;
  };

  private release(): void {
    this.disconnect?.();
    this.disconnect = null;
    for (const track of this.destination.stream.getTracks()) track.stop();
  }
}

/**
 * 16-bit stereo PCM at the context's rate, from a worklet on the audio thread
 * (`pcm-capture-worklet.ts`). Its first frame is the clock time the worklet
 * read on it.
 */
class PcmCapture implements MixCapture {
  readonly sampleRate: number;
  readonly audioOffsetSeconds = 0;
  private readonly tap: MixTap;
  private readonly node: AudioWorkletNode;
  private disconnect: (() => void) | null = null;
  private finished: Promise<CaptureSummary> | null = null;
  private resolveFinished: ((summary: CaptureSummary) => void) | null = null;

  constructor(context: AudioContext, tap: MixTap) {
    this.tap = tap;
    this.sampleRate = context.sampleRate;
    this.node = new AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: CHANNELS,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
  }

  start(handlers: MixCaptureHandlers): void {
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    this.node.port.addEventListener("message", (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isPcmCaptureMessage(message)) return;
      switch (message.type) {
        case "first-frame":
          handlers.onFirstFrame(message.time);
          return;
        case "pcm":
          handlers.onChunk(new Uint8Array(message.buffer));
          return;
        case "finished":
          this.resolveFinished?.({
            frames: message.frames,
            droppedFrames: message.droppedFrames,
          });
          return;
      }
    });
    this.node.addEventListener(
      "processorerror",
      () => {
        this.release();
        handlers.onError(new Error("The capture worklet failed"));
      },
      { once: true },
    );
    this.node.port.start();
    this.disconnect = this.tap(this.node);
  }

  stop(): Promise<CaptureSummary> {
    if (this.finished === null) {
      this.release();
      return Promise.resolve(NOTHING_COUNTED);
    }
    this.node.port.postMessage(PCM_CAPTURE_FINISH);
    return withGrace(this.finished, NOTHING_COUNTED, STOP_GRACE_MS).finally(
      () => {
        this.release();
      },
    );
  }

  private release(): void {
    this.disconnect?.();
    this.disconnect = null;
    this.node.port.close();
  }
}

/** Contexts the worklet module is already loaded into. */
const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function loadPcmWorklet(context: AudioContext): Promise<void> {
  const loaded = workletLoaded.get(context);
  if (loaded !== undefined) return loaded;
  const loading = context.audioWorklet.addModule(pcmCaptureWorkletUrl);
  workletLoaded.set(context, loading);
  void loading.catch((error: unknown) => {
    workletLoaded.delete(context);
    appLogger.warn("[soundtrack] could not load the capture worklet", {
      error: describeLogError(error),
    });
  });
  return loading;
}

export async function openMixCapture(
  context: AudioContext,
  tap: MixTap,
  clockStarts: ClockStarts,
  quality: RecordingQuality,
): Promise<MixCapture> {
  if (quality === "compressed") {
    return new OpusCapture(context, tap, clockStarts);
  }
  await loadPcmWorklet(context);
  return new PcmCapture(context, tap);
}
