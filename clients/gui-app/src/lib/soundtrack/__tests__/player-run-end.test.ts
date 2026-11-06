import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { appLogger } from "@/lib/logger";
import { MIX_TUNING } from "../mix-tuning";
import { TrackPlayer } from "../player";
import type { StemSource } from "../stems";
import type {
  Bookend,
  Layer,
  LayerProperties,
  State,
  VariableTrack,
} from "../variable-sound";
import { makeAudioBuffer } from "./audio-buffer";
import { FakeOutput } from "./fakes";

// A run's track time t sounds at clock START_LEAD + t.
const START_LEAD_SECONDS = 0.05;
const TICK_SECONDS = 0.12;
const LENGTH_SECONDS = 10;

function properties(
  startPause: number,
  pauseBetweenRepetitions: number,
): LayerProperties {
  return {
    enabled: null,
    startPause: [startPause, startPause],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions: [pauseBetweenRepetitions, pauseBetweenRepetitions],
    playsPerRun: null,
  };
}

function layerOf(name: string): Layer {
  return {
    name,
    variants: 1,
    role: null,
    sublayers: 1,
    sublayerStartingOffset: null,
    pan: null,
  };
}

function stateOf(layersProperties: readonly LayerProperties[]): State {
  return {
    name: "only",
    layersProperties,
    numberOfEnabledLayers: [layersProperties.length, layersProperties.length],
  };
}

/** Layers named A, B, ... each starting at 3 s and repeating with no pause. */
function buildTrack(layerCount: number, outro: Bookend | null): VariableTrack {
  const names = ["A", "B"].slice(0, layerCount);
  return {
    name: "run-end",
    title: "Run end",
    lengthSeconds: LENGTH_SECONDS,
    alignmentSeconds: 0.5,
    layers: names.map(layerOf),
    states: [stateOf(names.map(() => properties(3, 0)))],
    intro: null,
    outro,
    phases: [],
  };
}

const OUTRO: Bookend = { name: "O", variants: 1, pan: null };

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

interface ObservedPlayer {
  readonly player: TrackPlayer;
  readonly onRunEnd: Mock<(silenceSeconds: number) => void>;
}

function observedPlayer(
  output: FakeOutput,
  stems: StemSource,
  track: VariableTrack,
): ObservedPlayer {
  const onRunEnd = vi.fn<(silenceSeconds: number) => void>();
  const player = new TrackPlayer({
    track,
    output,
    stems,
    random: () => 0,
    silenceSeconds: [5, 5],
    resumeAt: 0,
    onRunStart: () => undefined,
    onRunEnd,
  });
  return { player, onRunEnd };
}

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

