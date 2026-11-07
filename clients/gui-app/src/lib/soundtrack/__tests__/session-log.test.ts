import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIX_DIRECTORS,
  DEFAULT_MIX_DIRECTOR,
  type MixDirector,
} from "../directors";
import type { SoundtrackManifest } from "../manifest";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import { SoundtrackLogRelay, type SoundtrackLogEvent } from "../session-log";
import type { MixSignals } from "../signals";
import type { Range, VariableTrack } from "../variable-sound";
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

// Two layers of four on in the first state, and a phase at 7 s that moves the
// run to a state of one to four, which the rules director then narrows by what
// the signals say. The director's own look comes at 5 s and 10 s, so 7.6 s is
// after the phase and before the next.
const PHASED_TRACK: VariableTrack = {
  ...TRACK,
  name: "phased",
  layers: ["A", "B", "C", "D"].map((name) => ({
    name,
    variants: 1,
    role: null,
    sublayers: 1,
    sublayerStartingOffset: null,
    pan: null,
  })),
  states: (
    [
      { name: "calm", numberOfEnabledLayers: [2, 2] },
      { name: "busy", numberOfEnabledLayers: [1, 4] },
    ] satisfies readonly { name: string; numberOfEnabledLayers: Range }[]
  ).map((state) => ({
    ...state,
    layersProperties: ["A", "B", "C", "D"].map(() => ({
      enabled: null,
      startPause: [0, 0],
      sequenceLength: [1, 1],
      pauseBetweenSamples: [0, 0],
      pauseBetweenRepetitions: [4, 4],
      playsPerRun: null,
    })),
  })),
  phases: [{ afterSeconds: [7, 7], state: "busy", fadeSeconds: 1 }],
};

interface PhasedRun {
  readonly session: SoundtrackSession;
  readonly output: FakeOutput;
  readonly events: SoundtrackLogEvent[];
  /** Times the director was asked for a plan. */
  readonly plans: { count: number };
  /** Times the session drew a random number. */
  readonly draws: { count: number };
}

/** A rules-director session on the phased track, its log listening or not. */
function phasedRun(listening: boolean): PhasedRun {
  const relay = new SoundtrackLogRelay();
  const events: SoundtrackLogEvent[] = [];
  if (listening) relay.listen((event) => events.push(event));
  const output = new FakeOutput();
  const ports: SoundtrackPorts = {
    output,
    stems: new FakeStems(2.2),
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck: () => undefined,
    close: () => undefined,
    log: relay,
    captureMix: captureNothing,
  };
  const plans = { count: 0 };
  const draws = { count: 0 };
  const drawn = mulberry32(2);
  const director: MixDirector = {
    plan: (signals, context) => {
      plans.count += 1;
      return MIX_DIRECTORS.rules.plan(signals, context);
    },
  };
  const session = new SoundtrackSession({
    manifest: {
      tracks: [PHASED_TRACK],
      views: { home: ["phased"], task: [], bot: [], settings: [] },
      stems: { tracks: [] },
    },
    ports,
    random: () => {
      draws.count += 1;
      return drawn();
    },
    director,
    resumePositions: {},
    onSounding: () => undefined,
  });
  session.setSignals({
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
  });
  return { session, output, events, plans, draws };
}

describe("SoundtrackSession.logNow", () => {
  it("only reads: across a phase it asks the director for nothing, draws nothing, and leaves what plays as it would have been", async () => {
    const recorded = phasedRun(true);
    const plain = phasedRun(false);

    await vi.advanceTimersByTimeAsync(7600);
    const plansBefore = recorded.plans.count;
    const drawsBefore = recorded.draws.count;
    recorded.session.logNow();
    expect(recorded.plans.count).toBe(plansBefore);
    expect(recorded.draws.count).toBe(drawsBefore);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(recorded.output.calls).toEqual(plain.output.calls);
    expect(recorded.draws.count).toBe(plain.draws.count);
    recorded.session.end();
    plain.session.end();
  });

  it("logs the plan last applied, as it was, after signals and what is sounding", async () => {
    const run = phasedRun(true);
    await vi.advanceTimersByTimeAsync(7600);
    const applied = run.events.filter((event) => event.type === "plan").at(-1);
    run.events.length = 0;

    run.session.logNow();

    expect(run.events.map((event) => event.type)).toEqual([
      "signals",
      "sounding",
      "plan",
    ]);
    expect(applied).toBeDefined();
    expect(run.events[2]).toEqual({ ...applied, t: run.events[2].t });
    run.session.end();
  });
});
