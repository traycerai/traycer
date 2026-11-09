import { MIX_DIRECTORS } from "@/lib/soundtrack/directors";
import type {
  RecordingFile,
  RecordingQuality,
  RecordingSaveChannel,
} from "@/lib/soundtrack/recording";
import {
  SessionRecorder,
  type RecordingOutcome,
} from "@/lib/soundtrack/session-recorder";
import {
  SoundtrackSession,
  type SoundtrackPorts,
} from "@/lib/soundtrack/session";
import type { MixSignals } from "@/lib/soundtrack/signals";
import type { StemSource } from "@/lib/soundtrack/stems";
import type { VariableTrack } from "@/lib/soundtrack/variable-sound";
import type { SoundtrackLogRelay } from "@/lib/soundtrack/session-log";
import { openWebAudioPorts } from "@/lib/soundtrack/web-audio-ports";
import { readOpusPreSkip } from "@/lib/soundtrack/webm-opus";

/**
 * Browser fixture for a real recording of the mix: the real Web Audio ports,
 * the real player on a one-layer track whose only sample is a test tone made
 * here, and the real capture (worklet, and for "compressed" the real
 * `AudioEncoder`), writing to a save channel that keeps the bytes in memory.
 * The page then decodes what it recorded and finds each tone's onset in it,
 * to set beside the start the log gave the same sample.
 *
 * WHY IT CANNOT BE A JSDOM TEST. jsdom has no audio clock, no audio worklet
 * and no `AudioEncoder`; only a browser renders and encodes the frames whose
 * timing is the claim. See `browser-tests/soundtrack-recording.spec.ts`.
 */

const TONE_HZ = 1000;
const TONE_AMPLITUDE = 0.8;
const TONE_SECONDS = 0.25;
// Seconds of music before a recording started in a pause is held.
const LEAD_SECONDS = 1;
// The player fades every sample in over this long (`SAMPLE_FADE_SECONDS`).
const SAMPLE_FADE_SECONDS = 0.01;
// An onset is the first sample louder than this; the ideal tone crosses it
// a known number of frames after its start, which is taken off.
const ONSET_THRESHOLD = 0.02;
// Where around a logged start an onset is looked for.
const ONSET_SEARCH_SECONDS = 0.15;
/**
 * The one rate a recording runs at: `openWebAudioPorts` opens the context
 * asking for this, resampling on its way to the speakers if the device is
 * at another rate, so there is no "device rate" left to probe here.
 */
const SAMPLE_RATE = 48_000;

interface RecordRequest {
  readonly quality: RecordingQuality;
  /**
   * Seconds of the audio clock the music plays for after the last Play, or the
   * whole way through when nothing is paused.
   */
  readonly seconds: number;
  /**
   * Holds the main thread for `forMs` every `everyMs` while recording, so the
   * capture is shown to keep its frames while the page is busy; null leaves it
   * idle.
   */
  readonly busy: { readonly everyMs: number; readonly forMs: number } | null;
  /**
   * Holds the main thread for this long right as the recording starts, so a
   * page busy right then cannot delay the worklet's queued first-frame
   * message past the window this test checks; null holds nothing. The value
   * the worklet reports is read on the AUDIO thread, inside its own
   * `process()`, before that message is ever posted — a main-thread stall
   * can only delay when the page gets to it, never what it says. This is the
   * real boundary the claim rests on, not a delay timed off some unrelated
   * synchronous call returning.
   */
  readonly stallAfterStartMs: number | null;
  /**
   * Which call to the real `AudioEncoder.encode`, counting from 1, throws
   * instead of encoding, as a codec that could not take a frame would; null
   * fails nothing. Only the compressed capture's worklet frames ever reach
   * this call.
   */
  readonly failEncodeAt: number | null;
  /**
   * Pauses the session this many clock seconds into the recording and holds it
   * for `holdSeconds` of wall time from the moment the context reports
   * suspended.
   */
  readonly pause: {
    readonly afterSeconds: number;
    readonly holdSeconds: number;
  } | null;
  /**
   * Pauses the session and starts the recording once the context reports
   * suspended; it is held this many wall seconds from that moment.
   */
  readonly startHeldForSeconds: number | null;
  /** Where the recording ends: after the music is back, or in the pause. */
  readonly stop: "playing" | "paused" | "refused-resume";
}

