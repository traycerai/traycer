import { describe, expect, it } from "vitest";
import { TrackScheduler, type RandomSource } from "../scheduler";
import type {
  GroupedLayer,
  Layer,
  LayerProperties,
  Range,
  State,
  VariableTrack,
  WeightedRange,
} from "../variable-sound";

function mulberry32(seed: number): RandomSource {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Answers `draws` in order, then `fallback` for ever. */
function scripted(draws: readonly number[], fallback: number): RandomSource {
  let next = 0;
  return () => {
    const draw = next < draws.length ? draws[next] : fallback;
    next += 1;
    return draw;
  };
}

function properties(
  enabled: boolean | null,
  pauseBetweenRepetitions: Range | readonly WeightedRange[],
): LayerProperties {
  return {
    enabled,
    startPause: [0, 0],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions,
    playsPerRun: null,
  };
}

function pooledLayer(name: string): Layer {
  return {
    name,
    variants: 1,
    sublayers: 1,
    sublayerStartingOffset: null,
    pan: null,
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

function trackOf(
  layers: readonly Layer[],
  states: readonly State[],
): VariableTrack {
  return {
    name: "rules",
    title: "Rules",
    lengthSeconds: 100,
    alignmentSeconds: 0.5,
    layers,
    states,
    intro: null,
    outro: null,
    phases: [],
  };
}

function schedulerFor(
  track: VariableTrack,
  random: RandomSource,
): TrackScheduler {
  return new TrackScheduler({
    track,
    state: track.states[0],
    random,
    pauseMultiplier: 1,
  });
}

describe("TrackScheduler weighted pause", () => {
  // Rows [1, 2] (weight 1) and [10, 20] (weight 3) follow a row that is never
  // picked. The second draw lands mid-range (0.5), so a row gives 1.5 or 15.
  const TABLE: readonly WeightedRange[] = [
    { range: [100, 100], weight: 0 },
    { range: [1, 2], weight: 1 },
    { range: [10, 20], weight: 3 },
  ];

  // The first sample is 1 s long and starts at 0, so the next starts 1 s plus
  // the pause later. Draws before the pause: enabled count, layer shuffle, start
  // pause and sequence length, then the sequence length of the next turn; the
  // pause then takes the row pick and the draw within the row.
  it.each([
    { pick: 0, row: "the first row with weight", nextStart: 2.5 },
    { pick: 0.24, row: "the light row just below its share", nextStart: 2.5 },
    {
      pick: 0.26,
      row: "the heavy row just above the light share",
      nextStart: 16,
    },
  ])("picks $row for a draw of $pick", ({ pick, nextStart }) => {
    const track = trackOf(
      [pooledLayer("A")],
      [stateOf("only", [properties(null, TABLE)], 1)],
    );
    const scheduler = schedulerFor(
      track,
      scripted([0, 0, 0, 0, 0, pick, 0.5], 0.5),
    );
    const [first] = scheduler.advance(0);
    expect(scheduler.confirm(first, 1, 0)).toBe(0);

    expect(scheduler.advance(30).map((play) => play.startAt)).toEqual([
      nextStart,
    ]);
  });
});

describe("TrackScheduler grouped layer", () => {
  // EA1 holds variants 1 to 3 and EA2 variants 4 and 5.
  const EA1_VARIANTS = 3;
  const SEQUENCE = ["EA1", "EA1", "EA2"];
  const layer: GroupedLayer = {
    name: "G",
    groups: [
      { name: "EA1", variants: EA1_VARIANTS },
      { name: "EA2", variants: 2 },
    ],
    sequence: SEQUENCE,
    sublayers: 1,
    sublayerStartingOffset: null,
    pan: null,
  };

  it.each([1, 2, 3])(
    "takes the sequence's turns and never repeats a variant back to back in a group (seed %i)",
    (seed) => {
      const track = trackOf(
        [layer],
        [stateOf("only", [properties(null, [0, 0])], 1)],
      );
      const scheduler = schedulerFor(track, mulberry32(seed));
      const variants: number[] = [];
      const starts: number[] = [];
      let refused = 0;
      for (let until = 0; until <= 60; until += 0.5) {
        for (const play of scheduler.advance(until)) {
          const startAt = scheduler.confirm(play, 1, 0);
          if (startAt === null) {
            refused += 1;
            continue;
          }
          variants.push(play.variant);
          starts.push(startAt);
        }
      }

      // A draw the confirm refused would leave a hole in the 1 s cadence.
      expect(refused).toBe(0);
      expect(
        starts.slice(1).map((start, index) => start - starts[index]),
      ).toEqual(starts.slice(1).map(() => 1));

      const groupOf = (variant: number): string =>
        variant <= EA1_VARIANTS ? "EA1" : "EA2";
      expect(variants.length).toBeGreaterThan(30);
      expect(variants.map(groupOf)).toEqual(
        variants.map((_, turn) => SEQUENCE[turn % SEQUENCE.length]),
      );
      for (const group of ["EA1", "EA2"]) {
        const inGroup = variants.filter((v) => groupOf(v) === group);
        inGroup.slice(1).forEach((variant, index) => {
          expect(variant).not.toBe(inGroup[index]);
        });
      }
    },
  );
});

describe("TrackScheduler pinned layers", () => {
  it.each([
    {
      name: "fills the count from the layers left to the roll",
      pins: [true, false, null, null, null],
      count: 3,
      total: 3,
    },
    {
      name: "keeps every pinned-on layer when they exceed the count",
      pins: [true, true, false, null, null],
      count: 1,
      total: 2,
    },
    {
      name: "stops at the layers left to the roll when the count is larger",
      pins: [true, false, null, null, null],
      count: 5,
      total: 4,
    },
  ])("$name", ({ pins, count, total }) => {
    const track = trackOf(
      pins.map((_, index) => pooledLayer(`L${String(index)}`)),
      [
        stateOf(
          "only",
          pins.map((enabled) => properties(enabled, [4, 4])),
          count,
        ),
      ],
    );
    for (let seed = 1; seed <= 20; seed += 1) {
      const enabled = schedulerFor(track, mulberry32(seed)).enabledLayers();
      pins.forEach((pin, index) => {
        if (pin !== null) expect(enabled[index]).toBe(pin);
      });
      expect(enabled.filter((on) => on)).toHaveLength(total);
    }
  });
});

describe("TrackScheduler pause table", () => {
  it("refuses a table with no row that can be picked, at construction and on entering a state", () => {
    const table: readonly WeightedRange[] = [
      { range: [1, 2], weight: 0 },
      { range: [3, 4], weight: -1 },
    ];
    const good = stateOf("good", [properties(null, [1, 2])], 1);
    const bad = stateOf("bad", [properties(null, table)], 1);
    const track = trackOf([pooledLayer("A")], [good, bad]);

    expect(() => schedulerFor({ ...track, states: [bad] }, () => 0.5)).toThrow(
      "no row to pick",
    );
    expect(() => {
      schedulerFor(track, () => 0.5).enterState(bad, 0);
    }).toThrow("no row to pick");
  });
});

describe("TrackScheduler restart", () => {
  const grouped: GroupedLayer = {
    name: "G",
    groups: [
      { name: "X", variants: 1 },
      { name: "Y", variants: 1 },
    ],
    sequence: ["X", "Y"],
    sublayers: 1,
    sublayerStartingOffset: null,
    pan: null,
  };

  // The first play, X (variant 1), starts at 3 s. A restart before it takes it
  // back, as a stop cut it before it sounded; one after it keeps its turn.
  it.each([
    { restartAt: 1, nextVariant: 1 },
    { restartAt: 3.5, nextVariant: 2 },
  ])(
    "after a restart at $restartAt s the layer's next group turn is variant $nextVariant",
    ({ restartAt, nextVariant }) => {
      const state = stateOf(
        "only",
        [{ ...properties(null, [0, 0]), startPause: [3, 3] }],
        1,
      );
      const scheduler = schedulerFor(trackOf([grouped], [state]), () => 0.5);
      const [first] = scheduler.advance(3);
      expect(first.variant).toBe(1);
      expect(scheduler.confirm(first, 1, 0)).toBe(3);

      scheduler.restartAt(restartAt);
      expect(scheduler.advance(20).map((play) => play.variant)).toEqual([
        nextVariant,
      ]);
    },
  );
});
