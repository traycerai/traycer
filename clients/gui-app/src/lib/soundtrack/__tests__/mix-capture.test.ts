/**
 * The compressed capture's own orchestration (`mix-capture.ts`'s `OpusCapture`,
 * reached only through `openMixCapture`, which is all that is exported): the
 * encoder it drives, the order `stop` waits in, and the invariants it checks
 * about its own audio rather than trusts. The muxer's byte layout is
 * `webm-opus.test.ts`; the worklet's own frame accounting is
 * `pcm-capture-worklet.test.ts`. This file fakes both the worklet's node and
 * `AudioEncoder`/`AudioData`, since jsdom has neither.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { openMixCapture, type MixTap } from "../mix-capture";
import type { CaptureSummary, MixCapture } from "../recording";

const OPUS_RATE = 48_000;
const FRAME_US = 20_000;
const CHANNELS = 2;

class FakePort {
  private readonly listeners: ((event: MessageEvent) => void)[] = [];
  readonly posted: unknown[] = [];
  closeCalls = 0;

  addEventListener(
    _type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    this.listeners.push(listener);
  }

  start(): void {}
  close(): void {
    this.closeCalls += 1;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  /** What the worklet does: deliver a message to the page's listener. */
  send(data: unknown): void {
    for (const listener of this.listeners) {
      listener(new MessageEvent("message", { data }));
    }
  }
}

class FakeAudioWorkletNode extends EventTarget {
  static readonly instances: FakeAudioWorkletNode[] = [];
  readonly port = new FakePort();

  constructor(_context: unknown, _name: string, _options: unknown) {
    super();
    FakeAudioWorkletNode.instances.push(this);
  }
}

interface AudioDataInit {
  readonly format: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly timestamp: number;
  readonly data: ArrayBuffer;
}

class FakeAudioData {
  readonly init: AudioDataInit;
  closed = false;

  constructor(init: AudioDataInit) {
    this.init = init;
  }

  close(): void {
    this.closed = true;
  }
}

interface EncodedChunk {
  readonly duration: number;
  readonly byteLength: number;
  copyTo(target: Uint8Array): void;
}

function fakeChunk(bytes: Uint8Array, durationUs: number): EncodedChunk {
  return {
    duration: durationUs,
    byteLength: bytes.length,
    copyTo: (target) => target.set(bytes),
  };
}

/** A synthetic but structurally valid `OpusHead`, as a real encoder reports. */
function opusHead(preSkip: number): Uint8Array {
  const bytes = new Uint8Array(19);
  bytes.set(new TextEncoder().encode("OpusHead"), 0);
  bytes[8] = 1;
  bytes[9] = CHANNELS;
  new DataView(bytes.buffer).setUint16(10, preSkip, true);
  return bytes;
}

type EncodeOutput = (
  chunk: EncodedChunk,
  metadata: { readonly decoderConfig?: unknown } | undefined,
) => void;

class FakeAudioEncoder {
  static readonly instances: FakeAudioEncoder[] = [];
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  readonly configureCalls: unknown[] = [];
  /** Set, `configure` throws this instead of configuring. */
  configureThrows: Error | null = null;
  readonly encodeCalls: FakeAudioData[] = [];
  flushCalls = 0;
  closeCalls = 0;
  /** While set, `flush` answers only once this resolves. */
  flushGate: Promise<void> | null = null;
  /** Set, `flush` throws this once its gate (if any) resolves. */
  flushRejection: Error | null = null;
  /**
   * Settles the moment `flush` is entered — before it ever awaits its own
   * gate. A caller that needs to observe "flush has been entered" awaits
   * this rather than counting the production call's own microtask hops
   * (`finished` → `source.finish`'s wrapper `.then` → its `.catch` result →
   * `OpusCapture`'s own continuation): that count is an implementation
   * detail of the real `stop()`, not something this fixture should guess at.
   */
  readonly flushEntered: Promise<void>;
  private resolveFlushEntered: (() => void) | null = null;
  private readonly output: EncodeOutput;
  private readonly onError: (error: unknown) => void;