interface Recorded {
  readonly outcome: RecordingOutcome;
  readonly audioBytes: number;
  readonly logLines: readonly unknown[];
  readonly sampleRate: number;
  readonly decodedSeconds: number;
  /** The decoder's own reported frame count; null for a WAV. */
  readonly decodedFrames: number | null;
  /**
   * The real `decodeAudioData` error, when the recording's own bytes could not
   * be decoded; null when they decoded, or when there were none to try (an
   * `audioBytes` of 0 is its own, honest "nothing recorded", never folded into
   * this). A genuinely saved recording decoding under this is a defect, not
   * something analysis may paper over with a zeroed `decodedSeconds`.
   */
  readonly decodeError: string | null;
  /**
   * Mean-square energy of the decoded left channel over the tone and the
   * following gap of ONE actually-logged, actually-complete, uninterrupted
   * sample — never a position this fixture assumed or inferred — picked by
   * `analyse` itself from the real log. Null when decoding failed, or when no
   * logged sample's tone-plus-gap fits inside the decoded audio without
   * crossing a pause.
   */
  readonly audibleTone: {
    /** That sample's own logged `start`, in the log's relative seconds. */
    readonly sampleStartSeconds: number;
    readonly toneEnergy: number;
    readonly gapEnergy: number;
  } | null;
  /** Per logged sample: its onset in the audio minus its logged start, in ms. */
  readonly onsetOffsetsMs: readonly number[];
  /** Interleaved 16-bit stereo frames the WAV holds; null for WebM. */
  readonly wavFrames: number | null;
  /** Per logged sample, parallel to `onsetOffsetsMs`: its logged start, in s. */
  readonly onsetStarts: readonly number[];
  /** Bytes the log file holds. */
  readonly logBytes: number;
  /** How many times the recording's files were closed. */
  readonly closes: number;
  /** Wall-clock seconds from the recording listening to the stop. */
  readonly wallSeconds: number;
  /** Wall seconds the context was reported suspended, up to the stop. */
  readonly suspendedSeconds: number;
  /** How far the audio clock moved while the context was reported suspended. */
  readonly clockDuringSuspensionSeconds: number;
  /**
   * Audio-clock seconds to the first suspension the context reported after the
   * recording began listening, from the capture being asked for and from the
   * listening; a recording's time starts at its first frame, between the two.
   * Null with no such suspension.
   */
  readonly clockToSuspension: {
    readonly fromCapture: number;
    readonly fromListening: number;
  } | null;
  /** Wall-clock ms the stop took, when the fixture asked for it; else null. */
  readonly stopTookMs: number | null;
  /**
   * With `stallAfterStartMs`: the real worklet's own clock, read on the audio
   * thread before the stall ran at all, and the context's `currentTime` read
   * right after the stall, just before the message was forwarded unchanged.
   * Null without a stall.
   */
  readonly firstFrameStall: {
    readonly firstFrameClockSeconds: number | null;
    readonly clockAfterStallSeconds: number | null;
  } | null;
  /**
   * The audio clock the first "sample" log event carries as its own `start`,
   * read directly off `SoundtrackPorts.log` before `SessionRecorder` ever
   * turns it into the log's relative time; null if no sample sounded.
   */
  readonly firstSampleStartClockSeconds: number | null;
  /**
   * Each packet's distance from the one before it, in ms, over the whole
   * file; null for a WAV. This is the container's own 20 ms media clock, one
   * step per Opus frame in the packet SEQUENCE — never the wall-clock cadence
   * the worklet's batches actually arrive in (bursty, since a batch holds a
   * non-whole number of 20 ms frames), and never widened by a pause: a
   * suspended context simply stops producing, so the file is shorter, not
   * holed.
   */
  readonly packetGapsMs: readonly number[];
  /** The real encoder's own pre-skip, read from its `OpusHead`; null for a WAV. */
  readonly opusPreSkipSamples: number | null;
  /** Packets the file actually holds; null for a WAV. */
  readonly opusPacketCount: number | null;
  /** The last packet's own discard padding, in ns, as the file states it. */
  readonly opusDiscardPaddingNs: number | null;
  /** With `failEncodeAt`: frames submitted by the encode calls before it. */
  readonly framesSubmittedBeforeFailure: number | null;
  /** With `failEncodeAt`: how many encode calls were made after the failure. */
  readonly encodeCallsAfterFailure: number | null;
}

const track: VariableTrack = {
  name: "test-tone",
  title: "Test tone",
  lengthSeconds: 600,
  alignmentSeconds: 0.25,
  layers: [
    {
      name: "tone",
      variants: 1,
      role: null,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    },
  ],
  states: [
    {
      name: "only",
      layersProperties: [
        {
          enabled: true,
          startPause: [0.5, 0.5],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [0.25, 0.25],
          playsPerRun: null,
        },
      ],
      numberOfEnabledLayers: [1, 1],
    },
  ],
  intro: null,
  outro: null,
  phases: [],
};

function toneBuffer(sampleRate: number): AudioBuffer {
  const length = Math.round(TONE_SECONDS * sampleRate);
  const buffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate });
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] =
      TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / sampleRate);
  }
  return buffer;
}

/** Frames after its start that the faded-in tone first passes the threshold. */
function idealOnsetFrames(sampleRate: number): number {
  for (let index = 0; ; index += 1) {
    const fade = Math.min(1, index / (SAMPLE_FADE_SECONDS * sampleRate));
    const value =
      TONE_AMPLITUDE *
      fade *
      Math.sin((2 * Math.PI * TONE_HZ * index) / sampleRate);
    if (Math.abs(value) > ONSET_THRESHOLD) return index;
  }
}

