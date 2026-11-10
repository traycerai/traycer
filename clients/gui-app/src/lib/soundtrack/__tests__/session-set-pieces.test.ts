/**
 * `SoundtrackSession.setSetPiecesEnabled`: the staging-only switch that drops
 * complete recordings — immediately, including a voice still loading or
 * waiting out a silence — and keeps them out of a pool, its history and
 * resume positions until it is turned back on.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ComposedTrack,
  SoundtrackManifest,
  SoundtrackTrack,
} from "../manifest";
import type { OutputGain } from "../output";
import { StaticDirector } from "../directors";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import { SoundtrackLogRelay } from "../session-log";
import type { MixSignals } from "../signals";
import { makeAudioBuffer } from "./audio-buffer";
import { playbackTrack } from "./playback-track";
import { captureNothing, FakeOutput, FakeStems } from "./fakes";

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

/** Counts complete recordings started through the output. */
class RecordingOutput extends FakeOutput {
  recordingStarts = 0;

  override createBus(): OutputGain {
    const wrap = (gain: OutputGain): OutputGain => ({
      ramp: (target, seconds) => gain.ramp(target, seconds),
      createChild: (initial, pan) => wrap(gain.createChild(initial, pan)),
      play: (buffer, when, fade) => gain.play(buffer, when, fade),
      playRecording: (buffer, when) => {
        this.recordingStarts += 1;
        return gain.play(buffer, when, 0.01);
      },
    });
    return wrap(super.createBus());
  }
}

function pieceOf(name: string, recording: string): ComposedTrack {
  return { kind: "composed", name, title: name, recording };
}

interface OpenOptions {
  readonly views: SoundtrackManifest["views"];
  readonly tracks: readonly SoundtrackTrack[];
  readonly recordings: readonly {
    readonly name: string;
    readonly file: string;
  }[];
  readonly loadRecording?: (name: string) => Promise<AudioBuffer>;
}

function openMixed(options: OpenOptions & { readonly random?: () => number }) {
  const output = new RecordingOutput();
  const fakeStems = new FakeStems(2.2);
  const setDimmed = vi.fn<(dimmed: boolean) => void>();
  const onSounding =
    vi.fn<(sounding: { readonly view: string } | null) => void>();
  const ports: SoundtrackPorts = {
    output,
    stems: {
      load: fakeStems.load.bind(fakeStems),
      loadRecording:
        options.loadRecording ??
        (() => Promise.resolve(makeAudioBuffer(10, 10))),
    },
    setDimmed,
    setVolume: () => undefined,
    duck: () => undefined,
    close: () => undefined,
    log: new SoundtrackLogRelay(),
    captureMix: captureNothing,
    pause: () => output.stopClock(),
    resume: () => output.startClock(),
  };
  const manifest: SoundtrackManifest = {
    tracks: options.tracks,
    views: options.views,
    stems: { tracks: [], recordings: options.recordings },
  };
  const session = new SoundtrackSession({
    manifest,
    ports,
    random: options.random ?? (() => 0),
    director: new StaticDirector(),
    resumePositions: {},
    onSounding,
    onResumeRefused: () => undefined,
  });
  return { session, output, setDimmed, onSounding };
}

const EMPTY_VIEWS: SoundtrackManifest["views"] = {
  home: [],
  task: [],
  bot: [],
  settings: [],
};

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("cuts a sounding recording at once, clears the dim and reports nothing sounding", async () => {
  const { session, output, setDimmed, onSounding } = openMixed({
    views: { ...EMPTY_VIEWS, home: ["piece"] },
    tracks: [pieceOf("piece", "master")],
    recordings: [{ name: "master", file: "piece.opus" }],
  });
  session.setSignals(HOME);
  await advance(1);
  expect(output.recordingStarts).toBe(1);
  setDimmed.mockClear();
  onSounding.mockClear();

  session.setSetPiecesEnabled(false);

  const cuts = output.cuts();
  expect(cuts).toHaveLength(1);
  expect(setDimmed).toHaveBeenLastCalledWith(false);
  expect(onSounding).toHaveBeenLastCalledWith(null);
  expect(session.end().home).toBeUndefined();
});

it("cancels a recording still loading, so it never starts once disabled", async () => {
  let resolveLoad: (buffer: AudioBuffer) => void = () => undefined;
  const { session, output } = openMixed({
    views: { ...EMPTY_VIEWS, home: ["piece"] },
    tracks: [pieceOf("piece", "master")],
    recordings: [{ name: "master", file: "piece.opus" }],
    loadRecording: () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
  });
  session.setSignals(HOME);
  await advance(0);
  expect(output.recordingStarts).toBe(0);

  session.setSetPiecesEnabled(false);
  resolveLoad(makeAudioBuffer(10, 10));
  await advance(1);

  expect(output.recordingStarts).toBe(0);
  session.end();
});

