import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { MIX_TUNING } from "../mix-tuning";
import { TrackPlayer } from "../player";
import { SoundtrackLogRelay } from "../session-log";
import type { StemSource } from "../stems";
import type {
  Bookend,
  GroupedLayer,
  Layer,
  LayerProperties,
  Phase,
  State,
  VariableTrack,
} from "../variable-sound";
import { makeAudioBuffer } from "./audio-buffer";
import { FakeOutput, FakeStems } from "./fakes";

// The player starts a run this far into the clock, so track time t plays at
// clock time START_LEAD + t.
const START_LEAD_SECONDS = 0.05;

function properties(
  enabled: boolean | null,
  startPause: number,
  pauseBetweenRepetitions: number,
  playsPerRun: number | null,
): LayerProperties {
  return {
    enabled,
    startPause: [startPause, startPause],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions: [pauseBetweenRepetitions, pauseBetweenRepetitions],
    playsPerRun,
  };
}

function layerOf(name: string, variants: number, pan: number | null): Layer {
  return {
    name,
    variants,
    role: null,
    sublayers: 1,
    sublayerStartingOffset: null,
    pan,
  };
}

function stateOf(
  name: string,
  layersProperties: readonly LayerProperties[],
  enabledCount: number,
): State {
  return {
    name,
    layersProperties,
    numberOfEnabledLayers: [enabledCount, enabledCount],
  };
}

interface TrackShape {
  readonly lengthSeconds: number;
  readonly layers: readonly Layer[];
  readonly states: readonly State[];
  readonly intro: Bookend | null;
  readonly outro: Bookend | null;
  readonly phases: readonly Phase[];
}

function buildTrack(shape: TrackShape): VariableTrack {
  return { name: "arc", title: "Arc", alignmentSeconds: 0.5, ...shape };
}

/** A stem source whose samples are as long as their layer or bookend says. */
function stemsOfLength(secondsByName: ReadonlyMap<string, number>): StemSource {
  return {
    load: (_track, layer) => {
      const seconds = secondsByName.get(layer.name);
      return seconds === undefined
        ? Promise.reject(new Error(`no length for ${layer.name}`))
        : Promise.resolve(makeAudioBuffer(seconds, 10));
    },
  };
}

function makePlayer(
  output: FakeOutput,
  stems: StemSource,
  track: VariableTrack,
  resumeAt: number,
): TrackPlayer {
  return new TrackPlayer({
    track,
    output,
    stems,
    random: () => 0.5,
    log: new SoundtrackLogRelay(),
    silenceSeconds: [5, 5],
    resumeAt,
    onRunStart: () => undefined,
    onRunEnd: () => undefined,
  });
}

/** As `makePlayer`, but a random of 0 opens every run in the first state. */
function makeFirstStatePlayer(
  output: FakeOutput,
  stems: StemSource,
  track: VariableTrack,
): TrackPlayer {
  return new TrackPlayer({
    track,
    output,
    stems,
    random: () => 0,
    log: new SoundtrackLogRelay(),
    silenceSeconds: [5, 5],
    resumeAt: 0,
    onRunStart: () => undefined,
    onRunEnd: () => undefined,
  });
}

/** Two layers that stay enabled; "storm" follows "calm" after 5 s over 6 s. */
const STORM_PHASE: Phase = {
  afterSeconds: [5, 5],
  state: "storm",
  fadeSeconds: 6,
};