function memoryChannel(): {
  readonly channel: RecordingSaveChannel;
  readonly files: Record<RecordingFile, Uint8Array[]>;
  readonly header: { bytes: Uint8Array | null };
  readonly closes: { count: number };
} {
  const files: Record<RecordingFile, Uint8Array[]> = { audio: [], log: [] };
  const header: { bytes: Uint8Array | null } = { bytes: null };
  const closes = { count: 0 };
  return {
    files,
    header,
    closes,
    channel: {
      open: () =>
        Promise.resolve({
          kind: "opened",
          recordingId: "fixture",
          name: "session-fixture",
        }),
      append: (_recordingId, file, bytes) => {
        files[file].push(bytes.slice());
        return Promise.resolve({ kind: "ok" });
      },
      close: (_recordingId, audioHeader) => {
        closes.count += 1;
        header.bytes = audioHeader;
        return Promise.resolve({ kind: "ok" });
      },
      reveal: () => Promise.resolve(true),
      onFinishRequested: () => () => undefined,
    },
  };
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function holdMainThread(forMs: number): void {
  const until = performance.now() + forMs;
  while (performance.now() < until) {
    // Busy on purpose: the claim is about a page that is.
  }
}

/**
 * Captured once the real "first-frame" message has been seen and forwarded.
 */
interface FirstFrameStall {
  /** `message.time`: the audio clock the worklet itself read, on its own
   * thread, before this stall ever ran. */
  readonly firstFrameClockSeconds: number | null;
  /** The context's `currentTime` read right after the stall, just before the
   * unchanged message is handed to the real listener. */
  readonly clockAfterStallSeconds: number | null;
}

/**
 * Wraps the ONE "message" listener `PcmWorkletSource.start` registers on the
 * worklet's port — never adding a second listener of its own — so that the
 * first "first-frame" message to arrive holds the main thread for `forMs`
 * before being forwarded, unchanged, to that real listener. Every later
 * message (every "pcm" batch, "finished") is forwarded at once.
 *
 * This is the real boundary a busy page delays: a worklet's first `process()`
 * call happens on the audio thread regardless, and posts its message with the
 * clock it read then: `firstFrameClockSeconds`. Only the PAGE's turn to act on
 * that message — here, and nowhere else — is what a main-thread stall can
 * ever hold up.
 */
function stallFirstFrameDelivery(
  context: AudioContext,
  forMs: number,
): { readonly result: FirstFrameStall; readonly restore: () => void } {
  const { prototype } = MessagePort;
  const original: unknown = Reflect.get(prototype, "addEventListener");
  if (typeof original !== "function") {
    throw new Error("No MessagePort.addEventListener");
  }
  const result: { -readonly [K in keyof FirstFrameStall]: FirstFrameStall[K] } =
    {
      firstFrameClockSeconds: null,
      clockAfterStallSeconds: null,
    };
  let wrapped = false;
  const restore = (): void => {
    Reflect.set(prototype, "addEventListener", original);
  };
  Reflect.set(
    prototype,
    "addEventListener",
    function (
      this: MessagePort,
      type: string,
      listener: unknown,
      options: boolean | AddEventListenerOptions | undefined,
    ): void {
      if (wrapped || type !== "message" || typeof listener !== "function") {
        Reflect.apply(original, this, [type, listener, options]);
        return;
      }
      wrapped = true;
      restore();
      const wrapping = (event: MessageEvent): void => {
        const message: unknown = event.data;
        if (
          typeof message === "object" &&
          message !== null &&
          Reflect.get(message, "type") === "first-frame"
        ) {
          const time: unknown = Reflect.get(message, "time");
          result.firstFrameClockSeconds =
            typeof time === "number" ? time : null;
          holdMainThread(forMs);
          result.clockAfterStallSeconds = context.currentTime;
        }
        Reflect.apply(listener, this, [event]);
      };
      Reflect.apply(original, this, [type, wrapping, options]);
    },
  );
  return { result, restore };
}

/**
 * Until restored, the `index`th call to the real `AudioEncoder.encode`
 * throws instead of encoding, as a codec that could not take a frame would.
 * Counts the frames of the calls made before it, and the calls made after.
 */
function failEncodeCall(index: number): {
  readonly before: number[];
  readonly after: { count: number };
  readonly restore: () => void;
} {
  const { prototype } = AudioEncoder;
  const encode: unknown = Reflect.get(prototype, "encode");
  if (typeof encode !== "function") throw new Error("No AudioEncoder.encode");
  const before: number[] = [];
  const after = { count: 0 };
  let calls = 0;
  Reflect.set(
    prototype,
    "encode",
    function failingEncode(this: AudioEncoder, data: AudioData): void {
      calls += 1;
      if (calls === index) {
        data.close();
        throw new Error("The encoder could not take this frame");
      }
      if (calls < index) before.push(data.numberOfFrames);
      else after.count += 1;
      Reflect.apply(encode, this, [data]);
    },
  );
  return {
    before,
    after,
    restore: () => {
      Reflect.set(prototype, "encode", encode);
    },
  };
}

interface EncodeFailure {
  /** Set only with `failEncodeAt`. */
  readonly before: number[] | null;
  readonly after: { readonly count: number } | null;
  readonly restore: () => void;
}

/** The encode failure a request asks for, set up now; a no-op without one. */
function installEncodeFailure(request: RecordRequest): EncodeFailure {
  if (request.failEncodeAt === null) {
    return { before: null, after: null, restore: () => undefined };
  }
  const { before, after, restore } = failEncodeCall(request.failEncodeAt);
  return { before, after, restore };
}

/** What `failEncodeAt` asked for, counted; nulls when it asked for nothing. */
function encodeFailureCounts(
  failure: EncodeFailure,
): Pick<Recorded, "framesSubmittedBeforeFailure" | "encodeCallsAfterFailure"> {
  if (failure.before === null || failure.after === null) {
    return {
      framesSubmittedBeforeFailure: null,
      encodeCallsAfterFailure: null,
    };
  }
  return {
    framesSubmittedBeforeFailure: failure.before.reduce(
      (sum, frames) => sum + frames,
      0,
    ),
    encodeCallsAfterFailure: failure.after.count,
  };
}

/** A moment on both clocks. */
interface Moment {
  /** `performance.now` ms. */
  readonly ms: number;
  /** The audio clock. */
  readonly clock: number;
}

/** A state the context reported, and the moment it was reported. */
interface StateChange extends Moment {
  readonly state: AudioContextState;
}

interface ContextWatch {
  context: AudioContext | null;
  readonly changes: StateChange[];
  /** When the recording last asked for its capture; null before it does. */
  captureAskedAt: Moment | null;
}

/**
 * The ports over a context that this watch sees: its changes and suspends, and
 * when a capture is asked for.
 */
function openWatchedPorts(
  watch: ContextWatch,
  volume: number,
): SoundtrackPorts {
  const Real = window.AudioContext;
  class WatchedContext extends Real {
    constructor(options: AudioContextOptions | undefined) {
      super(options);
      watch.context = this;
      this.addEventListener("statechange", () => {
        watch.changes.push({
          state: this.state,
          ms: performance.now(),
          clock: this.currentTime,
        });
      });
    }
  }
  window.AudioContext = WatchedContext;
  try {
    const ports = openWebAudioPorts({ tracks: [] }, volume);
    return {
      ...ports,
      captureMix: (quality) => {
        watch.captureAskedAt = {
          ms: performance.now(),
          clock: ports.output.currentTime(),
        };
        return ports.captureMix(quality);
      },
    };
  } finally {
    window.AudioContext = Real;
  }
}

/**
 * Delegates to the relay's own `write`, never calling `listen` (it holds only
 * one listener, and `SessionRecorder` already owns that slot): captures the
 * `start` of the first "sample" event, exactly as the engine wrote it, before
 * any relative-time rewriting.
 */
function captureFirstSampleStart(log: SoundtrackLogRelay): {
  readonly value: { current: number | null };
  readonly restore: () => void;
} {
  const original = log.write.bind(log);
  const value: { current: number | null } = { current: null };
  let seen = false;
  log.write = (event) => {
    if (!seen && event.type === "sample") {
      seen = true;
      value.current = event.start;
    }
    original(event);
  };
  return {
    value,
    restore: () => {
      log.write = original;
    },
  };
}

/** What the context's reported suspensions came to, up to the stop. */
function suspension(
  changes: readonly StateChange[],
  end: Moment,
): { readonly seconds: number; readonly clockSeconds: number } {
  let seconds = 0;
  let clockSeconds = 0;
  let from: StateChange | null = null;
  for (const change of changes) {
    if (change.state === "suspended" && from === null) from = change;
    else if (change.state === "running" && from !== null) {
      seconds += (change.ms - from.ms) / 1000;
      clockSeconds += change.clock - from.clock;
      from = null;
    }
  }
  if (from !== null) {
    seconds += (end.ms - from.ms) / 1000;
    clockSeconds += end.clock - from.clock;
  }
  return { seconds, clockSeconds };
}

// EBML ids this reader descends into; every other element is read by its
// own id, if it reads it at all, or skipped by size.
const WEBM_SEGMENT = 0x18538067;
const WEBM_INFO = 0x1549a966;
const WEBM_TIMECODE_SCALE = 0x2ad7b1;
const WEBM_TRACKS = 0x1654ae6b;
const WEBM_TRACK_ENTRY = 0xae;
const WEBM_CODEC_PRIVATE = 0x63a2;
const WEBM_CLUSTER = 0x1f43b675;
const WEBM_BLOCK_GROUP = 0xa0;
const WEBM_TIMECODE = 0xe7;
const WEBM_SIMPLE_BLOCK = 0xa3;
const WEBM_BLOCK = 0xa1;
const WEBM_DISCARD_PADDING = 0x75a2;
const DESCEND: ReadonlySet<number> = new Set([
  WEBM_SEGMENT,
  WEBM_INFO,
  WEBM_TRACKS,
  WEBM_TRACK_ENTRY,
  WEBM_CLUSTER,
  WEBM_BLOCK_GROUP,
]);

/** An EBML variable-length integer at `at`: its value and byte length. */
function readVint(
  bytes: Uint8Array,
  at: number,
  keepMarker: boolean,
): { readonly value: number; readonly length: number } {
  const first = bytes[at];
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
  }
  return { value, length };
}

