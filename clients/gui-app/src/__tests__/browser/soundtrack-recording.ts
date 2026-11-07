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
import { openWebAudioPorts } from "@/lib/soundtrack/web-audio-ports";

/**
 * Browser fixture for a real recording of the mix: the real Web Audio ports,
 * the real player on a one-layer track whose only sample is a test tone made
 * here, and the real recorder, writing to a save channel that keeps the bytes
 * in memory. The page then decodes what it recorded and finds each tone's
 * onset in it, to set beside the start the log gave the same sample.
 *
 * WHY IT CANNOT BE A JSDOM TEST. jsdom has no audio clock, no `MediaRecorder`
 * and no audio worklet; only a browser renders and encodes the frames whose
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
   * Holds the main thread for this long once `MediaRecorder.start` returns,
   * ahead of its `start` event, so the compressed capture is shown to take its
   * time origin from the start and not from the event; null holds nothing.
   */
  readonly stallAfterStartMs: number | null;
  /**
   * Which of the compressed recorder's slices, counting from 1, cannot be
   * read, as a blob the browser has lost would be; null reads every one.
   */
  readonly failSliceRead: number | null;
  /**
   * Pauses the session this many clock seconds into the recording and holds it
   * for `holdSeconds` of wall time from the moment the context reports
   * suspended. With `playInSameTask` the Play is issued in the task that calls
   * `context.suspend()`, so the context reports suspended late, after the Play.
   */
  readonly pause: {
    readonly afterSeconds: number;
    readonly holdSeconds: number;
    readonly playInSameTask: boolean;
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
  /** How many times the compressed recorder was paused. */
  readonly recorderPauses: number;
  /** Wall-clock ms the stop took, when the fixture asked for it; else null. */
  readonly stopTookMs: number | null;
  /** The `resume` calls of the recorder and the context, in the order made. */
  readonly resumeOrder: readonly ("recorder" | "context")[];
  /** The largest gap between WebM packets, in ms; null for a WAV. */
  readonly maxPacketGapMs: number | null;
  /** With `failSliceRead`: the bytes of the slices read before the failed one. */
  readonly sliceBytesBeforeFailure: number | null;
  /** With `failSliceRead`: how many slices were read after the failed one. */
  readonly slicesReadAfterFailure: number | null;
}

