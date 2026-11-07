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

const OPUS_MIME_TYPE = "audio/webm;codecs=opus";
const OPUS_BITS_PER_SECOND = 128_000;
// Each slice reaches the disk on the next flush, so a crash loses about this.
const OPUS_TIMESLICE_MS = 1000;
/**
 * How long `stop` waits for the last of the audio before letting go anyway:
 * a context closed or suspended under it would otherwise hold the recording
 * open for good.
 */
const STOP_GRACE_MS = 2000;
const CHANNELS = 2;

const NOTHING_COUNTED: CaptureSummary = { frames: null, droppedFrames: null };

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
 * clock time `MediaRecorder` reports starting at.
 */
class OpusCapture implements MixCapture {
  readonly sampleRate: number;
  private readonly context: AudioContext;
  private readonly tap: MixTap;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly recorder: MediaRecorder;
  private disconnect: (() => void) | null = null;
  /** Each slice's bytes are read in turn, so they arrive in order. */
  private delivered: Promise<void> = Promise.resolve();

  constructor(context: AudioContext, tap: MixTap) {
    this.context = context;
    this.tap = tap;
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
    recorder.addEventListener(
      "start",
      () => {
        handlers.onFirstFrame(this.context.currentTime);
      },
      { once: true },
    );
    recorder.addEventListener("dataavailable", (event) => {
      const slice = event.data;
      this.delivered = this.delivered.then(async () => {
        handlers.onChunk(new Uint8Array(await slice.arrayBuffer()));
      });
    });
    recorder.addEventListener(
      "error",
      (event) => {
        this.release();
        handlers.onError(Reflect.get(event, "error"));
      },
      { once: true },
    );
    this.disconnect = this.tap(this.destination);
    try {
      recorder.start(OPUS_TIMESLICE_MS);
    } catch (error) {
      this.release();
      handlers.onError(error);
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
  quality: RecordingQuality,
): Promise<MixCapture> {
  if (quality === "compressed") return new OpusCapture(context, tap);
  await loadPcmWorklet(context);
  return new PcmCapture(context, tap);
}
