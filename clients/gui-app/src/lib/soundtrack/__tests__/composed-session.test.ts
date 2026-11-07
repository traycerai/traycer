import { appLogger } from "@/lib/logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OutputGain, OutputVoice } from "../output";
import { StaticDirector } from "../directors";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import { SoundtrackLogRelay } from "../session-log";
import { makeAudioBuffer } from "./audio-buffer";
import { playbackTrack } from "./playback-track";
import { captureNothing, FakeOutput, FakeStems } from "./fakes";

interface RecordingCall {
  readonly duration: number;
  readonly offset: number;
  readonly ended: () => void;
  cancelled: boolean;
}

class RecordingOutput extends FakeOutput {
  readonly recordings: RecordingCall[] = [];
  failPlayback = false;

  override createBus(): OutputGain {
    const wrap = (gain: OutputGain): OutputGain => ({
      ramp: (target, seconds) => gain.ramp(target, seconds),
      createChild: (initial, pan) => wrap(gain.createChild(initial, pan)),
      play: (buffer, when, fade) => gain.play(buffer, when, fade),
      playRecording: (buffer, _when, offset, ended): OutputVoice => {
        if (this.failPlayback) throw new Error("secret-token");
        const call: RecordingCall = {
          duration: buffer.duration,
          offset,
          ended,
          cancelled: false,
        };
        this.recordings.push(call);
        return {
          cut: () => {
            call.cancelled = true;
          },
        };
      },
    });
    return wrap(super.createBus());
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function openSession(options: { missingLoader?: boolean }) {
  const output = new RecordingOutput();
  const stems = new FakeStems(1);
  const loadRecording = vi.fn(() => Promise.resolve(makeAudioBuffer(10, 10)));
  const duck = vi.fn<(seconds: number) => void>();
  const ports: SoundtrackPorts = {
    output,
    stems: options.missingLoader
      ? { load: stems.load.bind(stems) }
      : { load: stems.load.bind(stems), loadRecording },
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck,
    close: () => undefined,
    log: new SoundtrackLogRelay(),
    captureMix: captureNothing,
    pause: () => output.stopClock(),
    resume: () => output.startClock(),
  };
  const session = new SoundtrackSession({
    manifest: {
      tracks: [
        {
          kind: "composed",
          name: "piece",
          title: "Piece",
          recording: "master",
        },
      ],
      views: { home: ["piece"], task: [], bot: [], settings: [] },
      stems: {
        tracks: [],
        recordings: [{ name: "master", file: "piece.opus" }],
      },
    },
    ports,
    random: () => 0,
    director: new StaticDirector(),
    resumePositions: {},
    onSounding: () => undefined,
    onResumeRefused: () => undefined,
  });
  return { session, output, loadRecording, duck };
}

it("plays a complete recording through the session and preserves the heard position across a pause", async () => {
  const { session, output, loadRecording, duck } = openSession({});
  session.setSignals({
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(loadRecording).toHaveBeenCalledWith("master");
  expect(output.recordings).toHaveLength(1);
  expect(output.recordings[0]).toMatchObject({ duration: 10, offset: 0 });
  session.duck(2);
  expect(duck).toHaveBeenCalledWith(2);
  session.pause();
  await vi.advanceTimersByTimeAsync(20000);
  session.play();
  await vi.advanceTimersByTimeAsync(2000);
  const position = session.end().home;
  expect(position?.trackName).toBe("piece");
  expect(position?.elapsedSeconds).toBeCloseTo(5, 0);
});

it("ignores a late completion from a recording replaced by Next", async () => {
  const { session, output } = openSession({});
  session.setSignals({
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
  });
  await vi.advanceTimersByTimeAsync(1000);
  const old = output.recordings[0];
  expect(old).toBeDefined();
  session.next();
  await vi.advanceTimersByTimeAsync(100);
  expect(old.cancelled).toBe(true);
  expect(output.recordings).toHaveLength(2);
  // Simulate an already queued ended callback arriving after the old voice was cut.
  old.ended();
  await vi.advanceTimersByTimeAsync(9000);
  expect(output.recordings).toHaveLength(2);
  expect(session.end().home?.trackName).toBe("piece");
});

it("defers a held natural completion and its quiet gap until Play", async () => {
  const { session, output } = openSession({});
  session.setSignals({
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
  });
  await vi.advanceTimersByTimeAsync(1000);
  const first = output.recordings[0];
  session.pause();
  first.ended();
  await vi.advanceTimersByTimeAsync(20000);
  expect(output.recordings).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);

  session.play();
  await vi.advanceTimersByTimeAsync(7900);
  expect(output.recordings).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(200);
  expect(output.recordings).toHaveLength(2);
  // A queued callback from the previous run cannot end the new one.
  first.ended();
  await vi.advanceTimersByTimeAsync(9000);
  expect(output.recordings).toHaveLength(2);
  session.end();
});

it("starts the manual-skip fade when the recording loads and clears the previous dim", async () => {
  const output = new RecordingOutput();
  const stems = new FakeStems(1);
  let land: (buffer: AudioBuffer) => void = () => undefined;
  const setDimmed = vi.fn<(dimmed: boolean) => void>();
  const ports: SoundtrackPorts = {
    output,
    stems: {
      load: stems.load.bind(stems),
      loadRecording: () =>
        new Promise((resolve) => {
          land = resolve;
        }),
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
  const director = new StaticDirector();
  const session = new SoundtrackSession({
    manifest: {
      tracks: [
        playbackTrack("generated", 60),
        {
          kind: "composed",
          name: "piece",
          title: "Piece",
          recording: "master",
        },
      ],
      views: { home: ["generated", "piece"], task: [], bot: [], settings: [] },
      stems: {
        tracks: [],
        recordings: [{ name: "master", file: "piece.opus" }],
      },
    },
    ports,
    random: () => 0,
    director: {
      plan: (signals, context) => ({
        ...director.plan(signals, context),
        dim: true,
      }),
    },
    resumePositions: {},
    onSounding: () => undefined,
    onResumeRefused: () => undefined,
  });
  session.setSignals({
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(setDimmed).toHaveBeenLastCalledWith(true);
  session.next();
  await vi.advanceTimersByTimeAsync(5000);
  expect(output.recordings).toHaveLength(0);
  land(makeAudioBuffer(10, 10));
  await vi.advanceTimersByTimeAsync(0);
  expect(output.recordings).toHaveLength(1);
  expect(setDimmed).toHaveBeenLastCalledWith(false);
  expect(output.ramps("bus1")).toContainEqual(
    expect.objectContaining({ target: 1, seconds: 2, at: 6 }),
  );
  session.end();
});

const failureSignals = {
  view: "home" as const,
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

it("reports a current load rejection without leaking its error", async () => {
  const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
  const { session, output, loadRecording } = openSession({});
  loadRecording.mockRejectedValue(
    new Error("https://example.test/file?token=secret-token"),
  );
  session.setSignals(failureSignals);
  await vi.advanceTimersByTimeAsync(1000);
  expect(output.recordings).toHaveLength(0);
  expect(warn).toHaveBeenCalledWith("[soundtrack] could not play a recording", {
    track: "piece",
    recording: "master",
    stage: "load",
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
  session.end();
});

it("ignores a stale load rejection after Next starts a replacement", async () => {
  const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
  const { session, output, loadRecording } = openSession({});
  let rejectOld: (reason: Error) => void = () => undefined;
  loadRecording.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  session.setSignals(failureSignals);
  await vi.advanceTimersByTimeAsync(1000);
  session.next();
  await vi.advanceTimersByTimeAsync(100);
  expect(output.recordings).toHaveLength(1);
  rejectOld(new Error("secret-token"));
  await vi.advanceTimersByTimeAsync(0);
  expect(output.recordings).toHaveLength(1);
  expect(warn).not.toHaveBeenCalled();
  session.end();
});

it("handles a synchronous loader throw and a missing loader quietly", async () => {
  const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
  const first = openSession({});
  first.loadRecording.mockImplementation(() => {
    throw new Error("secret-token");
  });
  first.session.setSignals(failureSignals);
  await vi.advanceTimersByTimeAsync(1000);
  expect(first.output.recordings).toHaveLength(0);
  expect(warn).toHaveBeenCalledWith("[soundtrack] could not play a recording", {
    track: "piece",
    recording: "master",
    stage: "load",
  });
  first.session.end();
  warn.mockClear();
  const second = openSession({ missingLoader: true });
  second.session.setSignals(failureSignals);
  await vi.advanceTimersByTimeAsync(1000);
  expect(second.output.recordings).toHaveLength(0);
  expect(warn).toHaveBeenCalledWith("[soundtrack] could not play a recording", {
    track: "piece",
    recording: "master",
    stage: "unavailable",
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
  second.session.end();
});

it("handles a playback failure when a held load is released", async () => {
  const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
  const { session, output, loadRecording } = openSession({});
  let resolveLoad: (buffer: AudioBuffer) => void = () => undefined;
  loadRecording.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
  );
  session.setSignals(failureSignals);
  await vi.advanceTimersByTimeAsync(1000);
  session.pause();
  resolveLoad(makeAudioBuffer(10, 10));
  await vi.advanceTimersByTimeAsync(0);
  output.failPlayback = true;
  session.play();
  await vi.advanceTimersByTimeAsync(0);
  expect(output.recordings).toHaveLength(0);
  expect(warn).toHaveBeenCalledWith("[soundtrack] could not play a recording", {
    track: "piece",
    recording: "master",
    stage: "play",
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
  session.end();
});