function bigEndianInt(bytes: Uint8Array, at: number, length: number): number {
  if (length === 0) return 0;
  let value = bytes[at] >= 0x80 ? bytes[at] - 256 : bytes[at];
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
  }
  return value;
}

function bigEndianUint(bytes: Uint8Array, at: number, length: number): number {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
  }
  return value;
}

interface WebmContainer {
  /** Each packet's own time, in ms: the cluster's own timecode plus offset. */
  readonly packetTimesMs: number[];
  /** The real encoder's own pre-skip, from its `OpusHead`; null if none. */
  readonly preSkipSamples: number | null;
  /** The last packet's own discard padding, in ns; null if none was written. */
  readonly discardPaddingNs: number | null;
}

/**
 * Reads the file exactly as a player would: never trusting what wrote it,
 * including the one thing a player must never assume — `TimecodeScale`.
 * `Timecode` and a block's offset are both TICKS of that scale, not
 * milliseconds; a reader that hard-codes Matroska's 1 ms default would
 * silently scale every packet time wrong against a writer using a different
 * one (as this one now does, at 1 µs, to keep `CodecDelay` exact).
 */
function readWebmContainer(bytes: Uint8Array): WebmContainer {
  const packetTimesMs: number[] = [];
  let preSkipSamples: number | null = null;
  let discardPaddingNs: number | null = null;
  // Matroska's own default, only used if the file omits `TimecodeScale`
  // entirely — this writer never does, but a reader should still have one.
  let timecodeScaleNs = 1_000_000;
  let clusterTicks = 0;
  let at = 0;
  while (at < bytes.length) {
    const id = readVint(bytes, at, true);
    const size = readVint(bytes, at + id.length, false);
    const body = at + id.length + size.length;
    if (DESCEND.has(id.value)) {
      at = body;
      continue;
    }
    if (id.value === WEBM_CODEC_PRIVATE) {
      preSkipSamples = readOpusPreSkip(bytes.subarray(body, body + size.value));
    } else if (id.value === WEBM_TIMECODE_SCALE) {
      timecodeScaleNs = bigEndianUint(bytes, body, size.value);
    } else if (id.value === WEBM_TIMECODE) {
      clusterTicks = bigEndianUint(bytes, body, size.value);
    } else if (id.value === WEBM_SIMPLE_BLOCK || id.value === WEBM_BLOCK) {
      const trackNumber = readVint(bytes, body, false);
      const offsetAt = body + trackNumber.length;
      const offsetTicks = bigEndianInt(bytes, offsetAt, 2);
      packetTimesMs.push(
        ((clusterTicks + offsetTicks) * timecodeScaleNs) / 1e6,
      );
    } else if (id.value === WEBM_DISCARD_PADDING) {
      discardPaddingNs = bigEndianInt(bytes, body, size.value);
    }
    at = body + size.value;
  }
  return { packetTimesMs, preSkipSamples, discardPaddingNs };
}

