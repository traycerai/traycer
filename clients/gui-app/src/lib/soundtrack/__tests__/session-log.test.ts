import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIX_DIRECTORS, DEFAULT_MIX_DIRECTOR } from "../directors";
import type { SoundtrackManifest } from "../manifest";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import { SoundtrackLogRelay, type SoundtrackLogEvent } from "../session-log";
import type { MixSignals } from "../signals";
import type { VariableTrack } from "../variable-sound";
import { captureNothing, FakeOutput, FakeStems, mulberry32 } from "./fakes";

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

function openSession(): {
  session: SoundtrackSession;
  events: SoundtrackLogEvent[];
} {
  const relay = new SoundtrackLogRelay();
  const events: SoundtrackLogEvent[] = [];
  relay.listen((event) => events.push(event));
  const ports: SoundtrackPorts = {
    output: new FakeOutput(),
    stems: new FakeStems(2.2),
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck: () => undefined,
    close: () => undefined,
    log: relay,
    captureMix: captureNothing,
  };
  const session = new SoundtrackSession({
    manifest: MANIFEST,
    ports,
    random: mulberry32(1),
    director: MIX_DIRECTORS[DEFAULT_MIX_DIRECTOR],
    resumePositions: {},
    onSounding: () => undefined,
  });
  return { session, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SoundtrackSession's decision log", () => {
  it("writes a signals event of the five values a director reads and nothing else the caller carries", () => {
    const { session, events } = openSession();
    const signals: MixSignals = {
      view: "home",
      working: 2,
      blocking: 1,
      failure: 0,
      done: 3,
    };
    const carrying = {
      ...signals,
      chatTitle: "Secret chat",
      taskId: "task-123",
    };

    session.setSignals(carrying);

    const written = events.filter((event) => event.type === "signals");
    expect(written).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(written[0]))).toEqual({
      type: "signals",
      t: 0,
      view: "home",
      working: 2,
      blocking: 1,
      failure: 0,
      done: 3,
    });
    expect(JSON.stringify(events)).not.toMatch(/Secret chat|task-123/);
    session.end();
  });

  it("logNow writes signals, then what is sounding, then the plan", async () => {
    const { session, events } = openSession();
    session.setSignals({
      view: "home",
      working: 0,
      blocking: 0,
      failure: 0,
      done: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);
    events.length = 0;

    session.logNow();

    expect(events.map((event) => event.type)).toEqual([
      "signals",
      "sounding",
      "plan",
    ]);
    const sounding = events[1];
    expect(sounding).toMatchObject({
      type: "sounding",
      view: "home",
      player: { track: "calm", state: "only" },
    });
    expect(
      sounding.type === "sounding" ? sounding.player?.layers : null,
    ).toEqual([{ layer: "A", role: "pad", enabled: true, target: 1 }]);
    expect(
      sounding.type === "sounding" ? sounding.player?.samples.length : 0,
    ).toBeGreaterThan(0);
    session.end();
  });
});