function makePhasedTrack(phases: readonly Phase[]): VariableTrack {
  const layersProperties = [
    properties(null, 0, 4, null),
    properties(null, 0.2, 4, null),
  ];
  return buildTrack({
    lengthSeconds: 60,
    layers: [layerOf("A", 2, null), layerOf("B", 2, null)],
    states: [
      stateOf("calm", layersProperties, 2),
      stateOf("storm", layersProperties, 2),
    ],
    intro: null,
    outro: null,
    phases,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TrackPlayer run arc", () => {
  it("plays the intro at track time 0 and starts the layers after its end, on the grid", async () => {
    const output = new FakeOutput();
    // The intro ends at 2.3 s; a 0.4 s start pause puts the layer at 2.7 s,
    // which the 0.5 s grid takes to 3 s.
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 2, null)],
      states: [stateOf("only", [properties(null, 0.4, 4, null)], 1)],
      intro: { name: "I", variants: 1, pan: null },
      outro: null,
      phases: [],
    });
    const player = makePlayer(
      output,
      stemsOfLength(
        new Map([
          ["I", 2.3],
          ["A", 1],
        ]),
      ),
      track,
      0,
    );
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(4000);

    const intro = output.plays("bus0/1");
    expect(intro).toHaveLength(1);
    expect(intro[0].when).toBeCloseTo(START_LEAD_SECONDS, 6);
    const layer = output.plays("bus0/0");
    expect(layer[0].when - intro[0].when).toBeCloseTo(3, 6);
  });

  it("lets the last samples ring through the outro and fades them over the ring-out when it ends", async () => {
    const output = new FakeOutput();
    // The layer plays at 3 s and 9 s for 6 s each, so the second sample sounds
    // across the 10 s length and past the outro's end at 13 s.
    const track = buildTrack({
      lengthSeconds: 10,
      layers: [layerOf("A", 2, null)],
      states: [stateOf("only", [properties(null, 3, 0, null)], 1)],
      intro: null,
      outro: { name: "O", variants: 1, pan: null },
      phases: [],
    });
    const player = makePlayer(
      output,
      stemsOfLength(
        new Map([
          ["A", 6],
          ["O", 3],
        ]),
      ),
      track,
      0,
    );
    player.start(0, 0.1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(
      output.plays("bus0/0").map((play) => play.when - START_LEAD_SECONDS),
    ).toEqual([3, 9]);
    const outro = output.plays("bus0/1");
    expect(outro).toHaveLength(1);
    expect(outro[0].when).toBeCloseTo(START_LEAD_SECONDS + 10, 6);
    expect(output.cuts()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1200);
    expect(
      output.cuts().map((cut) => ({ gain: cut.gain, fade: cut.fade })),
    ).toEqual([{ gain: "bus0/0", fade: MIX_TUNING.outroRingOutSeconds }]);
    expect(player.currentState()).toBeNull();

    await vi.advanceTimersByTimeAsync(3800);
    expect(player.currentState()).toBeNull();
    expect(output.allPlays()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(5000);
    expect(player.currentState()).not.toBeNull();
    const layer = output.plays("bus0/0");
    expect(layer).toHaveLength(3);
    // The silence ended on the tick at 18.12 s; the new run's layer waits 3 s.
    expect(layer[2].when).toBeCloseTo(18.12 + START_LEAD_SECONDS + 3, 6);
  });

  it("moves to a phase's state at its drawn time and fades the layers over the phase's length", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(2.2),
      makePhasedTrack([STORM_PHASE]),
      0,
    );
    player.start(0, 0.1);

    await vi.advanceTimersByTimeAsync(4900);
    expect(player.currentState()?.name).toBe("calm");
    expect(output.ramps("bus0/0").map((ramp) => ramp.seconds)).toEqual([0.01]);

    // The phase fires on the first tick at track time 5 s; the move lands on
    // the next 0.5 s tick, 5.5 s.
    await vi.advanceTimersByTimeAsync(400);
    for (const gain of ["bus0/0", "bus0/1"]) {
      expect(output.ramps(gain).map((ramp) => ramp.seconds)).toEqual([0.01, 6]);
    }
    const fired = output.ramps("bus0/0")[1];
    expect(fired.at).toBeGreaterThanOrEqual(5 + START_LEAD_SECONDS);
    expect(fired.at).toBeLessThan(5.2);
    expect(player.currentState()?.name).toBe("calm");

    await vi.advanceTimersByTimeAsync(400);
    expect(player.currentState()?.name).toBe("storm");
  });

  it("opens a player resumed past a phase in the phase's state and never fires it", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(2.2),
      makePhasedTrack([STORM_PHASE]),
      10,
    );
    player.start(player.elapsed(), 0.1);
    expect(player.currentState()?.name).toBe("storm");

    await vi.advanceTimersByTimeAsync(3000);
    expect(player.currentState()?.name).toBe("storm");
    for (const gain of ["bus0/0", "bus0/1"]) {
      expect(output.ramps(gain).map((ramp) => ramp.seconds)).toEqual([0.01]);
    }
  });

  it("drops every phase a resume has passed, so a later phase back to the first state does not replay them", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(2.2),
      makePhasedTrack([
        STORM_PHASE,
        { afterSeconds: [8, 8], state: "calm", fadeSeconds: 6 },
      ]),
      10,
    );
    player.start(player.elapsed(), 0.1);
    expect(player.currentState()?.name).toBe("calm");

    await vi.advanceTimersByTimeAsync(3000);
    expect(player.currentState()?.name).toBe("calm");
    for (const gain of ["bus0/0", "bus0/1"]) {
      expect(output.ramps(gain).map((ramp) => ramp.seconds)).toEqual([0.01]);
    }
  });

  it("starts the layers only once the intro has loaded, from its end", async () => {
    const output = new FakeOutput();
    const intro = Promise.withResolvers<AudioBuffer>();
    const stems: StemSource = {
      load: (_track, layer) =>
        layer.name === "I"
          ? intro.promise
          : Promise.resolve(makeAudioBuffer(1, 10)),
    };
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 2, null)],
      states: [stateOf("only", [properties(null, 0.4, 4, null)], 1)],
      intro: { name: "I", variants: 1, pan: null },
      outro: null,
      phases: [],
    });
    const player = makePlayer(output, stems, track, 0);
    player.start(0, 0.1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(output.allPlays()).toEqual([]);

    // Loaded at 3 s, the intro takes the next free tick, 3 s into the run; the
    // layer waits out its 2.3 s and its 0.4 s pause, 5.7 s, snapped to 6 s.
    intro.resolve(makeAudioBuffer(2.3, 10));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    const introPlays = output.plays("bus0/1");
    expect(introPlays).toHaveLength(1);
    expect(introPlays[0].when).toBeCloseTo(START_LEAD_SECONDS + 3, 6);
    expect(output.plays("bus0/0")[0].when - introPlays[0].when).toBeCloseTo(
      3,
      6,
    );
  });

  it("keeps the layers waiting for the intro's end when the state moves while it sounds", async () => {
    const output = new FakeOutput();
    const layersProperties = [properties(null, 0, 4, null)];
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 2, null)],
      states: [
        stateOf("first", layersProperties, 1),
        stateOf("second", layersProperties, 1),
      ],
      intro: { name: "I", variants: 1, pan: null },
      outro: null,
      phases: [],
    });
    const player = makeFirstStatePlayer(
      output,
      stemsOfLength(
        new Map([
          ["I", 10],
          ["A", 1],
        ]),
      ),
      track,
    );
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1000);
    player.enterState("second");
    await vi.advanceTimersByTimeAsync(10_000);

    const intro = output.plays("bus0/1");
    expect(intro).toHaveLength(1);
    expect(intro[0].when).toBeCloseTo(START_LEAD_SECONDS, 6);
    expect(output.plays("bus0/0")[0].when).toBeCloseTo(intro[0].when + 10, 6);
  });

  it("keeps a run's plays when the state is chosen while stopped", async () => {
    const output = new FakeOutput();
    const layersProperties = [properties(null, 0, 4, 1)];
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 2, null)],
      states: [
        stateOf("first", layersProperties, 1),
        stateOf("second", layersProperties, 1),
      ],
      intro: null,
      outro: null,
      phases: [],
    });
    const player = makeFirstStatePlayer(output, new FakeStems(1), track);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(2000);
    player.stop(0.1);
    player.enterState("second");
    await vi.advanceTimersByTimeAsync(3000);
    player.start(player.elapsed(), 0.1);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(player.currentState()?.name).toBe("second");
    expect(output.plays("bus0/0")).toHaveLength(1);
  });

  it("lets a layer play after a resume when its capped play was cut before it sounded", async () => {
    const output = new FakeOutput();
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 2, null)],
      states: [stateOf("only", [properties(null, 1, 4, 1)], 1)],
      intro: null,
      outro: null,
      phases: [],
    });
    const player = makePlayer(output, new FakeStems(1), track, 0);
    player.start(0, 0.1);
    // The 0.48 s tick hands the output the play due at 1.05 s.
    await vi.advanceTimersByTimeAsync(600);
    expect(output.plays("bus0/0")).toHaveLength(1);
    player.stop(0.1);
    await vi.advanceTimersByTimeAsync(4400);
    player.start(player.elapsed(), 0.1);
    await vi.advanceTimersByTimeAsync(3000);

    expect(output.plays("bus0/0").filter((play) => play.at >= 5)).toHaveLength(
      1,
    );
  });

  it("gives back a skipped sample and the one a state move placed after it when a stop cuts both, so a resume plays each group once", async () => {
    const output = new FakeOutput();
    const layer: GroupedLayer = {
      name: "G",
      groups: [
        { name: "X", variants: 1 },
        { name: "Y", variants: 1 },
      ],
      sequence: ["X", "Y"],
      role: null,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    };
    const track: VariableTrack = {
      ...buildTrack({
        lengthSeconds: 60,
        layers: [layer],
        states: [
          stateOf("first", [properties(null, 0.75, 0, 2)], 1),
          stateOf("second", [properties(null, 0, 0, 2)], 1),
        ],
        intro: null,
        outro: null,
        phases: [],
      }),
      alignmentSeconds: 0.25,
    };
    // X is variant 1 and Y variant 2; the first load of X fails once.
    let xLoads = 0;
    const stems: StemSource = {
      load: (_track, _layer, variant) => {
        if (variant === 1) {
          xLoads += 1;
          if (xLoads === 1) return Promise.reject(new Error("transient"));
        }
        return Promise.resolve(makeAudioBuffer(variant === 1 ? 0.1 : 0.2, 10));
      },
    };
    const player = makeFirstStatePlayer(output, stems, track);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(250);
    player.enterState("second");
    await vi.advanceTimersByTimeAsync(470);
    // The stop is at clock 0.72, before the sample reported for 0.80 sounds.
    player.stop(0.1);
    await vi.advanceTimersByTimeAsync(4280);
    expect(output.plays("bus0/0").every((play) => play.when > 0.72)).toBe(true);

    player.start(player.elapsed(), 0.1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(
      output
        .plays("bus0/0")
        .filter((play) => play.at >= 5)
        .map((play) => play.duration),
    ).toEqual([0.1, 0.2]);
  });

  it("does not play a capped layer again when a start resumes from before a sample that sounded", async () => {
    const output = new FakeOutput();
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 2, null)],
      states: [stateOf("only", [properties(null, 1, 4, 1)], 1)],
      intro: null,
      outro: null,
      phases: [],
    });
    const player = makePlayer(output, new FakeStems(1), track, 0);
    player.start(0, 0.1);
    // The 0.48 s tick hands the output the play due at 1.05 s, which sounds.
    await vi.advanceTimersByTimeAsync(2000);
    expect(output.plays("bus0/0")).toHaveLength(1);
    player.stop(0.1);
    await vi.advanceTimersByTimeAsync(3000);
    player.start(0.5, 0.1);
    await vi.advanceTimersByTimeAsync(8000);

    expect(output.plays("bus0/0")).toHaveLength(1);
  });

  it("lets a capped layer play after a resume when a stop cut its late-loaded play before the start it moved to", async () => {
    const output = new FakeOutput();
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 2, null)],
      states: [stateOf("only", [properties(null, 1, 4, 1)], 1)],
      intro: null,
      outro: null,
      phases: [],
    });
    const stems = new FakeStems(1);
    stems.holdLayer("A");
    const player = makePlayer(output, stems, track, 0);
    player.start(0, 0.1);
    // The play decided for track 1.0 waits for its audio, which arrives at
    // track 1.25, so it moves to 1.5 (clock 1.55).
    await vi.advanceTimersByTimeAsync(1300);
    stems.releaseLayer("A");
    await vi.advanceTimersByTimeAsync(100);
    player.stop(0.1);
    await vi.advanceTimersByTimeAsync(3600);
    expect(output.plays("bus0/0").map((play) => play.when)).toEqual([
      expect.closeTo(1.55, 6),
    ]);

    player.start(player.elapsed(), 0.1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(output.plays("bus0/0").filter((play) => play.at >= 5)).toHaveLength(
      1,
    );
  });

  it("adds no ramp for a restated target, keeps a long fade's end when a layer is switched on again, and ramps a changed target over 1.5 s", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(2.2),
      makePhasedTrack([STORM_PHASE]),
      0,
    );
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(8000);
    const fade = output.ramps("bus0/0")[1];
    expect(fade.seconds).toBe(6);

    player.setLayerTarget(0, 1);
    expect(output.ramps("bus0/0")).toHaveLength(2);

    // The layer is already on, so this ramps to where the fade is taking it and
    // ends with the fade.
    player.setLayerEnabled(0, true);
    const kept = output.ramps("bus0/0")[2];
    expect(kept.target).toBe(1);
    expect(kept.at + kept.seconds).toBeCloseTo(fade.at + fade.seconds, 6);

    player.setLayerTarget(0, 0.5);
    expect(output.ramps("bus0/0")[3]).toMatchObject({
      target: 0.5,
      seconds: 1.5,
    });

    player.setLayerTarget(0, 0.5);
    expect(output.ramps("bus0/0")).toHaveLength(4);
  });

  it("plays a layer capped at one play per run once, and again in the next run", async () => {
    const output = new FakeOutput();
    const track = buildTrack({
      lengthSeconds: 10,
      layers: [layerOf("A", 1, null)],
      states: [stateOf("only", [properties(null, 1, 1, 1)], 1)],
      intro: null,
      outro: null,
      phases: [],
    });
    const player = makePlayer(output, new FakeStems(1), track, 0);
    player.start(0, 0.1);

    // Uncapped, the layer would come round every 2 s.
    await vi.advanceTimersByTimeAsync(9000);
    expect(output.plays("bus0/0")).toHaveLength(1);

    // The run ends at 10 s, the silence lasts 5 s, and the next run plays once.
    await vi.advanceTimersByTimeAsync(9000);
    const plays = output.plays("bus0/0");
    expect(plays).toHaveLength(2);
    expect(plays[1].when).toBeGreaterThan(15);
  });

  it("places layers and bookends in the stereo field with the pan the track gives them", () => {
    const output = new FakeOutput();
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 1, 0.5), layerOf("B", 1, null)],
      states: [
        stateOf(
          "only",
          [properties(null, 0, 4, null), properties(null, 0, 4, null)],
          2,
        ),
      ],
      intro: { name: "I", variants: 1, pan: -0.3 },
      outro: { name: "O", variants: 1, pan: 1 },
      phases: [],
    });
    makePlayer(output, new FakeStems(1), track, 0);

    expect(Object.fromEntries(output.pans)).toEqual({
      "bus0/0": 0.5,
      "bus0/1": null,
      "bus0/2": -0.3,
      "bus0/3": 1,
    });
  });

  it("leaves a layer the state pins as it is when asked to switch it", async () => {
    const output = new FakeOutput();
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [
        layerOf("A", 1, null),
        layerOf("B", 1, null),
        layerOf("C", 1, null),
      ],
      states: [
        stateOf(
          "only",
          [
            properties(true, 0, 4, null),
            properties(false, 0, 4, null),
            properties(null, 0, 4, null),
          ],
          1,
        ),
      ],
      intro: null,
      outro: null,
      phases: [],
    });
    const player = makePlayer(output, new FakeStems(1), track, 0);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.enabledLayers()).toEqual([true, false, false]);

    const callsBefore = output.calls.length;
    player.setLayerEnabled(0, false);
    player.setLayerEnabled(1, true);
    expect(player.enabledLayers()).toEqual([true, false, false]);
    expect(output.calls).toHaveLength(callsBefore);

    // The layer left to the roll does switch, and ramps.
    player.setLayerEnabled(2, true);
    expect(player.enabledLayers()).toEqual([true, false, true]);
    expect(output.ramps("bus0/2").at(-1)).toMatchObject({
      target: 1,
      seconds: 1.5,
    });
  });
});