describe("TrackPlayer ring-out of a track without an outro", () => {
  it("places nothing at the length, lets the sounding sample play out, and ends the run within a tick of its end", async () => {
    const output = new FakeOutput();
    // Plays at 3 and 9 s; the second sounds until 15 s. A third would be due
    // at 15 s, past the length.
    const { player, onRunEnd } = observedPlayer(
      output,
      stemsOfLength(new Map([["A", 6]])),
      buildTrack(1, null),
    );
    player.start(0, 0.1);

    await advance(14.9);
    expect(
      output.plays("bus0/0").map((play) => play.when - START_LEAD_SECONDS),
    ).toEqual([3, 9]);
    expect(output.cuts()).toEqual([]);
    expect(onRunEnd).not.toHaveBeenCalled();

    await advance(0.4);
    expect(onRunEnd.mock.calls).toEqual([[5]]);
    expect(output.cuts()).toEqual([]);
    expect(player.currentState()).toBeNull();
  });

  it("cuts a sample that outlasts the cap over the ring-out fade, and ends the run then and not before", async () => {
    const output = new FakeOutput();
    // The one sample plays from 3 s for 60 s.
    const { player, onRunEnd } = observedPlayer(
      output,
      stemsOfLength(new Map([["A", 60]])),
      buildTrack(1, null),
    );
    player.start(0, 0.1);

    const capAt = LENGTH_SECONDS + MIX_TUNING.ringOutCapSeconds;
    await advance(capAt - 0.5);
    expect(output.cuts()).toEqual([]);
    expect(onRunEnd).not.toHaveBeenCalled();

    await advance(1);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
    const cuts = output.cuts();
    expect(cuts.map((cut) => ({ gain: cut.gain, fade: cut.fade }))).toEqual([
      { gain: "bus0/0", fade: MIX_TUNING.ringOutFadeSeconds },
    ]);
    expect(cuts[0].at).toBeGreaterThanOrEqual(capAt);
    expect(cuts[0].at).toBeLessThanOrEqual(capAt + 2 * TICK_SECONDS);
  });

  it("ends the run with the last sample on an enabled layer, not the one on a layer switched off", async () => {
    const output = new FakeOutput();
    // A plays at 3 and 9 s and sounds until 15 s; B plays at 3 s for 30 s.
    const { player, onRunEnd } = observedPlayer(
      output,
      stemsOfLength(
        new Map([
          ["A", 6],
          ["B", 30],
        ]),
      ),
      buildTrack(2, null),
    );
    player.start(0, 0.1);
    await advance(5);
    player.setLayerEnabled(1, false);

    await advance(9.9);
    expect(onRunEnd).not.toHaveBeenCalled();
    expect(output.cuts()).toEqual([]);

    await advance(0.4);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
    expect(
      output.cuts().map((cut) => ({ gain: cut.gain, fade: cut.fade })),
    ).toEqual([{ gain: "bus0/1", fade: MIX_TUNING.ringOutFadeSeconds }]);
  });

  it("cuts a sounding sample over the stop's fade and then does nothing at all", async () => {
    const output = new FakeOutput();
    const { player, onRunEnd } = observedPlayer(
      output,
      stemsOfLength(new Map([["A", 60]])),
      buildTrack(1, null),
    );
    player.start(0, 0.1);
    await advance(20);
    expect(onRunEnd).not.toHaveBeenCalled();

    player.stop(1.5);
    expect(
      output.cuts().map((cut) => ({ gain: cut.gain, fade: cut.fade })),
    ).toEqual([{ gain: "bus0/0", fade: 1.5 }]);
    const callsAtStop = output.calls.length;

    await advance(60);
    expect(onRunEnd).not.toHaveBeenCalled();
    expect(output.calls).toHaveLength(callsAtStop);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TrackPlayer outro", () => {
  // Layers play at 3 and 9 s for 6 s; the 3 s outro goes down at 10 s and
  // ends at 13 s.
  const stems = stemsOfLength(
    new Map([
      ["A", 6],
      ["B", 6],
      ["O", 3],
    ]),
  );

  it("fades every layer to 0 by the outro's end, ends the run with it, and fades what still sounds", async () => {
    const output = new FakeOutput();
    const { player, onRunEnd } = observedPlayer(
      output,
      stems,
      buildTrack(2, OUTRO),
    );
    player.start(0, 0.1);
    await advance(12.9);

    const outro = output.plays("bus0/2");
    expect(outro).toHaveLength(1);
    const outroEnd = outro[0].when + outro[0].duration;
    for (const gain of ["bus0/0", "bus0/1"]) {
      const fade = output.ramps(gain).filter((ramp) => ramp.target === 0);
      expect(fade).toHaveLength(1);
      expect(fade[0].at + fade[0].seconds).toBeCloseTo(outroEnd, 6);
    }
    expect(output.cuts()).toEqual([]);
    expect(onRunEnd).not.toHaveBeenCalled();

    await advance(0.4);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
    expect(
      output
        .cuts()
        .map((cut) => ({ gain: cut.gain, fade: cut.fade }))
        .toSorted((a, b) => a.gain.localeCompare(b.gain)),
    ).toEqual([
      { gain: "bus0/0", fade: MIX_TUNING.outroRingOutSeconds },
      { gain: "bus0/1", fade: MIX_TUNING.outroRingOutSeconds },
    ]);
    expect(player.currentState()).toBeNull();
  });

  it("adds no ramp to the layers for a target or a switch set during the fade, and ramps them back to their targets when the next run starts", async () => {
    const output = new FakeOutput();
    const { player } = observedPlayer(output, stems, buildTrack(2, OUTRO));
    player.start(0, 0.1);
    await advance(11);
    const rampsBefore = ["bus0/0", "bus0/1"].map(
      (gain) => output.ramps(gain).length,
    );

    player.setLayerTarget(0, 0.5);
    player.setLayerEnabled(1, false);
    expect(
      ["bus0/0", "bus0/1"].map((gain) => output.ramps(gain).length),
    ).toEqual(rampsBefore);

    // The run ends at 13.05 s and the silence lasts 5 s.
    await advance(9);
    expect(output.ramps("bus0/0").at(-1)).toMatchObject({
      target: 0.5,
      seconds: 0.01,
    });
    expect(output.ramps("bus0/1").at(-1)).toMatchObject({
      target: 1,
      seconds: 0.01,
    });
    expect(output.ramps("bus0/0").at(-1)?.at).toBeGreaterThan(18);
  });

  it("waits for an outro that loads after the length, with no layer sample left sounding, and ends the run with it", async () => {
    const output = new FakeOutput();
    const outro = Promise.withResolvers<AudioBuffer>();
    const stems: StemSource = {
      load: (_track, layer) =>
        layer.name === "O"
          ? outro.promise
          : Promise.resolve(makeAudioBuffer(2, 10)),
    };
    // The one 2 s sample plays at 3 s and is over by 5 s; no repeat falls
    // before the length.
    const track: VariableTrack = {
      ...buildTrack(1, OUTRO),
      states: [stateOf([properties(3, 20)])],
    };
    const { player, onRunEnd } = observedPlayer(output, stems, track);
    player.start(0, 0.1);

    await advance(12);
    expect(output.plays("bus0/0")).toHaveLength(1);
    expect(output.plays("bus0/1")).toEqual([]);
    expect(onRunEnd).not.toHaveBeenCalled();
    expect(player.currentState()).not.toBeNull();

    const releasedAt = output.currentTime();
    outro.resolve(makeAudioBuffer(3, 10));
    await advance(1);
    const played = output.plays("bus0/1");
    expect(played).toHaveLength(1);
    // On the next 0.5 s grid tick that has not gone by.
    expect(played[0].when).toBeGreaterThanOrEqual(releasedAt);
    expect(played[0].when).toBeLessThan(releasedAt + 0.5 + TICK_SECONDS);
    expect(onRunEnd).not.toHaveBeenCalled();

    const outroEnd = played[0].when + played[0].duration;
    await advance(outroEnd - output.currentTime() + TICK_SECONDS + 0.01);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
    expect(player.currentState()).toBeNull();
  });

  it("rings out like a track without one when the outro will not load", async () => {
    vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
    const output = new FakeOutput();
    const { player, onRunEnd } = observedPlayer(
      output,
      stemsOfLength(new Map([["A", 6]])),
      buildTrack(1, OUTRO),
    );
    player.start(0, 0.1);

    // The length passes at 10 s with the second sample sounding until 15 s.
    await advance(14.9);
    expect(onRunEnd).not.toHaveBeenCalled();
    expect(output.cuts()).toEqual([]);
    expect(output.ramps("bus0/0").filter((ramp) => ramp.target === 0)).toEqual(
      [],
    );

    await advance(0.4);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
    expect(output.cuts()).toEqual([]);
    expect(player.currentState()).toBeNull();
  });
});