  constructor(init: { output: EncodeOutput; error: (error: unknown) => void }) {
    this.output = init.output;
    this.onError = init.error;
    this.flushEntered = new Promise((resolve) => {
      this.resolveFlushEntered = resolve;
    });
    FakeAudioEncoder.instances.push(this);
  }

  configure(config: unknown): void {
    if (this.configureThrows !== null) throw this.configureThrows;
    this.configureCalls.push(config);
    this.state = "configured";
  }

  encode(data: FakeAudioData): void {
    this.encodeCalls.push(data);
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
    this.resolveFlushEntered?.();
    await this.flushGate;
    if (this.flushRejection !== null) throw this.flushRejection;
  }

  close(): void {
    this.closeCalls += 1;
    this.state = "closed";
  }

  /** Simulates the encoder emitting one packet, as its real output callback would. */
  emit(
    bytes: Uint8Array,
    opts: { durationUs?: number; opusHead?: Uint8Array } | undefined,
  ): void {
    this.output(
      fakeChunk(bytes, opts?.durationUs ?? FRAME_US),
      opts?.opusHead === undefined
        ? undefined
        : {
            decoderConfig: {
              sampleRate: OPUS_RATE,
              numberOfChannels: CHANNELS,
              description: opts.opusHead,
            },
          },
    );
  }

  /** Simulates the encoder's own `error` callback firing. */
  fail(error: unknown): void {
    this.onError(error);
  }
}

class FakeAudioContext {
  readonly sampleRate = OPUS_RATE;
  readonly audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
}

const tap: MixTap = () => () => undefined;

function pcmBuffer(frames: number): ArrayBuffer {
  return new Int16Array(frames * CHANNELS).fill(1).buffer;
}