/**
 * Each packet's distance from the one before it, taken in the order the file
 * itself holds them — never re-sorted first. A muxer that wrote a packet out
 * of SEQUENCE is exactly the defect this is for; sorting before diffing would
 * quietly repair that ordering instead of showing it.
 */
function packetGapsMs(times: readonly number[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    gaps.push(times[index] - times[index - 1]);
  }
  return gaps;
}

/** Answers on the first animation frame where the condition holds. */
function until(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (condition()) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });
}

type Analysis = Pick<
  Recorded,
  | "decodedSeconds"
  | "decodedFrames"
  | "decodeError"
  | "audibleTone"
  | "onsetOffsetsMs"
  | "onsetStarts"
  | "wavFrames"
  | "packetGapsMs"
  | "opusPreSkipSamples"
  | "opusPacketCount"
  | "opusDiscardPaddingNs"
>;

// The tone itself, and the gap that follows it: a tone is `TONE_SECONDS`
// long, then `pauseBetweenRepetitions` of the same gives the silence before
// the next one. Both are the track's own declared recipe above, not a
// measurement or an assumed schedule position.
const TONE_PLUS_GAP_SECONDS = TONE_SECONDS + TONE_SECONDS;
// Inside the tone, past its `SAMPLE_FADE_SECONDS` fade-in.
const TONE_WINDOW_OFFSET_SECONDS = { from: 0.1, to: 0.15 };
// Well into the gap that follows, away from the fade either side of it.
const GAP_WINDOW_OFFSET_SECONDS = { from: 0.35, to: 0.4 };