interface SliceReads {
  readonly before: number[];
  after: number;
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

/** Until the answer is called, every recorder start stalls the page after it. */
function stallAfterRecorderStart(forMs: number): () => void {
  const { prototype } = MediaRecorder;
  const start: unknown = Reflect.get(prototype, "start");
  if (typeof start !== "function") throw new Error("No MediaRecorder.start");
  Reflect.set(
    prototype,
    "start",
    function stalledStart(this: MediaRecorder, timeslice: number): void {
      Reflect.apply(start, this, [timeslice]);
      // After the caller's task, and ahead of the task the event comes in.
      queueMicrotask(() => {
        holdMainThread(forMs);
      });
    },
  );
  return () => {
    Reflect.set(prototype, "start", start);
  };
}

/**
 * Until the answer is called, the `index`th blob read rejects; the reads before
 * and after it are counted. Only the compressed capture reads blobs here.
 */
function failBlobRead(index: number): {
  readonly reads: SliceReads;
  readonly restore: () => void;
} {
  const { prototype } = Blob;
  const read: unknown = Reflect.get(prototype, "arrayBuffer");
  if (typeof read !== "function") throw new Error("No Blob.arrayBuffer");
  const reads: SliceReads = { before: [], after: 0 };
  let calls = 0;
  Reflect.set(
    prototype,
    "arrayBuffer",
    function failingRead(this: Blob): unknown {
      calls += 1;
      if (calls === index) {
        return Promise.reject(new Error("The slice could not be read"));
      }
      if (calls < index) reads.before.push(this.size);
      else reads.after += 1;
      const bytes: unknown = Reflect.apply(read, this, []);
      return bytes;
    },
  );
  return {
    reads,
    restore: () => {
      Reflect.set(prototype, "arrayBuffer", read);
    },
  };
}

interface Faults {
  /** The blob reads counted, with `failSliceRead`; null without it. */
  readonly reads: SliceReads | null;
  /** Ends the stall after the recorder's start, once the recording listens. */
  readonly unstall: () => void;
  /** Ends the failing blob read, once the recording has stopped. */
  readonly restore: () => void;
}

/** The stall and the failing read a request asks for, set up now. */
function installFaults(request: RecordRequest): Faults {
  const unstall =
    request.stallAfterStartMs === null
      ? () => undefined
      : stallAfterRecorderStart(request.stallAfterStartMs);
  if (request.failSliceRead === null) {
    return { reads: null, unstall, restore: () => undefined };
  }
  const { reads, restore } = failBlobRead(request.failSliceRead);
  return { reads, unstall, restore };
}

/** What `failSliceRead` asked for, counted; nulls when it asked for nothing. */
function sliceCounts(
  reads: SliceReads | null,
): Pick<Recorded, "sliceBytesBeforeFailure" | "slicesReadAfterFailure"> {
  if (reads === null) {
    return { sliceBytesBeforeFailure: null, slicesReadAfterFailure: null };
  }
  return {
    sliceBytesBeforeFailure: reads.before.reduce(
      (sum, bytes) => sum + bytes,
      0,
    ),
    slicesReadAfterFailure: reads.after,
  };
}

/**
 * Notes, until the page is left, each `resume` of a recorder and of a context in
 * the order made, so that the recorder is shown to start ahead of the clock.
 */
function noteResumes(): ("recorder" | "context")[] {
  const order: ("recorder" | "context")[] = [];
  const note = (prototype: object, label: "recorder" | "context"): void => {
    const resume: unknown = Reflect.get(prototype, "resume");
    if (typeof resume !== "function") throw new Error("No resume to note");
    Reflect.set(prototype, "resume", function noted(this: object): unknown {
      order.push(label);
      const answer: unknown = Reflect.apply(resume, this, []);
      return answer;
    });
  };
  note(MediaRecorder.prototype, "recorder");
  note(AudioContext.prototype, "context");
  return order;
}

/** Notes, until the page is left, each `pause` of a recorder. */
function countRecorderPauses(): { count: number } {
  const pauses = { count: 0 };
  const pause: unknown = Reflect.get(MediaRecorder.prototype, "pause");
  if (typeof pause !== "function") throw new Error("No pause to count");
  Reflect.set(
    MediaRecorder.prototype,
    "pause",
    function counted(this: MediaRecorder): unknown {
      pauses.count += 1;
      const answer: unknown = Reflect.apply(pause, this, []);
      return answer;
    },
  );
  return pauses;
}

interface StateChange {
  readonly state: AudioContextState;
  /** `performance.now` ms when the change was reported. */
  readonly ms: number;
  /** The audio clock when it was reported. */
  readonly clock: number;
}

interface ContextWatch {
  context: AudioContext | null;
  readonly changes: StateChange[];
  /** Runs in the task that calls `suspend`, once; null runs nothing. */
  onSuspend: (() => void) | null;
}

/** The ports over a context that this watch sees: its changes and suspends. */
function openWatchedPorts(
  watch: ContextWatch,
  volume: number,
): SoundtrackPorts {
  const Real = window.AudioContext;
  class WatchedContext extends Real {
    constructor() {
      super();
      watch.context = this;
      this.addEventListener("statechange", () => {
        watch.changes.push({
          state: this.state,
          ms: performance.now(),
          clock: this.currentTime,
        });
      });
    }

    override suspend(): Promise<void> {
      const answer = super.suspend();
      const run = watch.onSuspend;
      watch.onSuspend = null;
      run?.();
      return answer;
    }
  }
  window.AudioContext = WatchedContext;
  try {
    return openWebAudioPorts({ tracks: [] }, volume);
  } finally {
    window.AudioContext = Real;
  }
}

/** What the context's reported suspensions came to, up to the stop. */
function suspension(
  changes: readonly StateChange[],
  end: { readonly ms: number; readonly clock: number },
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

// EBML ids this reader descends into; every other element is skipped by size.
const WEBM_SEGMENT = 0x18538067;
const WEBM_CLUSTER = 0x1f43b675;
const WEBM_BLOCK_GROUP = 0xa0;
const WEBM_TIMECODE = 0xe7;
const WEBM_SIMPLE_BLOCK = 0xa3;
const WEBM_BLOCK = 0xa1;

/** An EBML variable-length integer at `at`: its value and byte length. */
function readVint(
  bytes: Uint8Array,
  at: number,
  keepMarker: boolean,
): {
  readonly value: number;
  readonly length: number;
  readonly unknown: boolean;
} {
  const first = bytes[at];
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
    if (bytes[at + index] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** When each packet of a WebM starts, in ms: cluster time plus block offset. */
function packetTimesMs(bytes: Uint8Array): number[] {
  const times: number[] = [];
  let clusterMs = 0;
  let at = 0;
  while (at < bytes.length) {
    const id = readVint(bytes, at, true);
    const size = readVint(bytes, at + id.length, false);
    const body = at + id.length + size.length;
    if (
      id.value === WEBM_SEGMENT ||
      id.value === WEBM_CLUSTER ||
      id.value === WEBM_BLOCK_GROUP
    ) {
      at = body;
      continue;
    }
    if (id.value === WEBM_TIMECODE) {
      clusterMs = 0;
      for (let index = 0; index < size.value; index += 1) {
        clusterMs = clusterMs * 256 + bytes[body + index];
      }
    } else if (id.value === WEBM_SIMPLE_BLOCK || id.value === WEBM_BLOCK) {
      const track = readVint(bytes, body, false);
      const offset =
        (bytes[body + track.length] << 8) | bytes[body + track.length + 1];
      const signed = offset >= 0x8000 ? offset - 0x10000 : offset;
      times.push(clusterMs + signed);
    }
    at = body + size.value;
  }
  return times;
}

function largestGap(times: readonly number[]): number {
  const sorted = times.toSorted((a, b) => a - b);
  let largest = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    largest = Math.max(largest, sorted[index] - sorted[index - 1]);
  }
  return largest;
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

function deviceSampleRate(): Promise<number> {
  const probe = new AudioContext();
  const { sampleRate } = probe;
  return probe.close().then(() => sampleRate);
}

type Analysis = Pick<
  Recorded,
  | "decodedSeconds"
  | "onsetOffsetsMs"
  | "onsetStarts"
  | "maxPacketGapMs"
  | "wavFrames"
>;

/** Decodes the recording, and finds each logged sample's onset in it. */
async function analyse(
  audio: Uint8Array,
  logLines: readonly unknown[],
  sampleRate: number,
  quality: RecordingQuality,
): Promise<Analysis> {
  if (audio.length === 0) {
    return {
      decodedSeconds: 0,
      onsetOffsetsMs: [],
      onsetStarts: [],
      maxPacketGapMs: null,
      wavFrames: null,
    };
  }
  const decoder = new OfflineAudioContext(2, 1, sampleRate);
  const decoded = await decoder.decodeAudioData(audio.slice().buffer);
  const left = decoded.getChannelData(0);
  const ideal = idealOnsetFrames(decoded.sampleRate) / decoded.sampleRate;
  const onsetOffsetsMs: number[] = [];
  const onsetStarts: number[] = [];
  for (const line of logLines) {
    if (typeof line !== "object" || line === null) continue;
    if (Reflect.get(line, "type") !== "sample") continue;
    const start: unknown = Reflect.get(line, "start");
    if (typeof start !== "number") continue;
    const from = Math.max(
      0,
      Math.floor((start - ONSET_SEARCH_SECONDS) * decoded.sampleRate),
    );
    const to = Math.min(
      left.length,
      Math.ceil((start + ONSET_SEARCH_SECONDS) * decoded.sampleRate),
    );
    for (let index = from; index < to; index += 1) {
      if (Math.abs(left[index]) > ONSET_THRESHOLD) {
        onsetOffsetsMs.push(
          (index / decoded.sampleRate - ideal - start) * 1000,
        );
        onsetStarts.push(start);
        break;
      }
    }
  }
  return {
    decodedSeconds: decoded.duration,
    onsetOffsetsMs,
    onsetStarts,
    maxPacketGapMs:
      quality === "compressed" ? largestGap(packetTimesMs(audio)) : null,
    wavFrames: quality === "lossless" ? (audio.length - 44) / 4 : null,
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
  readonly unstall: () => void;
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
  if (pause.playInSameTask) {
    let played = false;
    watch.onSuspend = () => {
      session.play();
      played = true;
    };
    session.pause();
    await until(() => played);
    await musicFor(clock, request.seconds);
    return;
  }
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
 * listening, in `performance.now` ms.
 */
async function runTimeline(
  request: RecordRequest,
  timeline: Timeline,
): Promise<number> {
  const { session, clock, watch, start, unstall } = timeline;
  if (request.startHeldForSeconds !== null) {
    session.setSignals(HOME_SIGNALS);
    await musicFor(clock, LEAD_SECONDS);
    session.pause();
    await until(() => watch.context?.state === "suspended");
  }
  const heldAtMs = performance.now();
  await start();
  const listeningAtMs = performance.now();
  unstall();
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
  return listeningAtMs;
}

async function record(request: RecordRequest): Promise<Recorded> {
  const sampleRate = await deviceSampleRate();
  const tone = toneBuffer(sampleRate);
  const stems: StemSource = { load: () => Promise.resolve(tone) };
  const watch: ContextWatch = { context: null, changes: [], onSuspend: null };
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
  const resumeOrder = noteResumes();
  const recorderPauses = countRecorderPauses();
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
  const faults = installFaults(request);
  const listeningAtMs = await runTimeline(request, {
    session,
    start: () => {
      void recorder.start();
      return listening;
    },
    unstall: faults.unstall,
    clock: () => ports.output.currentTime(),
    watch,
  });
  const stopAtMs = performance.now();
  const stopClock = ports.output.currentTime();
  if (request.stop !== "refused-resume") recorder.stop("switch");
  const outcome = await stopped;
  const stopTookMs =
    request.stop === "refused-resume" ? null : performance.now() - stopAtMs;
  const wallSeconds = (stopAtMs - listeningAtMs) / 1000;
  const held = suspension(watch.changes, { ms: stopAtMs, clock: stopClock });
  faults.restore();
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
    recorderPauses: recorderPauses.count,
    stopTookMs,
    resumeOrder,
  };
  const logLines = new TextDecoder()
    .decode(joined(files.log))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
  const analysis = await analyse(audio, logLines, sampleRate, request.quality);
  return {
    outcome,
    audioBytes: audio.length,
    logLines,
    sampleRate,
    ...analysis,
    ...common,
    ...sliceCounts(faults.reads),
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