beforeEach(() => {
  FakeAudioWorkletNode.instances.length = 0;
  FakeAudioEncoder.instances.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
  vi.stubGlobal("AudioData", FakeAudioData);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FakeHandlers {
  readonly onFirstFrame: Mock<(clockSeconds: number) => void>;
  readonly onChunk: Mock<(bytes: Uint8Array) => void>;
  readonly onError: Mock<(error: unknown) => void>;
}

async function openCapture(): Promise<{
  readonly context: AudioContext;
  readonly node: FakeAudioWorkletNode;
  readonly encoder: FakeAudioEncoder;
  readonly handlers: FakeHandlers;
  readonly capture: MixCapture;
}> {
  // `AudioContext` is stubbed to `FakeAudioContext` above, so this really
  // constructs one — typed as the real `AudioContext` with no cast, since
  // that is what the global now resolves to at runtime.
  const context = new AudioContext();
  const capture = await openMixCapture(context, tap, "compressed");
  const handlers: FakeHandlers = {
    onFirstFrame: vi.fn<(clockSeconds: number) => void>(),
    onChunk: vi.fn<(bytes: Uint8Array) => void>(),
    onError: vi.fn<(error: unknown) => void>(),
  };
  capture.start(handlers);
  const [node] = FakeAudioWorkletNode.instances;
  const [encoder] = FakeAudioEncoder.instances;
  return { context, node, encoder, handlers, capture };
}

describe("openMixCapture, compressed", () => {
  it("refuses a context not opened at 48 kHz, asking for none of its nodes", async () => {
    const context = new AudioContext();
    Reflect.set(context, "sampleRate", 44_100);
    await expect(openMixCapture(context, tap, "compressed")).rejects.toThrow();
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
  });

  it("configures the encoder once for Opus at the frame it must emit, and forwards the worklet's first frame untouched", async () => {
    const { encoder, handlers, node } = await openCapture();
    node.port.send({ type: "first-frame", time: 12.5 });

    expect(handlers.onFirstFrame).toHaveBeenCalledExactlyOnceWith(12.5);
    expect(encoder.configureCalls).toEqual([
      {
        codec: "opus",
        sampleRate: OPUS_RATE,
        numberOfChannels: CHANNELS,
        bitrate: 128_000,
        // "ogg" is the format that carries an `OpusHead`, and Chromium
        // refuses to configure for it ("Opus Ogg format is unsupported");
        // raw "opus" packets are asked for instead, and the encoder's own
        // `OpusHead` is read from the first packet's `decoderConfig`.
        opus: { format: "opus", frameDuration: FRAME_US, usedtx: false },
      },
    ]);
  });

  it("reports a configure that throws as the original error, never starts the worklet, and fails stop() with that same error, not a finish-before-start one", async () => {
    const context = new AudioContext();
    const capture = await openMixCapture(context, tap, "compressed");
    const [encoder] = FakeAudioEncoder.instances;
    const [node] = FakeAudioWorkletNode.instances;
    // The real failure Chromium raises for the format this used to ask for.
    const configureError = new Error("Opus Ogg format is unsupported");
    encoder.configureThrows = configureError;
    const handlers: FakeHandlers = {
      onFirstFrame: vi.fn<(clockSeconds: number) => void>(),
      onChunk: vi.fn<(bytes: Uint8Array) => void>(),
      onError: vi.fn<(error: unknown) => void>(),
    };

    capture.start(handlers);

    // The exact instance `configure` threw, not a wrapped or re-described one.
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(configureError);
    // `configure` throwing is what stops this before the worklet is ever
    // asked to start: nothing was posted to its port.
    expect(node.port.posted).toEqual([]);

    // `stop()` must report the same failure, not the worklet's own "asked to
    // finish before it started" — proof that `throwIfFailed` is checked
    // before `source.finish()` is ever called, not after it rejects.
    await expect(capture.stop()).rejects.toBe(configureError);
    // Cleanup still ran: the worklet's port released, the encoder closed.
    expect(node.port.closeCalls).toBe(1);
    expect(encoder.closeCalls).toBe(1);
  });

  it("resolves stop() only after the worklet's last frames AND the encoder's flush, delivering the header and the closing cluster in that order", async () => {
    const { capture, encoder, handlers, node } = await openCapture();
    node.port.send({ type: "pcm", buffer: pcmBuffer(400) });
    // Fed to the encoder as 16-bit interleaved stereo at the recording's own
    // rate, timestamped from zero by the samples submitted so far — never
    // from the wall clock, since the packet sequence is the file's timeline.
    expect(encoder.encodeCalls).toHaveLength(1);
    expect(encoder.encodeCalls[0].init).toMatchObject({
      format: "s16",
      sampleRate: OPUS_RATE,
      numberOfChannels: CHANNELS,
      numberOfFrames: 400,
      timestamp: 0,
    });
    // Each buffer handed to the encoder is released right away: nothing here
    // holds its own copy of the audio data past the `encode` call.
    expect(encoder.encodeCalls[0].closed).toBe(true);
    encoder.emit(new Uint8Array([0xaa]), { opusHead: opusHead(312) });
    expect(handlers.onChunk).toHaveBeenCalledTimes(1); // the header, on the first packet

    const flushGate = Promise.withResolvers<void>();
    encoder.flushGate = flushGate.promise;
    const stopping = capture.stop();
    // The worklet's own last frames: a batch arriving AFTER `stop()` asked
    // for them, but before it hears "finished", is still real audio the
    // file must account for — this is what makes it "the LAST frames" and
    // not merely "whatever had already arrived".
    node.port.send({ type: "pcm", buffer: pcmBuffer(500) });
    expect(encoder.encodeCalls).toHaveLength(2);
    node.port.send({ type: "finished", frames: 900, droppedFrames: 0 });
    await encoder.flushEntered;
    // The worklet has handed over its last frames, but the encoder has not
    // flushed yet: nothing more may be delivered, and stop() may not settle.
    expect(encoder.flushCalls).toBe(1);
    expect(handlers.onChunk).toHaveBeenCalledTimes(1);

    // The encoder's own flush work emits its last buffered packet before its
    // `flush()` promise itself settles: this packet is real audio from the
    // SECOND pcm batch, and must still reach the closing cluster once it is
    // built, even though it arrived while the gate above is still held.
    encoder.emit(new Uint8Array([0xbb]), undefined);
    expect(handlers.onChunk).toHaveBeenCalledTimes(1); // still just the header

    flushGate.resolve();
    const summary = await stopping;

    // 900 submitted samples across both batches is exactly what the worklet
    // itself reported: `closeFile` throws on a mismatch, so a `summary` this
    // resolves with is already proof the two batches were reconciled as one.
    // (Two 20 ms packets, a 312-sample pre-skip, 900 submitted samples: 960·2
    // − 312 − 900 = 708 samples of trailing padding, inside one frame.)
    expect(summary).toEqual({ frames: 900, droppedFrames: 0 });
    expect(handlers.onChunk).toHaveBeenCalledTimes(2);
    const [header] = handlers.onChunk.mock.calls[0];
    expect(Array.from(header.subarray(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    // The encoder is let go once stop() is done with it, win or lose.
    expect(encoder.closeCalls).toBe(1);
  });

  it("fails and stops delivering once the worklet raises a processor error, and rejects stop() with it rather than a short summary", async () => {
    const { capture, handlers, node } = await openCapture();
    node.port.send({ type: "pcm", buffer: pcmBuffer(600) });

    node.dispatchEvent(new Event("processorerror"));
    // Exactly once: the worklet both rejects the wait for its last frames
    // AND reports through `onFailure` for the same error — `fail`'s own
    // idempotency is what keeps `onError` from hearing it twice.
    expect(handlers.onError).toHaveBeenCalledTimes(1);

    // The same instance `onError` was given, not merely "an" error.
    await expect(capture.stop()).rejects.toBe(
      handlers.onError.mock.calls[0][0],
    );
    expect(handlers.onChunk).not.toHaveBeenCalled();
  });

  it("a worklet failure landing while stop() is already waiting on finish() notifies onError exactly once, and stop() rejects with that same error", async () => {
    const { capture, handlers, node } = await openCapture();
    node.port.send({ type: "pcm", buffer: pcmBuffer(600) });

    // Not awaited: this must already be sitting in `await source.finish()`
    // — past `throwIfFailed`, which runs synchronously before it — when the
    // failure below lands. Calling `stop()` runs synchronously up to its
    // first `await`, which is exactly that `finish()` call, so this is
    // guaranteed by ordinary JS semantics rather than by timing it.
    const stopping = capture.stop();

    node.dispatchEvent(new Event("processorerror"));

    // Checked only after `stopping` has fully settled: the duplicate this
    // guards against — the old direct `handlers.onError(error)` call in
    // `finish`'s own catch, instead of the idempotent `fail` — would fire
    // asynchronously, once `source.finish()` itself rejects, which lands
    // after this dispatch but before `stopping` settles. Reading the count
    // any earlier would miss it.
    await expect(stopping).rejects.toBeInstanceOf(Error);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    await expect(stopping).rejects.toBe(handlers.onError.mock.calls[0][0]);
  });

  it("fails and stops delivering once the encoder's own error callback fires, with no further packets taken", async () => {
    const { capture, encoder, handlers } = await openCapture();
    const failure = new Error("the encoder could not continue");
    encoder.fail(failure);

    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(failure);
    // A packet emitted after the failure is not a success coming back late.
    encoder.emit(new Uint8Array([0xaa]), { opusHead: opusHead(312) });
    expect(handlers.onChunk).not.toHaveBeenCalled();

    // Already failed before stop() is even asked for: `throwIfFailed` exits
    // this immediately, and the worklet is never asked to finish at all.
    await expect(capture.stop()).rejects.toBe(failure);
  });

  it("an earlier encoder failure recorded while stop() awaits the worklet survives a flush that also rejects, with onError still heard exactly once", async () => {
    const { capture, encoder, handlers, node } = await openCapture();
    node.port.send({ type: "pcm", buffer: pcmBuffer(600) });
    encoder.emit(new Uint8Array([0xaa]), { opusHead: opusHead(312) });

    const stopping = capture.stop();
    // The encoder fails while stop() is still waiting on the worklet's last
    // frames — well before flush ever runs.
    const failure = new Error("the encoder could not continue");
    encoder.fail(failure);
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(failure);
    // Flush runs anyway, and this one ALSO rejects: `fail` is idempotent, so
    // this later error must not replace the one `onError` already heard.
    encoder.flushRejection = new Error("the encoder could not flush");

    node.port.send({ type: "finished", frames: 600, droppedFrames: 0 });

    await expect(stopping).rejects.toBe(failure);
    expect(encoder.flushCalls).toBe(1);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(encoder.closeCalls).toBe(1);
  });

  it("a flush that rejects on its own, with a valid worklet summary and no earlier failure, reports onError once and rejects stop() with that error", async () => {
    const { capture, encoder, handlers, node } = await openCapture();
    node.port.send({ type: "pcm", buffer: pcmBuffer(600) });
    encoder.emit(new Uint8Array([0xaa]), { opusHead: opusHead(312) });
    const flushError = new Error("the encoder could not flush");
    encoder.flushRejection = flushError;

    const stopping = capture.stop();
    // The worklet itself hands over exactly what was submitted: nothing here
    // is what fails this — only the flush below is.
    node.port.send({ type: "finished", frames: 600, droppedFrames: 0 });

    await expect(stopping).rejects.toBe(flushError);
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(flushError);
  });

  it("rejects stop() rather than close a file whose packets cannot account for the frames the worklet actually captured", async () => {
    const { capture, encoder, node } = await openCapture();
    node.port.send({ type: "pcm", buffer: pcmBuffer(600) });
    encoder.emit(new Uint8Array([0xaa]), { opusHead: opusHead(312) });

    const stopping = capture.stop();
    // The worklet counted 601 frames; only 600 reached the encoder.
    node.port.send({ type: "finished", frames: 601, droppedFrames: 0 });

    await expect(stopping).rejects.toThrow();
    // Rejecting still lets the encoder go; a failed close is not a leaked one.
    expect(encoder.closeCalls).toBe(1);
  });

  it("rejects stop() rather than close a file whose trailing padding does not fit within one frame", async () => {
    const { capture, encoder, node } = await openCapture();
    // Two packets, no real samples submitted and no pre-skip: 960·2 − 0 − 0 =
    // 1920 samples of padding, nowhere near a trailing partial frame.
    encoder.emit(new Uint8Array([0xaa]), { opusHead: opusHead(0) });
    encoder.emit(new Uint8Array([0xbb]), undefined);

    const stopping = capture.stop();
    node.port.send({ type: "finished", frames: 0, droppedFrames: 0 });

    await expect(stopping).rejects.toThrow();
  });

  it("rejects stop() rather than close a file whose encoder emitted nothing at all for frames it was given", async () => {
    const { capture, node } = await openCapture();
    node.port.send({ type: "pcm", buffer: pcmBuffer(600) });

    const stopping = capture.stop();
    node.port.send({ type: "finished", frames: 600, droppedFrames: 0 });

    await expect(stopping).rejects.toThrow();
  });

  it("rejects when the worklet's own wait for the last frames times out, without a short summary standing in for a complete one", async () => {
    vi.useFakeTimers();
    try {
      const { capture, node } = await openCapture();
      node.port.send({ type: "pcm", buffer: pcmBuffer(600) });
      const stopping = capture.stop();
      // Attached before the clock moves: `stopping` must not settle, one way
      // or the other, before this is already listening for it.
      const rejected = expect(stopping).rejects.toThrow();
      // No "finished" message ever arrives.
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

async function openLosslessCapture(tapOverride: MixTap | undefined): Promise<{
  readonly node: FakeAudioWorkletNode;
  readonly handlers: FakeHandlers;
  readonly capture: MixCapture;
}> {
  const context = new AudioContext();
  const capture = await openMixCapture(context, tapOverride ?? tap, "lossless");
  const handlers: FakeHandlers = {
    onFirstFrame: vi.fn<(clockSeconds: number) => void>(),
    onChunk: vi.fn<(bytes: Uint8Array) => void>(),
    onError: vi.fn<(error: unknown) => void>(),
  };
  capture.start(handlers);
  const [node] = FakeAudioWorkletNode.instances;
  return { node, handlers, capture };
}

describe("openMixCapture, lossless", () => {
  it("a worklet failure that both rejects the last-frames wait and reports through onFailure notifies onError exactly once, even when onError reenters stop()", async () => {
    // A property on a holder, not a bare `let`: TS does not track a nested
    // closure's assignment back into an outer local for narrowing, so a
    // plain `let stopping: Promise<CaptureSummary> | null = null;` reads as
    // still `null` at the check below however the closure runs — this reads
    // it from the object instead, where that narrowing does not apply.
    const reentered: { stopping: Promise<CaptureSummary> | null } = {
      stopping: null,
    };
    const { node, handlers, capture } = await openLosslessCapture(undefined);
    // Reassign `onError`'s implementation after `start()`, since the
    // reentrancy under test is `SessionRecorder.ioFailed` answering
    // `onError` by calling `stop()` straight back into this same capture.
    handlers.onError.mockImplementation(() => {
      reentered.stopping = capture.stop();
    });

    node.dispatchEvent(new Event("processorerror"));

    const { stopping } = reentered;
    if (stopping === null) throw new Error("onError never reentered stop()");
    // The reentrant `stop()` here takes the early, already-failed exit (its
    // own failure is set, synchronously, before `onError` — and so this
    // mock — ever runs), so this never reaches the `finish` catch; the case
    // below covers that path instead. Still checked only after it settles.
    await expect(stopping).rejects.toBeInstanceOf(Error);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    await expect(stopping).rejects.toBe(handlers.onError.mock.calls[0][0]);
  });

  it("a pcm batch arriving after the worklet has already failed delivers nothing further, even with a stop() already waiting on finish()", async () => {
    const { node, handlers, capture } = await openLosslessCapture(undefined);
    const buffer = pcmBuffer(100);
    node.port.send({ type: "pcm", buffer });
    // Ordinary delivery works, and hands the frames through untransformed —
    // without this, the gate below could not tell "gated after failure"
    // apart from "never delivers in the first place".
    expect(handlers.onChunk).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array(buffer),
    );

    // Not awaited: this must already be sitting in `await source.finish()`
    // when the failure below lands — the one path the reentrant-stop case
    // above cannot reach, since that one's `stop()` always takes the early,
    // already-failed exit instead.
    const stopping = capture.stop();

    node.dispatchEvent(new Event("processorerror"));
    // Late audio the worklet still had in flight when it failed: the error
    // and the frames travel on two different queues with no order between
    // them, so a batch handed over before the processor threw can still
    // arrive after the failure has already been reported.
    node.port.send({ type: "pcm", buffer: pcmBuffer(100) });

    await expect(stopping).rejects.toBeInstanceOf(Error);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    await expect(stopping).rejects.toBe(handlers.onError.mock.calls[0][0]);
    expect(handlers.onChunk).toHaveBeenCalledTimes(1);
  });

  it("a tap that throws on start fails the capture, and stop() rejects with that same error at once rather than waiting out the worklet's own 2 s deadline", async () => {
    vi.useFakeTimers();
    try {
      const tapError = new Error("could not tap the mix");
      const throwingTap: MixTap = () => {
        throw tapError;
      };
      const { node, handlers, capture } =
        await openLosslessCapture(throwingTap);

      expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(tapError);

      const stopping = capture.stop();
      const rejected = expect(stopping).rejects.toBe(tapError);
      // No timer advance at all: a `stop()` that fell through to the
      // worklet's own "did not hand over its last frames" wait would need
      // this clock to move 2 s before settling either way, and this must
      // settle on its own recorded failure without that.
      await rejected;
      // Cleanup still ran promptly, not only after a deadline would have.
      expect(node.port.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