/** The left channel's mean-square energy over one `[fromSeconds, toSeconds)`. */
function meanSquareEnergy(
  left: Float32Array,
  sampleRate: number,
  fromSeconds: number,
  toSeconds: number,
): number {
  const from = Math.max(0, Math.round(fromSeconds * sampleRate));
  const to = Math.min(left.length, Math.round(toSeconds * sampleRate));
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += left[index] ** 2;
  return sum / (to - from);
}

/**
 * Picks the first logged "sample" whose tone and following gap both fit
 * inside the decoded audio, and cross no logged "pause": a sample picked any
 * other way could straddle an interruption the energy comparison does not
 * account for. Null when no logged sample qualifies.
 */
function pickUninterruptedSample(
  logLines: readonly unknown[],
  decodedSeconds: number,
): number | null {
  const pauseTimes: number[] = [];
  const sampleStarts: number[] = [];
  for (const line of logLines) {
    if (typeof line !== "object" || line === null) continue;
    const type: unknown = Reflect.get(line, "type");
    if (type === "pause") {
      const t: unknown = Reflect.get(line, "t");
      if (typeof t === "number") pauseTimes.push(t);
    } else if (type === "sample") {
      const start: unknown = Reflect.get(line, "start");
      if (typeof start === "number") sampleStarts.push(start);
    }
  }
  for (const start of sampleStarts) {
    const end = start + TONE_PLUS_GAP_SECONDS;
    if (end > decodedSeconds) continue;
    if (pauseTimes.some((t) => t > start && t < end)) continue;
    return start;
  }
  return null;
}

function audibleToneFor(
  left: Float32Array,
  sampleRate: number,
  decodedSeconds: number,
  logLines: readonly unknown[],
): Analysis["audibleTone"] {
  const sampleStartSeconds = pickUninterruptedSample(logLines, decodedSeconds);
  if (sampleStartSeconds === null) return null;
  return {
    sampleStartSeconds,
    toneEnergy: meanSquareEnergy(
      left,
      sampleRate,
      sampleStartSeconds + TONE_WINDOW_OFFSET_SECONDS.from,
      sampleStartSeconds + TONE_WINDOW_OFFSET_SECONDS.to,
    ),
    gapEnergy: meanSquareEnergy(
      left,
      sampleRate,
      sampleStartSeconds + GAP_WINDOW_OFFSET_SECONDS.from,
      sampleStartSeconds + GAP_WINDOW_OFFSET_SECONDS.to,
    ),
  };
}

/**
 * Everything but the container fields, for audio nothing could be decoded
 * from: too short to hold a readable sample (no bytes, or — a real case for
 * a recording an injected failure cut off after only its header — bytes with
 * no complete cluster in them yet), or a decode that genuinely failed.
 */
function notDecodable(
  decodeError: string | null,
): Omit<
  Analysis,
  | "packetGapsMs"
  | "opusPreSkipSamples"
  | "opusPacketCount"
  | "opusDiscardPaddingNs"
> {
  return {
    decodedSeconds: 0,
    decodedFrames: null,
    decodeError,
    audibleTone: null,
    onsetOffsetsMs: [],
    onsetStarts: [],
    wavFrames: null,
  };
}

/**
 * Each logged "sample" line's onset offset, relative to the ideal onset for
 * its declared start, and the start it was measured against.
 */
function findOnsets(
  logLines: readonly unknown[],
  left: Float32Array,
  sampleRate: number,
): { readonly onsetOffsetsMs: number[]; readonly onsetStarts: number[] } {
  const ideal = idealOnsetFrames(sampleRate) / sampleRate;
  const onsetOffsetsMs: number[] = [];
  const onsetStarts: number[] = [];
  for (const line of logLines) {
    if (typeof line !== "object" || line === null) continue;
    if (Reflect.get(line, "type") !== "sample") continue;
    const start: unknown = Reflect.get(line, "start");
    if (typeof start !== "number") continue;
    const from = Math.max(
      0,
      Math.floor((start - ONSET_SEARCH_SECONDS) * sampleRate),
    );
    const to = Math.min(
      left.length,
      Math.ceil((start + ONSET_SEARCH_SECONDS) * sampleRate),
    );
    for (let index = from; index < to; index += 1) {
      if (Math.abs(left[index]) > ONSET_THRESHOLD) {
        onsetOffsetsMs.push((index / sampleRate - ideal - start) * 1000);
        onsetStarts.push(start);
        break;
      }
    }
  }
  return { onsetOffsetsMs, onsetStarts };
}