interface ObservedPlayer {
  readonly player: TrackPlayer;
  readonly onRunStart: Mock<(state: State) => void>;
  readonly onRunEnd: Mock<(silenceSeconds: number) => void>;
}

interface ObservedOptions {
  readonly output: FakeOutput;
  readonly stems: StemSource;
  readonly track: VariableTrack;
  readonly resumeAt: number;
  /** Runs inside `onRunStart`, with the player and the state it opens in. */
  readonly reactToStart: (player: TrackPlayer, state: State) => void;
  /** Runs inside `onRunEnd`. */
  readonly reactToEnd: (player: TrackPlayer) => void;
}

function observedPlayer(options: ObservedOptions): ObservedPlayer {
  const onRunStart = vi.fn<(state: State) => void>((state) => {
    options.reactToStart(player, state);
  });
  const onRunEnd = vi.fn<(silenceSeconds: number) => void>(() => {
    options.reactToEnd(player);
  });
  const player: TrackPlayer = new TrackPlayer({
    track: options.track,
    output: options.output,
    stems: options.stems,
    random: () => 0,
    log: new SoundtrackLogRelay(),
    silenceSeconds: [5, 5],
    resumeAt: options.resumeAt,
    onRunStart,
    onRunEnd,
  });
  return { player, onRunStart, onRunEnd };
}

