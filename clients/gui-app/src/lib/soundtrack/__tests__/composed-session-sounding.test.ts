import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StaticDirector } from "../directors";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import { SoundtrackLogRelay } from "../session-log";
import { makeAudioBuffer } from "./audio-buffer";
import { captureNothing, FakeStems } from "./fakes";
import { RecordingOutput } from "./recording-output";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SIGNALS = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
} as const;

function openTwoPieceSession() {
  const output = new RecordingOutput();
  const stems = new FakeStems(1);
  const sounding: (string | null)[] = [];
  const ports: SoundtrackPorts = {
    output,
    stems: {
      load: stems.load.bind(stems),
      loadRecording: () => Promise.resolve(makeAudioBuffer(10, 10)),
    },
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck: () => undefined,
    close: () => undefined,
    log: new SoundtrackLogRelay(),
    captureMix: captureNothing,
    pause: () => output.stopClock(),
    resume: () => output.startClock(),
  };
  const session = new SoundtrackSession({
    manifest: {
      tracks: [
        { kind: "composed", name: "a", title: "Piece A", recording: "ma" },
        { kind: "composed", name: "b", title: "Piece B", recording: "mb" },
      ],
      views: { home: ["a", "b"], task: [], bot: [], settings: [] },
      stems: {
        tracks: [],
        recordings: [
          { name: "ma", file: "a.opus" },
          { name: "mb", file: "b.opus" },
        ],
      },
    },
    ports,
    random: () => 0,
    director: new StaticDirector(),
    resumePositions: { home: { trackName: "a", elapsedSeconds: 0 } },
    onSounding: (mix) => sounding.push(mix?.track.name ?? null),
    onResumeRefused: () => undefined,
  });
  return { session, output, sounding };
}

it("reports the track a Next during the silence after an automatic run end starts", async () => {
  const { session, output, sounding } = openTwoPieceSession();
  session.setSignals(SIGNALS);
  await vi.advanceTimersByTimeAsync(1000);
  expect(output.recordings).toHaveLength(1);
  expect(sounding.at(-1)).toBe("a");

  // Land just after a replan tick so the next one is almost 5s away.
  await vi.advanceTimersByTimeAsync(4100);
  // Piece A plays out by itself; the view moves on to B and waits in silence.
  output.recordings[0].ended();
  await vi.advanceTimersByTimeAsync(500);
  expect(output.recordings).toHaveLength(1);

  // The person skips the silence: B's audio starts now.
  session.next();
  await vi.advanceTimersByTimeAsync(100);
  expect(output.recordings).toHaveLength(2);
  expect(output.recordings[1].cancelled).toBe(false);

  // What is reported as sounding must be what is audible.
  expect(sounding.at(-1)).toBe("b");
  session.end();
});

it("reports the next piece once an automatic run end's silence is over", async () => {
  const { session, output, sounding } = openTwoPieceSession();
  session.setSignals(SIGNALS);
  await vi.advanceTimersByTimeAsync(5100);
  output.recordings[0].ended();
  // Silence is 8s with random() = 0; step to just after audio B starts.
  await vi.advanceTimersByTimeAsync(8010);
  expect(output.recordings).toHaveLength(2);
  expect(sounding.at(-1)).toBe("b");
  session.end();
});
