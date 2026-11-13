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
import {
  readOpusPreSkip,
  webmOpusCluster,
  webmOpusHeader,
  type OpusPacket,
} from "./webm-opus";

/**
 * The two captures of the mix on a live `AudioContext`. Loaded only when a
 * recording starts (`web-audio-ports.ts`), so a build that never records
 * never fetches it.
 *
 * BOTH take their audio from the same worklet, on the audio thread, and the
 * compressed one encodes that itself. Nothing here reads the wall clock or the
 * context's state: the file's timeline is the frames handed over, and the
 * worklet fills any gap the audio thread leaves, so a suspended context simply
 * stops producing and the file has no hole to reconcile.
 */

/** Sends the mix to `node` as well, until the answer is called. */
export type MixTap = (node: AudioNode) => () => void;

const CHANNELS = 2;
/** The only rate this records at; the context is opened to match. */
const OPUS_RATE = 48_000;
/** 20 ms, in microseconds, as the encoder is configured and as it must emit. */
const OPUS_FRAME_DURATION_US = 20_000;
/** The samples in one such frame: 20 ms at 48 kHz. */
const OPUS_FRAME_SAMPLES = 960;
const OPUS_BITS_PER_SECOND = 128_000;
/**
 * A cluster's worth of packets, which the container decides and not this: a
 * block's offset from its cluster's timecode is a signed 16-bit tick count,
 * and at microsecond ticks a third 20 ms packet would need 40,000 of the
 * 32,767 available. So 40 ms of audio per cluster.
 *
 * That makes a delivery per 40 ms rather than per second, which costs nothing
 * downstream: the recorder already queues what it is handed and concatenates
 * the queue on its own tick, so the writes it makes are unchanged.
 */
const CLUSTER_PACKETS = 2;
/**
 * How long a stop waits for the audio thread to hand over the last of it. A
 * context closed under the worklet would otherwise wait for good — but a wait
 * that runs out now FAILS the capture rather than returning a short file as
 * though it were whole.
 */
const FINISH_DEADLINE_MS = 2000;

const NOTHING_COUNTED: CaptureSummary = { frames: null, droppedFrames: null };

/** A copy of `source`'s bytes, whichever kind of buffer it is. */
function copyOf(source: AllowSharedBufferSource): Uint8Array {
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(
    ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source),
  );
  return bytes;
}

/** What a capture wants from the worklet. */
interface PcmSink {
  readonly onFirstFrame: (clockSeconds: number) => void;
  /** Interleaved 16-bit stereo frames, in order. */
  readonly onFrames: (buffer: ArrayBuffer) => void;
}

/**
 * The worklet half, shared by both captures: it owns the node, the message
 * plumbing and the wait for the last frames.
 *
 * `finish` SETTLES, either way. It resolves with what the worklet counted, or
 * rejects, and never resolves with a summary it did not get — a capture that
 * cannot account for its own audio must not be reported as a complete one.
 */
class PcmWorkletSource {
  private readonly node: AudioWorkletNode;
  private readonly tap: MixTap;
  private disconnect: (() => void) | null = null;
  private finished: Promise<CaptureSummary> | null = null;
  private settle: {
    readonly resolve: (summary: CaptureSummary) => void;
    readonly reject: (error: Error) => void;
  } | null = null;

  constructor(context: AudioContext, tap: MixTap) {
    this.tap = tap;
    this.node = new AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: CHANNELS,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
  }