function shortTrack(lengthSeconds: number): VariableTrack {
  return buildTrack({
    lengthSeconds,
    layers: [layerOf("A", 1, null)],
    states: [stateOf("only", [properties(null, 1, 4, null)], 1)],
    intro: null,
    outro: null,
    phases: [],
  });
}

const NOTHING = (): void => undefined;

describe("TrackPlayer run events", () => {
  it("tells each run's start once, with the state it opens in and before anything plays", async () => {
    const output = new FakeOutput();
    const seen: { current: State | null; plays: number }[] = [];
    const { player, onRunStart } = observedPlayer({
      output,
      stems: new FakeStems(1),
      track: shortTrack(10),
      resumeAt: 0,
      reactToStart: (running) => {
        seen.push({
          current: running.currentState(),
          plays: output.allPlays().length,
        });
      },
      reactToEnd: NOTHING,
    });
    player.start(0, 0.1);
    expect(onRunStart).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ current: onRunStart.mock.calls[0][0], plays: 0 }]);

    // The run ends at 10.05 s and the silence lasts 5 s; the second run opens
    // at about 15.2 s, and the third is past 25 s.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRunStart).toHaveBeenCalledTimes(2);
  });

  it("does not tell a start that resumes a run, or one that opens partway into the track", async () => {
    const resumed = observedPlayer({
      output: new FakeOutput(),
      stems: new FakeStems(1),
      track: shortTrack(10),
      resumeAt: 0,
      reactToStart: NOTHING,
      reactToEnd: NOTHING,
    });
    resumed.player.start(0, 0.1);
    // Stopped inside the start lead, it resumes the same run from 0.
    resumed.player.stop(0.1);
    resumed.player.start(resumed.player.elapsed(), 0.1);
    await vi.advanceTimersByTimeAsync(3000);
    resumed.player.stop(0.1);
    resumed.player.start(resumed.player.elapsed(), 0.1);
    expect(resumed.onRunStart).toHaveBeenCalledTimes(1);
    resumed.player.stop(0.1);

    // Opening at 20 s of 30, the run ends at 10.05 s of the clock and the next
    // one opens at about 15.2 s.
    const partway = observedPlayer({
      output: new FakeOutput(),
      stems: new FakeStems(1),
      track: shortTrack(30),
      resumeAt: 20,
      reactToStart: NOTHING,
      reactToEnd: NOTHING,
    });
    partway.player.start(20, 0.1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(partway.onRunStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8000);
    expect(partway.onRunStart).toHaveBeenCalledTimes(1);
  });

  it("lets a layer turned on from the callback start at the intro's end, not before", async () => {
    const output = new FakeOutput();
    const track = buildTrack({
      lengthSeconds: 60,
      layers: [layerOf("A", 1, null), layerOf("B", 1, null)],
      states: [
        stateOf(
          "only",
          [properties(null, 0, 4, null), properties(null, 0, 4, null)],
          1,
        ),
      ],
      intro: { name: "I", variants: 1, pan: null },
      outro: null,
      phases: [],
    });
    // A random of 0 rolls layer A on and leaves B off.
    const { player, onRunStart } = observedPlayer({
      output,
      stems: stemsOfLength(
        new Map([
          ["I", 2.3],
          ["A", 1],
          ["B", 1],
        ]),
      ),
      track,
      resumeAt: 0,
      reactToStart: (running) => {
        expect(running.enabledLayers()).toEqual([true, false]);
        running.setLayerEnabled(1, true);
      },
      reactToEnd: NOTHING,
    });
    player.start(0, 0.1);
    expect(onRunStart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);

    // The intro ends at 2.3 s, which the 0.5 s grid takes to 2.5 s.
    const intro = output.plays("bus0/2");
    expect(intro).toHaveLength(1);
    const layerB = output.plays("bus0/1");
    expect(layerB[0].when - intro[0].when).toBeCloseTo(2.5, 6);
  });

  it("tells each run's end once, with the silence drawn, and not a stop", async () => {
    const { player, onRunEnd } = observedPlayer({
      output: new FakeOutput(),
      stems: new FakeStems(1),
      track: shortTrack(10),
      resumeAt: 0,
      reactToStart: NOTHING,
      reactToEnd: NOTHING,
    });
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(3000);
    player.stop(0.1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onRunEnd).not.toHaveBeenCalled();

    player.start(player.elapsed(), 0.1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(onRunEnd.mock.calls).toEqual([[5]]);
  });

  it("stays stopped when the owner stops it from the run's end", async () => {
    const output = new FakeOutput();
    const { player, onRunStart, onRunEnd } = observedPlayer({
      output,
      stems: new FakeStems(1),
      track: shortTrack(10),
      resumeAt: 0,
      reactToStart: NOTHING,
      reactToEnd: (ending) => {
        ending.stop(0.1);
      },
    });
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
    const playsBefore = output.allPlays().length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(output.allPlays()).toHaveLength(playsBefore);
    expect(onRunStart).toHaveBeenCalledTimes(1);
    expect(onRunEnd).toHaveBeenCalledTimes(1);

    // Stopped in its silence, it holds the top of the track and starts a new
    // run from there.
    expect(player.elapsed()).toBe(0);
    player.start(player.elapsed(), 0.1);
    expect(onRunStart).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(output.allPlays().length).toBeGreaterThan(playsBefore);
  });
});