/** Decodes the recording, and finds each logged sample's onset in it. */
async function analyse(
  audio: Uint8Array,
  logLines: readonly unknown[],
  sampleRate: number,
  quality: RecordingQuality,
): Promise<Analysis> {
  const container =
    quality === "compressed" && audio.length > 0
      ? readWebmContainer(audio)
      : null;
  const containerFields: Pick<
    Analysis,
    | "packetGapsMs"
    | "opusPreSkipSamples"
    | "opusPacketCount"
    | "opusDiscardPaddingNs"
  > = {
    packetGapsMs:
      container === null ? [] : packetGapsMs(container.packetTimesMs),
    opusPreSkipSamples: container?.preSkipSamples ?? null,
    opusPacketCount: container?.packetTimesMs.length ?? null,
    opusDiscardPaddingNs: container?.discardPaddingNs ?? null,
  };
  if (audio.length === 0) return { ...notDecodable(null), ...containerFields };
  const decoder = new OfflineAudioContext(2, 1, sampleRate);
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(audio.slice().buffer);
  } catch (error) {
    // A file an injected failure cut off before its first full cluster: the
    // bytes it has are real, just not a decodable recording. Recorded as
    // `decodeError`, never silently folded into a zeroed, passing analysis —
    // a caller for whom this is NOT the expected outcome must see it.
    const message = error instanceof Error ? error.message : String(error);
    return { ...notDecodable(message), ...containerFields };
  }
  if (decoded.sampleRate !== sampleRate) {
    throw new Error(
      `Decoded at ${String(decoded.sampleRate)} Hz, not the ${String(sampleRate)} Hz asked for`,
    );
  }
  const left = decoded.getChannelData(0);
  const { onsetOffsetsMs, onsetStarts } = findOnsets(
    logLines,
    left,
    decoded.sampleRate,
  );
  return {
    decodedSeconds: decoded.duration,
    decodedFrames: decoded.length,
    decodeError: null,
    audibleTone: audibleToneFor(
      left,
      decoded.sampleRate,
      decoded.duration,
      logLines,
    ),
    onsetOffsetsMs,
    onsetStarts,
    wavFrames: quality === "lossless" ? (audio.length - 44) / 4 : null,
    ...containerFields,
  };
}

const HOME_SIGNALS: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

interface Timeline {
  readonly session: SoundtrackSession;
  readonly clock: () => number;
  readonly watch: ContextWatch;
  /** Starts the recorder, and answers once it listens. */
  readonly start: () => Promise<void>;
}

/** The music plays on for this many seconds of the audio clock. */
function musicFor(clock: () => number, seconds: number): Promise<void> {
  const target = clock() + seconds;
  return until(() => clock() >= target);
}

/** Until a wall-clock moment, in `performance.now` ms: a hold made on purpose. */
function holdUntil(ms: number): Promise<void> {
  return until(() => performance.now() >= ms);
}

/** The Pause of the request, and what follows it, up to the stop. */
async function pauseInMiddle(
  request: RecordRequest,
  pause: NonNullable<RecordRequest["pause"]>,
  { session, clock, watch }: Timeline,
): Promise<void> {
  const reported = (state: AudioContextState): Promise<void> =>
    until(() => watch.context?.state === state);
  await musicFor(clock, pause.afterSeconds);
  session.pause();
  await reported("suspended");
  if (request.stop === "paused") return;
  await holdUntil(performance.now() + pause.holdSeconds * 1000);
  if (request.stop === "refused-resume") {
    AudioContext.prototype.resume = () => Promise.reject(new Error("refused"));
    session.play();
    return;
  }
  session.play();
  await musicFor(clock, request.seconds);
}

/**
 * Plays out what the request says, up to the moment the recording stops: the
 * music, any pause and Play, and the wait. Every wait is on the audio clock or
 * on a state the context reported, but the holds, which are wall time from the
 * moment the context said suspended. Answers when the recording began
 * listening.
 */
async function runTimeline(
  request: RecordRequest,
  timeline: Timeline,
): Promise<Moment> {
  const { session, clock, watch, start } = timeline;
  if (request.startHeldForSeconds !== null) {
    session.setSignals(HOME_SIGNALS);
    await musicFor(clock, LEAD_SECONDS);
    session.pause();
    await until(() => watch.context?.state === "suspended");
  }
  const heldAtMs = performance.now();
  await start();
  const listening: Moment = { ms: performance.now(), clock: clock() };
  if (request.startHeldForSeconds === null) session.setSignals(HOME_SIGNALS);
  else {
    await holdUntil(heldAtMs + request.startHeldForSeconds * 1000);
    if (request.stop === "playing") session.play();
  }
  const busyTimer =
    request.busy === null
      ? null
      : window.setInterval(
          holdMainThread,
          request.busy.everyMs,
          request.busy.forMs,
        );
  if (request.pause !== null) {
    await pauseInMiddle(request, request.pause, timeline);
  } else if (request.stop !== "paused") {
    await musicFor(clock, request.seconds);
  }
  if (busyTimer !== null) window.clearInterval(busyTimer);
  return listening;
}

