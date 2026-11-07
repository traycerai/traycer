/**
 * The session recorder through the soundtrack store, with the REAL session and
 * players behind the fake ports and a fake save channel. The audio clock is the
 * fake timers' clock; a fake capture is driven by the test.
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
import type { MixDirectorId } from "@/lib/soundtrack/directors";
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
import type {
  CaptureSummary,
  MixCapture,
  MixCaptureHandlers,
  RecordingFile,
  RecordingQuality,
  RecordingSaveChannel,
  RecordingWriteResult,
} from "@/lib/soundtrack/recording";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import { MIX_TUNING } from "@/lib/soundtrack/mix-tuning";
import { SoundtrackLogRelay } from "@/lib/soundtrack/session-log";
import type { VariableTrack } from "@/lib/soundtrack/variable-sound";
import { WAV_HEADER_BYTES } from "@/lib/soundtrack/wav";
import {
  FakeOutput,
  FakeStems,
  mulberry32,
} from "@/lib/soundtrack/__tests__/fakes";
import {
  createSoundtrackStore,
  type RecordingChoices,
  type SoundtrackRecording,
} from "../soundtrack-store";

const RECORDING_ID = "rec-1";
const SAMPLE_RATE = 48_000;
// Not 0, so the header can only have it from the capture.
const AUDIO_OFFSET_SECONDS = 0.25;

const TRACK: VariableTrack = {
  name: "calm",
  title: "Calm",
  lengthSeconds: 60,
  alignmentSeconds: 0.5,
  layers: [
    {
      name: "A",
      variants: 1,
      role: "pad",
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
          enabled: null,
          startPause: [0, 0],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [4, 4],
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

const MANIFEST: SoundtrackManifest = {
  tracks: [TRACK],
  views: { home: ["calm"], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

/** A clock the audio thread can stop, as a suspended context does. */
class SuspendableOutput extends FakeOutput {
  private frozenAt: number | null = null;
  private lost = 0;

  override currentTime(): number {
    return (this.frozenAt ?? super.currentTime()) - this.lost;
  }

  freeze(): void {
    this.frozenAt = super.currentTime();
  }

  thaw(): void {
    if (this.frozenAt === null) return;
    this.lost += super.currentTime() - this.frozenAt;
    this.frozenAt = null;
  }
}

class FakeCapture implements MixCapture {
  readonly sampleRate = SAMPLE_RATE;
  readonly audioOffsetSeconds = AUDIO_OFFSET_SECONDS;
  handlers: MixCaptureHandlers | null = null;
  stops = 0;
  /** While set, `stop` answers only once this resolves. */
  stopGate: Promise<void> | null = null;

  start(handlers: MixCaptureHandlers): void {
    this.handlers = handlers;
  }

  async stop(): Promise<CaptureSummary> {
    this.stops += 1;
    await this.stopGate;
    return { frames: null, droppedFrames: null };
  }

  firstFrame(clockSeconds: number): void {
    this.handlers?.onFirstFrame(clockSeconds);
  }

  chunk(bytes: number): void {
    this.handlers?.onChunk(new Uint8Array(bytes).fill(1));
  }

  error(): void {
    this.handlers?.onError(new Error("the capture stopped"));
  }
}

type AppendAnswer = RecordingWriteResult | "reject";

class FakeChannel implements RecordingSaveChannel {
  readonly appends: {
    readonly file: RecordingFile;
    readonly bytes: Uint8Array;
    readonly answer: AppendAnswer;
  }[] = [];
  readonly closes: {
    readonly recordingId: string;
    readonly audioHeader: Uint8Array | null;
  }[] = [];
  /** Decides each append; `audioIndex` counts the audio appends so far. */
  answer: (file: RecordingFile, audioIndex: number) => AppendAnswer = () => ({
    kind: "ok",
  });