it("cancels a piece's own silence wait so it never starts", async () => {
  const { session, output } = openMixed({
    views: { ...EMPTY_VIEWS, home: ["one", "piece"] },
    tracks: [playbackTrack("one", 10), pieceOf("piece", "master")],
    recordings: [{ name: "master", file: "piece.opus" }],
  });
  session.setSignals(HOME);
  // "one" ends at about 10.05 s and "piece" is picked next, waiting out the
  // silence before it starts.
  await advance(11);
  expect(output.recordingStarts).toBe(0);

  session.setSetPiecesEnabled(false);
  await advance(30);

  expect(output.recordingStarts).toBe(0);
  session.end();
});

it("removes a sounding piece from the view so Previous cannot return to it", async () => {
  const { session, output } = openMixed({
    views: { ...EMPTY_VIEWS, home: ["one", "piece"] },
    tracks: [playbackTrack("one", 60), pieceOf("piece", "master")],
    recordings: [{ name: "master", file: "piece.opus" }],
  });
  session.setSignals(HOME);
  await advance(1);
  session.next();
  await advance(0);
  expect(output.recordingStarts).toBe(1);

  session.setSetPiecesEnabled(false);
  session.previous();

  expect(output.recordingStarts).toBe(1);
  expect(session.end().home?.trackName).toBe("one");
});

/**
 * "one" -> "piece" -> "two" through two Nexts, each a controlled pick from the
 * pool with the current track excluded: the first Next excludes "one" and
 * picks index 0 of ["piece", "two"]; the second excludes "piece" and picks
 * index 1 of ["one", "two"].
 */
function openHistoryOfThree() {
  const random = vi.fn(() => 0);
  const opened = openMixed({
    views: { ...EMPTY_VIEWS, home: ["one", "piece", "two"] },
    tracks: [
      playbackTrack("one", 60),
      pieceOf("piece", "master"),
      playbackTrack("two", 60),
    ],
    recordings: [{ name: "master", file: "piece.opus" }],
    random,
  });
  return { ...opened, random };
}

it("keeps a non-piece current track, re-indexed, and filters a piece out of its earlier history", async () => {
  const { session, output, random } = openHistoryOfThree();
  session.setSignals(HOME);
  await advance(1);
  session.next();
  await advance(0);
  expect(output.recordingStarts).toBe(1);
  random.mockReturnValueOnce(0.9);
  session.next();
  await advance(0);
  // Now on "two", with history ["one", "piece", "two"] at index 2.

  session.setSetPiecesEnabled(false);

  // The current track is untouched, and its index moves to the filtered
  // history's own end rather than running past it.
  session.previous();
  expect(session.end().home?.trackName).toBe("one");
});

it("never returns to a piece on Next either, once its history entry is filtered out", async () => {
  const { session, output, random } = openHistoryOfThree();
  session.setSignals(HOME);
  await advance(1);
  session.next();
  await advance(0);
  expect(output.recordingStarts).toBe(1);
  random.mockReturnValueOnce(0.9);
  session.next();
  await advance(0);
  session.setSetPiecesEnabled(false);
  session.previous();

  session.next();

  expect(session.end().home?.trackName).toBe("two");
  expect(output.recordingStarts).toBe(1);
});

it("stops a piece immediately even while paused, and resume does not restart it", async () => {
  const { session, output } = openMixed({
    views: { ...EMPTY_VIEWS, home: ["one", "piece"] },
    tracks: [playbackTrack("one", 60), pieceOf("piece", "master")],
    recordings: [{ name: "master", file: "piece.opus" }],
  });
  session.setSignals(HOME);
  await advance(1);
  session.next();
  await advance(0);
  expect(output.recordingStarts).toBe(1);
  session.pause();

  session.setSetPiecesEnabled(false);
  expect(output.cuts()).toHaveLength(1);

  session.play();
  await advance(5);

  expect(output.recordingStarts).toBe(1);
  session.end();
});

it("restores a piece to the pool once set pieces are enabled again", async () => {
  const { session, output } = openMixed({
    views: { ...EMPTY_VIEWS, home: ["piece"] },
    tracks: [pieceOf("piece", "master")],
    recordings: [{ name: "master", file: "piece.opus" }],
  });
  session.setSetPiecesEnabled(false);
  session.setSignals(HOME);
  await advance(1);
  expect(output.recordingStarts).toBe(0);

  session.setSetPiecesEnabled(true);
  await advance(1);

  expect(output.recordingStarts).toBe(1);
  session.end();
});

it("does nothing on a second call with the same value", async () => {
  const { session, output, setDimmed } = openMixed({
    views: { ...EMPTY_VIEWS, home: ["piece"] },
    tracks: [pieceOf("piece", "master")],
    recordings: [{ name: "master", file: "piece.opus" }],
  });
  session.setSignals(HOME);
  await advance(1);
  session.setSetPiecesEnabled(false);
  const callsAfterFirst = output.calls.length;
  setDimmed.mockClear();

  session.setSetPiecesEnabled(false);

  expect(output.calls).toHaveLength(callsAfterFirst);
  expect(setDimmed).not.toHaveBeenCalled();
  session.end();
});