  start(sink: PcmSink, onFailure: (error: unknown) => void): void {
    const finished = new Promise<CaptureSummary>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.finished = finished;
    // Observed where it is created, not in `finish`: a capture that fails
    // reports through `onFailure` and need never be asked to finish, and its
    // rejection must not be left unobserved.
    void finished.catch(() => undefined);
    this.node.port.addEventListener("message", (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isPcmCaptureMessage(message)) return;
      switch (message.type) {
        case "first-frame":
          sink.onFirstFrame(message.time);
          return;
        case "pcm":
          sink.onFrames(message.buffer);
          return;
        case "finished":
          this.settle?.resolve({
            frames: message.frames,
            droppedFrames: message.droppedFrames,
          });
          this.settle = null;
          return;
      }
    });
    this.node.addEventListener(
      "processorerror",
      () => {
        const error = new Error("The capture worklet failed");
        // Whatever is waiting on the last frames will never get them.
        this.settle?.reject(error);
        this.settle = null;
        onFailure(error);
      },
      { once: true },
    );
    this.node.port.start();
    this.disconnect = this.tap(this.node);
  }

  /** Asks for the last frames and waits for them, or fails saying so. */
  finish(): Promise<CaptureSummary> {
    const finished = this.finished;
    if (finished === null) {
      return Promise.reject(
        new Error("The capture was asked to finish before it started"),
      );
    }
    this.node.port.postMessage(PCM_CAPTURE_FINISH);
    return new Promise<CaptureSummary>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(
          new Error(
            `The capture did not hand over its last frames within ${String(FINISH_DEADLINE_MS)} ms`,
          ),
        );
      }, FINISH_DEADLINE_MS);
      void finished.then(
        (summary) => {
          window.clearTimeout(timer);
          resolve(summary);
        },
        (error: unknown) => {
          window.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  release(): void {
    this.disconnect?.();
    this.disconnect = null;
    this.node.port.close();
  }
}

/**
 * Opus in WebM, encoded here from the worklet's frames
 * (`webm-opus.ts` writes the container).
 *
 * WHY THE ENCODER AND NOT `MediaRecorder`. A recorder stamps its packets by
 * the wall clock, so a context suspended under it leaves a hole in the file as
 * long as the pause while the log, on the audio clock, has none — and the only
 * way to keep the two together was to pause and resume the recorder around
 * every suspension and hope the device agreed. Here the file is made of the
 * frames the worklet hands over and nothing else: the sequence of packets IS
 * the timeline, one 20 ms frame after another from zero, so there is no clock
 * to keep in step and nothing to flush on a pause.
 *
 * Every assumption that timeline rests on is checked rather than trusted: the
 * encoder's own description supplies the pre-skip, each packet's duration is
 * verified to be the frame it was configured for, and the samples encoded are
 * reconciled with the samples captured before the file is closed.
 */
class OpusCapture implements MixCapture {
  readonly sampleRate = OPUS_RATE;
  /** Zero: log time 0 is the first frame, which is also the file's first sample. */
  readonly audioOffsetSeconds = 0;
  private readonly source: PcmWorkletSource;
  private readonly encoder: AudioEncoder;
  private handlers: MixCaptureHandlers | null = null;
  /** The first failure seen, which `stop` reports rather than a short file. */
  private failure: Error | null = null;
  /** Frames handed to the encoder, per channel: `N`. */
  private submittedSamples = 0;
  /** Packets the encoder has emitted: `K`. */
  private packets = 0;
  /** `S`, from the encoder's own `OpusHead`; null until it describes itself. */
  private preSkipSamples: number | null = null;
  /**
   * The packets of the cluster being filled. The most recent one is always
   * held back: the last packet of the file needs a `BlockGroup` to carry its
   * discard padding, and which packet that is cannot be known until the
   * encoder has flushed.
   */
  private openCluster: OpusPacket[] = [];

  constructor(context: AudioContext, tap: MixTap) {
    if (context.sampleRate !== OPUS_RATE) {
      throw new Error(
        `A recording needs a ${String(OPUS_RATE)} Hz context, not ${String(context.sampleRate)} Hz`,
      );
    }
    this.source = new PcmWorkletSource(context, tap);
    this.encoder = new AudioEncoder({
      output: this.onEncoded,
      error: (error: DOMException) => {
        this.fail(error);
      },
    });
  }

  start(handlers: MixCaptureHandlers): void {
    this.handlers = handlers;
    // NOTHING MAY THROW OUT OF HERE, and `configure` is why: it raises
    // synchronously for a configuration the browser will not take. A throw
    // leaves the recorder holding a capture it believes is running — it never
    // hears `onError`, never stops and never reports, so the recording hangs
    // open instead of failing. Reported, not raised.
    try {
      this.configure();
    } catch (error) {
      this.fail(error);
    }
  }

  private configure(): void {
    const handlers = this.handlers;
    if (handlers === null) return;
    this.encoder.configure({
      codec: "opus",
      sampleRate: OPUS_RATE,
      numberOfChannels: CHANNELS,
      bitrate: OPUS_BITS_PER_SECOND,
      opus: {
        // Raw Opus packets. `"ogg"` is the format the registration describes as
        // the one that carries the `OpusHead`, and it is REFUSED here —
        // Chromium raises "Opus Ogg format is unsupported" from
        // `audio_encoder.cc` rather than configuring. It is not needed for it:
        // the encoder builds its own `OpusHead` from a live
        // `OPUS_GET_LOOKAHEAD`, and Blink forwards that as the first packet's
        // `decoderConfig.description` whichever format is asked for. So the
        // container still gets a real header with a real pre-skip, read from
        // the description below and never assumed from here.
        format: "opus",
        frameDuration: OPUS_FRAME_DURATION_US,
        usedtx: false,
      },
    });
    this.source.start(
      {
        onFirstFrame: (clockSeconds) => {
          handlers.onFirstFrame(clockSeconds);
        },
        onFrames: (buffer) => {
          this.encode(buffer);
        },
      },
      (error) => {
        this.fail(error);
      },
    );
  }

  async stop(): Promise<CaptureSummary> {
    // Never started: there is nothing to account for and nobody to tell.
    if (this.handlers === null) {
      this.release();
      return NOTHING_COUNTED;
    }
    try {
      // A capture that has already failed is answered with THAT failure, and
      // nothing is asked of the worklet or the encoder. A start that never got
      // past `configure` left a worklet that was never started, and asking it
      // to finish would report "asked to finish before it started" — a second,
      // misleading error on top of the real one.
      this.throwIfFailed();
      const summary = await this.source.finish().catch((error: unknown) => {
        // Named rather than folded into a short file: the recording is
        // incomplete and whoever stops it has to be able to say so. Through
        // `fail`, because the worklet may already have reported this.
        throw this.fail(error);
      });
      // A flush resolves once the codec has handed over everything it holds,
      // which is not the same as everything having been written: a failure
      // raised inside the output callback is kept in `failure`, which
      // `closeFile` checks, because it cannot reject this.
      //
      // A flush that DOES reject goes through `fail` like any other failure,
      // which is what keeps an earlier one — the encoder's own error, recorded
      // while the wait for the last frames was still pending — as the error
      // `stop` answers with. A flush rejection must not supersede it.
      await this.encoder.flush().catch((error: unknown) => {
        throw this.fail(error);
      });
      this.closeFile(summary);
      return summary;
    } finally {
      this.release();
    }
  }

  /** Interleaved 16-bit stereo, straight to the encoder. */
  private encode(buffer: ArrayBuffer): void {
    if (this.failure !== null) return;
    const frames =
      buffer.byteLength / (CHANNELS * Int16Array.BYTES_PER_ELEMENT);
    if (frames === 0) return;
    try {
      const data = new AudioData({
        format: "s16",
        sampleRate: OPUS_RATE,
        numberOfChannels: CHANNELS,
        numberOfFrames: frames,
        // The encoder's own bookkeeping only; the file's timeline comes from
        // the packet sequence, never from these.
        timestamp: Math.round((this.submittedSamples * 1e6) / OPUS_RATE),
        data: buffer,
      });
      this.encoder.encode(data);
      data.close();
      this.submittedSamples += frames;
    } catch (error) {
      this.fail(error);
    }
  }

  private readonly onEncoded = (
    chunk: EncodedAudioChunk,
    metadata: EncodedAudioChunkMetadata | undefined,
  ): void => {
    // Nothing may throw out of a codec callback: it would be reported nowhere
    // and the flush would resolve as though all were well.
    try {
      this.takePacket(chunk, metadata);
    } catch (error) {
      this.fail(error);
    }
  };

  private takePacket(
    chunk: EncodedAudioChunk,
    metadata: EncodedAudioChunkMetadata | undefined,
  ): void {
    if (this.failure !== null) return;
    const config = metadata?.decoderConfig;
    if (config !== undefined && this.preSkipSamples === null) {
      this.openFile(config);
    }
    const preSkip = this.preSkipSamples;
    if (preSkip === null) {
      throw new Error("The encoder emitted a packet before describing itself");
    }
    // The file's whole timeline is one frame per packet, so a packet that is
    // not that frame would silently stretch or squeeze it. Checked, not assumed.
    if (chunk.duration !== OPUS_FRAME_DURATION_US) {
      throw new Error(
        `The encoder emitted a ${String(chunk.duration)} µs packet, not ${String(OPUS_FRAME_DURATION_US)} µs`,
      );
    }
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    this.openCluster.push({
      bytes,
      timeMs: (this.packets * OPUS_FRAME_DURATION_US) / 1000,
    });
    this.packets += 1;
    if (this.openCluster.length > CLUSTER_PACKETS) {
      const full = this.openCluster.slice(0, -1);
      this.openCluster = this.openCluster.slice(-1);
      const cluster = webmOpusCluster(full, null);
      this.handlers?.onChunk(cluster);
    }
  }

  /** The container's head, once the encoder has said what it is producing. */
  private openFile(config: AudioDecoderConfig): void {
    if (
      config.sampleRate !== OPUS_RATE ||
      config.numberOfChannels !== CHANNELS
    ) {
      throw new Error(
        `The encoder described ${String(config.numberOfChannels)} channels at ${String(config.sampleRate)} Hz`,
      );
    }
    const { description } = config;
    if (description === undefined) {
      throw new Error("The encoder described itself without an OpusHead");
    }
    const opusHead = copyOf(description);
    const preSkipSamples = readOpusPreSkip(opusHead);
    this.preSkipSamples = preSkipSamples;
    const header = webmOpusHeader({ opusHead, preSkipSamples });
    this.handlers?.onChunk(header);
  }

  /**
   * The last cluster, with the padding that says where the audio really ends.
   *
   * The encoder pads its last frame out to a whole 20 ms, so the file holds
   * `960 * K` samples where the capture produced `N` and the decoder throws
   * `S` away at the front. What is left over at the end is the padding, and it
   * has to be less than one frame: anything else means the packets and the
   * frames no longer describe the same audio, and a file written on that
   * footing would be wrong in a way nothing downstream could detect.
   */
  private closeFile(summary: CaptureSummary): void {
    this.throwIfFailed();
    const preSkip = this.preSkipSamples;
    if (this.packets === 0) {
      if (this.submittedSamples > 0) {
        throw new Error(
          `The encoder returned nothing for ${String(this.submittedSamples)} captured frames`,
        );
      }
      return;
    }
    if (preSkip === null) {
      throw new Error("The encoder never described itself");
    }
    if (summary.frames !== null && summary.frames !== this.submittedSamples) {
      throw new Error(
        `The worklet counted ${String(summary.frames)} frames and ${String(this.submittedSamples)} reached the encoder`,
      );
    }
    const padding =
      OPUS_FRAME_SAMPLES * this.packets - preSkip - this.submittedSamples;
    if (padding < 0 || padding >= OPUS_FRAME_SAMPLES) {
      throw new Error(
        `The encoder's ${String(this.packets)} packets leave ${String(padding)} samples of padding, which is not within one frame`,
      );
    }
    const cluster = webmOpusCluster(
      this.openCluster,
      Math.round((padding * 1e9) / OPUS_RATE),
    );
    this.handlers?.onChunk(cluster);
    this.openCluster = [];
  }

  private throwIfFailed(): void {
    if (this.failure !== null) throw this.failure;
  }

  /**
   * The first failure stands, `onError` hears it exactly once, and nothing is
   * delivered after it.
   *
   * One failure reaches here by several routes at once: the worklet rejects
   * the wait for its last frames AND reports separately, and an owner that
   * answers `onError` by stopping the recording arrives straight back in
   * `stop`. Returns the failure to reject with, which is the first one rather
   * than whichever route came last.
   */
  private fail(error: unknown): Error {
    const failure = this.failure;
    if (failure !== null) return failure;
    const first = error instanceof Error ? error : new Error(String(error));
    this.failure = first;
    this.openCluster = [];
    this.handlers?.onError(first);
    return first;
  }

  private release(): void {
    this.source.release();
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}

/**
 * 16-bit stereo PCM at the context's rate, from the same worklet. Its first
 * frame is the clock time the worklet read on it.
 */
class PcmCapture implements MixCapture {
  readonly sampleRate: number;
  readonly audioOffsetSeconds = 0;
  private readonly source: PcmWorkletSource;
  private handlers: MixCaptureHandlers | null = null;
  /** The first failure seen, which `stop` rejects with. */
  private failure: Error | null = null;

  constructor(context: AudioContext, tap: MixTap) {
    this.sampleRate = context.sampleRate;
    this.source = new PcmWorkletSource(context, tap);
  }

  start(handlers: MixCaptureHandlers): void {
    this.handlers = handlers;
    // Reported rather than raised, for the same reason as the compressed
    // capture: a throw out of `start` leaves the recorder holding a capture it
    // believes is running.
    try {
      this.source.start(
        {
          onFirstFrame: (clockSeconds) => {
            handlers.onFirstFrame(clockSeconds);
          },
          onFrames: (buffer) => {
            // Nothing is delivered after a failure. The worklet's error is
            // dispatched on the node and its frames on the port, two queues
            // with no order between them, so a batch handed over before the
            // processor threw can arrive after it has been reported.
            if (this.failure !== null) return;
            handlers.onChunk(new Uint8Array(buffer));
          },
        },
        (error) => {
          this.fail(error);
        },
      );
    } catch (error) {
      this.fail(error);
    }
  }

  async stop(): Promise<CaptureSummary> {
    // Never started: there is nothing to account for and nobody to tell.
    if (this.handlers === null) {
      this.source.release();
      return NOTHING_COUNTED;
    }
    try {
      // A capture that has already failed is answered with THAT failure, and
      // nothing is asked of the worklet. A `start` that threw left one whose
      // last frames can never arrive, so asking would wait out the deadline
      // and then report the wait in place of the real error.
      const failure = this.failure;
      if (failure !== null) throw failure;
      // A wait that runs out is a failure, not a summary of nothing: the file
      // is short by however much never arrived, and saying so is the only way
      // the recording is not reported as whole.
      return await this.source.finish().catch((error: unknown) => {
        throw this.fail(error);
      });
    } finally {
      this.source.release();
    }
  }

  /**
   * The first failure stands and `onError` hears it exactly once, as in the
   * compressed capture: a worklet that fails reports it AND rejects the wait
   * for its last frames, which an owner stopping in answer then runs into.
   * Returns the failure to reject with.
   */
  private fail(error: unknown): Error {
    const failure = this.failure;
    if (failure !== null) return failure;
    const first = error instanceof Error ? error : new Error(String(error));
    this.failure = first;
    this.handlers?.onError(first);
    return first;
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
  await loadPcmWorklet(context);
  if (quality === "lossless") return new PcmCapture(context, tap);
  if (typeof AudioEncoder === "undefined") {
    throw new Error("This build cannot encode audio");
  }
  return new OpusCapture(context, tap);
}