  /** While set, `open` answers only once this resolves. */
  openGate: Promise<void> | null = null;
  /** While set, an append answers only once this resolves. */
  appendGate: Promise<void> | null = null;
  /** What a close answers. */
  closeAnswer: () => AppendAnswer = () => ({ kind: "ok" });

  async open(): Promise<{
    kind: "opened";
    recordingId: string;
    name: string;
  }> {
    await this.openGate;
    return { kind: "opened", recordingId: RECORDING_ID, name: "session-test" };
  }

  append(
    recordingId: string,
    file: RecordingFile,
    bytes: Uint8Array,
  ): Promise<RecordingWriteResult> {
    expect(recordingId).toBe(RECORDING_ID);
    const audioIndex = this.appends.filter(
      (call) => call.file === "audio",
    ).length;
    const answer = this.answer(file, audioIndex);
    this.appends.push({ file, bytes, answer });
    const gate = this.appendGate;
    const settle = (): Promise<RecordingWriteResult> =>
      answer === "reject"
        ? Promise.reject(new Error("the channel is gone"))
        : Promise.resolve(answer);
    return gate === null ? settle() : gate.then(settle);
  }

  close(
    recordingId: string,
    audioHeader: Uint8Array | null,
  ): Promise<RecordingWriteResult> {
    this.closes.push({ recordingId, audioHeader });
    const answer = this.closeAnswer();
    return answer === "reject"
      ? Promise.reject(new Error("the channel is gone"))
      : Promise.resolve(answer);
  }

  reveal(): Promise<boolean> {
    return Promise.resolve(true);
  }

  readonly finishListeners = new Set<() => void>();

  onFinishRequested(listener: () => void): () => void {
    this.finishListeners.add(listener);
    return () => {
      this.finishListeners.delete(listener);
    };
  }

  /** The log's lines, as written, parsed. */
  logLines(): Record<string, unknown>[] {
    const text = this.appends
      .filter((call) => call.file === "log")
      .map((call) => new TextDecoder().decode(call.bytes))
      .join("");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parseLine(line));
  }
}

function parseLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Not a log object: ${line}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

function dataSizeOf(header: Uint8Array): number {
  return new DataView(header.buffer, header.byteOffset).getUint32(40, true);
}

/** What the tests read of the store and ask of it. */
interface StoreViewState {
  readonly enabled: boolean;
  readonly recording: SoundtrackRecording;
  readonly stopRecording: () => void;
  readonly disable: () => void;
  readonly startRecording: (choices: RecordingChoices) => void;
  readonly setDirector: (director: MixDirectorId) => void;
}

interface StoreView {
  readonly subscribe: (
    listener: (state: StoreViewState, previous: StoreViewState) => void,
  ) => () => void;
  readonly getState: () => StoreViewState;
}

interface Harness {
  readonly store: StoreView;
  readonly output: SuspendableOutput;
  readonly capture: FakeCapture;
  readonly channel: FakeChannel;
  readonly close: Mock<(afterSeconds: number) => void>;
  readonly captureMix: Mock<SoundtrackPorts["captureMix"]>;
  /** Starts a recording and takes its first frame at the clock now. */
  readonly record: () => Promise<void>;
  /** The wall clock when the first frame was handed over, as an ISO string. */
  readonly firstFrameIso: () => string;
  /** The audio clock time the first frame was handed over at. */
  readonly firstFrameClock: () => number;
}