async function record(request: RecordRequest): Promise<Recorded> {
  const tone = toneBuffer(SAMPLE_RATE);
  const stems: StemSource = { load: () => Promise.resolve(tone) };
  const watch: ContextWatch = {
    context: null,
    changes: [],
    captureAskedAt: null,
  };
  const ports: SoundtrackPorts = {
    ...openWatchedPorts(watch, 0.5),
    stems,
  };
  const manifest = {
    tracks: [track],
    views: { home: [track.name], task: [], bot: [], settings: [] },
    stems: { tracks: [] },
  };
  const { channel, files, header, closes } = memoryChannel();
  let resolveStopped: (outcome: RecordingOutcome) => void = () => undefined;
  const stopped = new Promise<RecordingOutcome>((resolve) => {
    resolveStopped = resolve;
  });
  let resolveListening: () => void = () => undefined;
  const listening = new Promise<void>((resolve) => {
    resolveListening = resolve;
  });
  const recorder = new SessionRecorder({
    channel,
    ports,
    quality: request.quality,
    limitSeconds: null,
    manifest,
    director: "static",
    onListening: resolveListening,
    onProgress: () => undefined,
    onStopped: resolveStopped,
  });
  const session = new SoundtrackSession({
    manifest,
    ports,
    random: () => 0.5,
    director: MIX_DIRECTORS.static,
    resumePositions: {},
    onSounding: () => undefined,
    onResumeRefused: () => {
      recorder.stop("music-off");
      session.end();
    },
  });
  const encodeFailure = installEncodeFailure(request);
  const firstSampleStart = captureFirstSampleStart(ports.log);
  // Set only when `stallAfterStartMs` installs the one-shot `MessagePort`
  // patch; restoring it unconditionally, on every exit from the block below,
  // is what keeps a `recorder.start()` that throws before the patch ever
  // triggers from leaving it on the prototype for whatever runs next.
  const stallCleanup: { restore: (() => void) | null } = { restore: null };
  let firstFrameStall: FirstFrameStall | null = null;
  let listenedAt: Moment;
  try {
    listenedAt = await runTimeline(request, {
      session,
      start: () => {
        if (request.stallAfterStartMs !== null) {
          if (watch.context === null) {
            throw new Error("No context to stall the first frame against");
          }
          const stall = stallFirstFrameDelivery(
            watch.context,
            request.stallAfterStartMs,
          );
          firstFrameStall = stall.result;
          stallCleanup.restore = stall.restore;
        }
        // `start()` reaches exactly one of three terminal signals: it calls
        // `onListening` (resolves `listening`) on success; it calls
        // `onStopped` (resolves `stopped`) without ever reaching
        // `onListening` on an open/capture failure it catches itself; or it
        // rejects its own promise on one it does not. Race all three and
        // report whichever is not a real listening start as this fixture's
        // own rejection, naming the outcome, instead of hanging on
        // `listening` forever.
        const starting = recorder.start();
        const terminalFailure = stopped.then((outcome) => {
          throw new Error(
            `recording stopped before listening: ${JSON.stringify(outcome)}`,
          );
        });
        return Promise.race([
          starting.then(() => listening),
          listening,
          terminalFailure,
        ]);
      },
      clock: () => ports.output.currentTime(),
      watch,
    });
  } finally {
    stallCleanup.restore?.();
  }
  const stopAtMs = performance.now();
  const stopClock = ports.output.currentTime();
  let outcome: RecordingOutcome;
  try {
    if (request.stop !== "refused-resume") recorder.stop("switch");
    outcome = await stopped;
  } finally {
    encodeFailure.restore();
    firstSampleStart.restore();
  }
  const stopTookMs =
    request.stop === "refused-resume" ? null : performance.now() - stopAtMs;
  const wallSeconds = (stopAtMs - listenedAt.ms) / 1000;
  const held = suspension(watch.changes, { ms: stopAtMs, clock: stopClock });
  const suspendedAfterStart = watch.changes.find(
    (change) => change.state === "suspended" && change.ms >= listenedAt.ms,
  );
  if (request.stop !== "refused-resume") session.end();

  const audio = joined(files.audio);
  if (header.bytes !== null && audio.length >= header.bytes.length) {
    audio.set(header.bytes, 0);
  }
  const common = {
    logBytes: joined(files.log).length,
    closes: closes.count,
    wallSeconds,
    suspendedSeconds: held.seconds,
    clockDuringSuspensionSeconds: held.clockSeconds,
    clockToSuspension:
      suspendedAfterStart === undefined || watch.captureAskedAt === null
        ? null
        : {
            fromCapture: suspendedAfterStart.clock - watch.captureAskedAt.clock,
            fromListening: suspendedAfterStart.clock - listenedAt.clock,
          },
    stopTookMs,
    firstFrameStall,
    firstSampleStartClockSeconds: firstSampleStart.value.current,
  };
  const logLines = new TextDecoder()
    .decode(joined(files.log))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
  const analysis = await analyse(audio, logLines, SAMPLE_RATE, request.quality);
  return {
    outcome,
    audioBytes: audio.length,
    logLines,
    sampleRate: SAMPLE_RATE,
    ...analysis,
    ...common,
    ...encodeFailureCounts(encodeFailure),
  };
}

declare global {
  interface Window {
    __soundtrackRecordingProbe?: {
      record: (request: RecordRequest) => Promise<Recorded>;
    };
  }
}

window.__soundtrackRecordingProbe = { record };