function harness(
  limitSeconds: number | null,
  quality: RecordingQuality,
  manifest: SoundtrackManifest,
): Harness {
  const output = new SuspendableOutput();
  const capture = new FakeCapture();
  const channel = new FakeChannel();
  let firstFrameIso = "";
  let firstFrameClock = 0;
  const close = vi.fn<(afterSeconds: number) => void>();
  const captureMix = vi.fn<SoundtrackPorts["captureMix"]>(() =>
    Promise.resolve(capture),
  );
  const ports: SoundtrackPorts = {
    output,
    stems: new FakeStems(2.2),
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck: () => undefined,
    close,
    log: new SoundtrackLogRelay(),
    captureMix,
    pause: () => undefined,
    resume: () => undefined,
  };
  const store = createSoundtrackStore({
    readManifest: () => manifest,
    openPorts: () => ports,
    random: mulberry32(1),
    recordingChannel: () => channel,
  });
  store.getState().enable();
  store.getState().setSignals({
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
  });
  return {
    store,
    output,
    capture,
    channel,
    close,
    captureMix,
    firstFrameIso: () => firstFrameIso,
    firstFrameClock: () => firstFrameClock,
    record: async () => {
      store.getState().startRecording({ limitSeconds, quality });
      await vi.waitFor(() => {
        expect(capture.handlers).not.toBeNull();
      });
      firstFrameIso = new Date().toISOString();
      firstFrameClock = output.currentTime();
      capture.firstFrame(firstFrameClock);
    },
  };
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T17:22:40.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface StopPath {
  readonly name: string;
  readonly limitSeconds: number;
  /** Runs with a 400-byte chunk on disk and a 200-byte one still waiting. */
  readonly trigger: (h: Harness) => Promise<void>;
  readonly reason: string;
  readonly problem: "disk" | "error" | null;
  /** The audio bytes answered ok, which is also what the WAV header counts. */
  readonly bytes: number;
  readonly answer: FakeChannel["answer"];
}

const OK: AppendAnswer = { kind: "ok" };

const STOP_PATHS: readonly StopPath[] = [
  {
    name: "the limit",
    limitSeconds: 2,
    trigger: () => advance(1),
    reason: "limit",
    problem: null,
    bytes: 600,
    answer: () => OK,
  },
  {
    name: "the switch",
    limitSeconds: 100,
    trigger: (h) => {
      h.store.getState().stopRecording();
      return advance(0.1);
    },
    reason: "switch",
    problem: null,
    bytes: 600,
    answer: () => OK,
  },
  {
    name: "Music off",
    limitSeconds: 100,
    trigger: (h) => {
      h.store.getState().disable();
      return advance(0.1);
    },
    reason: "music-off",
    problem: null,
    bytes: 600,
    answer: () => OK,
  },
  {
    name: "the page unloading",
    limitSeconds: 100,
    trigger: () => {
      window.dispatchEvent(new Event("pagehide"));
      return advance(0.1);
    },
    reason: "unload",
    problem: null,
    bytes: 600,
    answer: () => OK,
  },
  {
    name: "a write failure",
    limitSeconds: 100,
    trigger: () => advance(1),
    reason: "write-failed",
    problem: "disk",
    bytes: 400,
    answer: (file, audioIndex) =>
      file === "audio" && audioIndex === 2 ? { kind: "write-failed" } : OK,
  },
  {
    name: "a capture error",
    limitSeconds: 100,
    trigger: (h) => {
      h.capture.error();
      return advance(0.1);
    },
    reason: "failed",
    problem: "error",
    bytes: 600,
    answer: () => OK,
  },
  {
    name: "the channel rejecting",
    limitSeconds: 100,
    trigger: () => advance(1),
    reason: "failed",
    problem: "error",
    bytes: 400,
    answer: (file, audioIndex) =>
      file === "audio" && audioIndex === 2 ? "reject" : OK,
  },
];

describe("session recorder: each stop path finishes both files once", () => {
  it.each(STOP_PATHS)(
    "$name closes once, writes the WAV sizes it was told were taken, and ends the log",
    async (path) => {
      const h = harness(path.limitSeconds, "lossless", MANIFEST);
      h.channel.answer = path.answer;
      await h.record();
      h.capture.chunk(400);
      await advance(1);
      h.capture.chunk(200);
      await path.trigger(h);
      await advance(1);

      expect(h.channel.closes).toHaveLength(1);
      const [closed] = h.channel.closes;
      expect(closed.recordingId).toBe(RECORDING_ID);
      expect(closed.audioHeader).toHaveLength(WAV_HEADER_BYTES);
      expect(
        closed.audioHeader === null ? null : dataSizeOf(closed.audioHeader),
      ).toBe(path.bytes);
      const answeredOk = h.channel.appends
        .filter(
          (call) =>
            call.file === "audio" &&
            call.answer !== "reject" &&
            call.answer.kind === "ok",
        )
        .reduce((sum, call) => sum + call.bytes.length, 0);
      expect(answeredOk - WAV_HEADER_BYTES).toBe(path.bytes);

      const lines = h.channel.logLines();
      const sha256Digest: unknown = expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/,
      );
      expect(lines[0]).toEqual({
        type: "header",
        format: 1,
        quality: "lossless",
        sampleRate: SAMPLE_RATE,
        audioOffsetSeconds: AUDIO_OFFSET_SECONDS,
        director: "static",
        tuning: MIX_TUNING,
        trackSet: {
          tracks: ["calm"],
          digest: sha256Digest,
        },
        startedAt: h.firstFrameIso(),
      });
      expect(lines.at(-1)).toMatchObject({
        type: "recording-end",
        reason: path.reason,
      });
      expect(h.store.getState().recording).toMatchObject({
        kind: "saved",
        recordingId: RECORDING_ID,
        problem: path.problem,
      });
      expect(h.capture.stops).toBe(1);
    },
  );

  it("closes a compressed recording with no WAV header", async () => {
    const h = harness(100, "compressed", MANIFEST);
    await h.record();
    h.capture.chunk(400);
    h.store.getState().stopRecording();
    await advance(1);

    expect(h.channel.closes).toEqual([
      { recordingId: RECORDING_ID, audioHeader: null },
    ]);
    expect(h.channel.logLines()[0]).toMatchObject({
      type: "header",
      quality: "compressed",
    });
    // No placeholder: only the captured bytes reach the audio file.
    expect(
      h.channel.appends
        .filter((call) => call.file === "audio")
        .map((call) => call.bytes.length),
    ).toEqual([400]);
  });
});

describe("session recorder: the mix does not depend on it", () => {
  it("stops on a failed append, keeps the session open and keeps placing samples", async () => {
    const h = harness(100, "compressed", MANIFEST);
    h.channel.answer = (file) =>
      file === "audio" ? { kind: "write-failed" } : OK;
    await h.record();
    h.capture.chunk(100);
    await advance(1);
    const playsAtFailure = h.output.allPlays().length;

    expect(h.store.getState().recording).toMatchObject({
      kind: "saved",
      problem: "disk",
    });
    await advance(20);

    expect(h.close).not.toHaveBeenCalled();
    expect(h.store.getState().enabled).toBe(true);
    expect(h.output.allPlays().length).toBeGreaterThan(playsAtFailure);
  });
});

describe("session recorder: the limit", () => {
  it("fires at the chosen length, in audio time", async () => {
    const h = harness(1800, "compressed", MANIFEST);
    await h.record();
    await advance(1799);
    expect(h.store.getState().recording.kind).toBe("recording");
    expect(h.channel.closes).toHaveLength(0);

    await advance(2);

    expect(h.channel.closes).toHaveLength(1);
    const { recording } = h.store.getState();
    expect(recording).toMatchObject({ kind: "saved", problem: null });
    expect(
      recording.kind === "saved" ? recording.durationSeconds : null,
    ).toBeCloseTo(1800, 0);
  });

  it("does not run down while the audio clock is stopped", async () => {
    const h = harness(10, "compressed", MANIFEST);
    await h.record();
    await advance(5);
    h.output.freeze();
    await advance(60);
    expect(h.store.getState().recording).toMatchObject({
      kind: "recording",
      elapsedSeconds: 5,
    });
    expect(h.channel.closes).toHaveLength(0);

    h.output.thaw();
    await advance(6);

    expect(h.channel.closes).toHaveLength(1);
  });
});

describe("session recorder: the switch", () => {
  it("stops without a second close however often it is asked", async () => {
    const h = harness(100, "compressed", MANIFEST);
    await h.record();
    h.store.getState().stopRecording();
    h.store.getState().stopRecording();
    h.store.getState().disable();
    await advance(1);

    expect(h.channel.closes).toHaveLength(1);
    expect(h.capture.stops).toBe(1);
  });
});

describe("session recorder: log times", () => {
  it("counts a sample's t and start from the first frame's clock time", async () => {
    const h = harness(100, "compressed", MANIFEST);
    await advance(1.5);
    await h.record();
    const firstFrame = h.output.currentTime();
    // Two samples are placed in 12 s: the track repeats every 6.2 s.
    await advance(12);
    h.store.getState().stopRecording();
    await advance(1);

    const samples = h.channel
      .logLines()
      .filter((line) => line.type === "sample");
    const plays = h.output.allPlays().filter((play) => play.at >= firstFrame);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples).toHaveLength(plays.length);
    samples.forEach((sample, index) => {
      expect(sample.t).toBeCloseTo(plays[index].at - firstFrame, 4);
      expect(sample.start).toBeCloseTo(plays[index].when - firstFrame, 4);
    });
  });
});

describe("session recorder: the track set's digest", () => {
  async function digestOf(manifest: SoundtrackManifest): Promise<unknown> {
    const h = harness(100, "compressed", manifest);
    await h.record();
    h.store.getState().stopRecording();
    await advance(1);
    const { trackSet } = h.channel.logLines()[0];
    return typeof trackSet === "object" && trackSet !== null
      ? Reflect.get(trackSet, "digest")
      : null;
  }

  it("is the same for the same manifest and changes with a track definition", async () => {
    const edited: SoundtrackManifest = {
      ...MANIFEST,
      tracks: [
        {
          ...TRACK,
          states: [
            {
              ...TRACK.states[0],
              layersProperties: [
                {
                  ...TRACK.states[0].layersProperties[0],
                  pauseBetweenRepetitions: [5, 5],
                },
              ],
            },
          ],
        },
      ],
    };

    const first = await digestOf(MANIFEST);
    const again = await digestOf(MANIFEST);
    const changed = await digestOf(edited);

    expect(again).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe("session recorder: opening and the log's other events", () => {
  it("writes a WAV placeholder with the streaming size in both fields as its first audio, so a crash leaves a file that opens", async () => {
    const h = harness(100, "lossless", MANIFEST);
    await h.record();

    const [first] = h.channel.appends.filter((call) => call.file === "audio");
    const view = new DataView(first.bytes.buffer, first.bytes.byteOffset);
    expect(first.bytes).toHaveLength(WAV_HEADER_BYTES);
    expect(view.getUint32(4, true)).toBe(0xff_ff_ff_ff);
    expect(view.getUint32(40, true)).toBe(0xff_ff_ff_ff);
  });

  it("closes a recording whose switch went off while its files were opening, opening no capture and leaving the store off", async () => {
    const h = harness(100, "lossless", MANIFEST);
    const gate = Promise.withResolvers<void>();
    h.channel.openGate = gate.promise;

    h.store
      .getState()
      .startRecording({ limitSeconds: 100, quality: "lossless" });
    h.store.getState().stopRecording();
    gate.resolve();
    await vi.waitFor(() => {
      expect(h.channel.closes).toHaveLength(1);
    });
    await advance(1);

    expect(h.captureMix).not.toHaveBeenCalled();
    expect(h.channel.appends).toEqual([]);
    // Nothing was written, so there are no sizes to put over a header.
    expect(h.channel.closes).toEqual([
      { recordingId: RECORDING_ID, audioHeader: null },
    ]);
    expect(h.store.getState().recording).toEqual({ kind: "off" });
  });

  it("writes a director event with the new id on the log's clock when the director changes mid-recording", async () => {
    const h = harness(100, "compressed", MANIFEST);
    await h.record();
    await advance(2);
    const changedAt = h.output.currentTime();

    h.store.getState().setDirector("rules");
    await advance(1);
    h.store.getState().stopRecording();
    await advance(1);

    const written = h.channel
      .logLines()
      .filter((line) => line.type === "director");
    expect(written).toHaveLength(1);
    expect(written[0].director).toBe("rules");
    expect(written[0].t).toBeCloseTo(changedAt - h.firstFrameClock(), 4);
  });
});

/** How often the store is told a recording was saved, counting repeats. */
function savedReports(h: Harness): { count: number } {
  const reports = { count: 0 };
  h.store.subscribe((state, previous) => {
    if (state.recording === previous.recording) return;
    if (state.recording.kind === "saved") reports.count += 1;
  });
  return reports;
}

describe("session recorder: the app quitting", () => {
  it("finishes on the channel's ask: one close with the WAV sizes, an end line saying quit, saved with no problem, and the listener gone", async () => {
    const h = harness(100, "lossless", MANIFEST);
    await h.record();
    h.capture.chunk(400);
    await advance(1);
    h.capture.chunk(200);
    expect(h.channel.finishListeners.size).toBe(1);

    for (const listener of h.channel.finishListeners) listener();
    await advance(1);

    expect(h.channel.closes).toHaveLength(1);
    const [closed] = h.channel.closes;
    expect(
      closed.audioHeader === null ? null : dataSizeOf(closed.audioHeader),
    ).toBe(600);
    expect(h.channel.logLines().at(-1)).toMatchObject({
      type: "recording-end",
      reason: "quit",
    });
    expect(h.store.getState().recording).toMatchObject({
      kind: "saved",
      problem: null,
    });
    expect(h.channel.finishListeners.size).toBe(0);
  });
});

describe("session recorder: the page going while it saves", () => {
  it("closes at once with the bytes sent when it is still waiting on the capture, and neither closes nor reports again when the capture answers", async () => {
    const h = harness(100, "lossless", MANIFEST);
    const gate = Promise.withResolvers<void>();
    h.capture.stopGate = gate.promise;
    await h.record();
    h.capture.chunk(400);
    await advance(1);
    h.capture.chunk(200);
    const saved = savedReports(h);
    h.store.getState().stopRecording();
    expect(h.channel.closes).toHaveLength(0);

    window.dispatchEvent(new Event("pagehide"));

    expect(h.channel.closes).toHaveLength(1);
    const [closed] = h.channel.closes;
    expect(
      closed.audioHeader === null ? null : dataSizeOf(closed.audioHeader),
    ).toBe(600);
    gate.resolve();
    await advance(1);

    expect(h.channel.closes).toHaveLength(1);
    const ends = h.channel
      .logLines()
      .filter((line) => line.type === "recording-end");
    expect(ends).toEqual([
      expect.objectContaining({
        reason: "switch",
        frames: null,
        droppedFrames: null,
      }),
    ]);
    expect(saved.count).toBe(1);
    expect(h.store.getState().recording).toMatchObject({
      kind: "saved",
      problem: null,
    });
  });

  it("closes at once counting the bytes sent when it is still waiting on a write, and does not close again when the write answers", async () => {
    const h = harness(100, "lossless", MANIFEST);
    await h.record();
    h.capture.chunk(400);
    await advance(1);
    const gate = Promise.withResolvers<void>();
    h.channel.appendGate = gate.promise;
    h.capture.chunk(200);
    h.store.getState().stopRecording();
    await advance(0.1);
    expect(h.channel.closes).toHaveLength(0);

    window.dispatchEvent(new Event("pagehide"));

    expect(h.channel.closes).toHaveLength(1);
    const [closed] = h.channel.closes;
    // The 200 bytes are sent, though the channel has not answered them.
    expect(
      closed.audioHeader === null ? null : dataSizeOf(closed.audioHeader),
    ).toBe(600);
    gate.resolve();
    await advance(1);

    expect(h.channel.closes).toHaveLength(1);
    expect(h.store.getState().recording).toMatchObject({ kind: "saved" });
  });
});

describe("session recorder: the page going while it opens", () => {
  it("closes at once with no header when the files are open and the capture is still on its way, and ends off when the capture arrives", async () => {
    const h = harness(100, "lossless", MANIFEST);
    const arrival = Promise.withResolvers<FakeCapture>();
    h.captureMix.mockImplementation(() => arrival.promise);

    h.store
      .getState()
      .startRecording({ limitSeconds: 100, quality: "lossless" });
    await vi.waitFor(() => {
      expect(h.captureMix).toHaveBeenCalled();
    });
    window.dispatchEvent(new Event("pagehide"));

    expect(h.channel.closes).toEqual([
      { recordingId: RECORDING_ID, audioHeader: null },
    ]);
    arrival.resolve(h.capture);
    await advance(1);

    expect(h.channel.closes).toHaveLength(1);
    expect(h.capture.handlers).toBeNull();
    expect(h.store.getState().recording).toEqual({ kind: "off" });
  });

  it("waits for the files to open, then closes them once and never asks for the capture", async () => {
    const h = harness(100, "lossless", MANIFEST);
    const gate = Promise.withResolvers<void>();
    h.channel.openGate = gate.promise;

    h.store
      .getState()
      .startRecording({ limitSeconds: 100, quality: "lossless" });
    window.dispatchEvent(new Event("pagehide"));
    await advance(1);
    expect(h.channel.closes).toHaveLength(0);

    gate.resolve();
    await vi.waitFor(() => {
      expect(h.channel.closes).toHaveLength(1);
    });
    await advance(1);

    expect(h.channel.closes).toEqual([
      { recordingId: RECORDING_ID, audioHeader: null },
    ]);
    expect(h.captureMix).not.toHaveBeenCalled();
    expect(h.store.getState().recording).toEqual({ kind: "off" });
  });
});

describe("session recorder: a failure kept through the stop", () => {
  it("reports a write that failed only after the switch went off, over the reason it stopped", async () => {
    const h = harness(100, "compressed", MANIFEST);
    h.channel.answer = (file) =>
      file === "audio" ? { kind: "write-failed" } : OK;
    await h.record();
    const gate = Promise.withResolvers<void>();
    h.channel.appendGate = gate.promise;
    h.capture.chunk(400);
    await advance(1);

    h.store.getState().stopRecording();
    gate.resolve();
    await advance(1);

    expect(h.store.getState().recording).toMatchObject({
      kind: "saved",
      problem: "disk",
    });
  });

  it("reports a write that fails in the stop's own last flush", async () => {
    const h = harness(100, "compressed", MANIFEST);
    h.channel.answer = (file, audioIndex) =>
      file === "audio" && audioIndex === 1 ? { kind: "write-failed" } : OK;
    await h.record();
    h.capture.chunk(400);
    await advance(1);
    h.capture.chunk(200);

    h.store.getState().stopRecording();
    await advance(1);

    // The second audio append is the one the stop itself sent.
    expect(
      h.channel.appends.filter((call) => call.file === "audio"),
    ).toHaveLength(2);
    expect(h.store.getState().recording).toMatchObject({
      kind: "saved",
      problem: "disk",
    });
  });

  it.each([
    ["answers write-failed", () => ({ kind: "write-failed" }) as const, "disk"],
    ["answers refused", () => ({ kind: "refused" }) as const, "error"],
    ["rejects", () => "reject" as const, "error"],
  ])("reports a close that %s as %s", async (_, answer, problem) => {
    const h = harness(100, "compressed", MANIFEST);
    h.channel.closeAnswer = answer;
    await h.record();
    h.capture.chunk(400);

    h.store.getState().stopRecording();
    await advance(1);

    expect(h.store.getState().recording).toMatchObject({
      kind: "saved",
      problem,
    });
  });
});
