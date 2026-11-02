import { describe, expect, it } from "vitest";
import {
  TrackScheduler,
  type RandomSource,
  type ScheduledPlay,
} from "../scheduler";
import {
  AQUILO_1,
  type Layer,
  type LayerProperties,
  type Range,
  type State,
  type VariableTrack,
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

const FIXED_ZERO: Range = [0, 0];

function singleSample(
  startPause: Range,
  pauseBetweenRepetitions: Range,
): LayerProperties {
  return {
    startPause,
    sequenceLength: [1, 1],
    pauseBetweenSamples: FIXED_ZERO,
    pauseBetweenRepetitions,
  };
}

function layer(
  variants: number,
  sublayers: number,
  offset: Range | null,
): Layer {
  return {
    name: `L${String(variants)}x${String(sublayers)}`,
    variants,
    sublayers,
    sublayerStartingOffset: offset,
  };
}

interface TrackShape {
  readonly lengthSeconds: number;
  readonly alignmentSeconds: number;
  readonly layers: readonly Layer[];
  readonly properties: readonly LayerProperties[];
  readonly enabledCount: Range;
}

function buildTrack(shape: TrackShape): VariableTrack {
  return {
    name: "test",
    title: "Test",
    lengthSeconds: shape.lengthSeconds,
    alignmentSeconds: shape.alignmentSeconds,
    layers: shape.layers,
    states: [
      {
        name: "only",
        layersProperties: shape.properties,
        numberOfEnabledLayers: shape.enabledCount,
      },
    ],
  };
}

function makeScheduler(
  track: VariableTrack,
  seed: number,
  pauseMultiplier: number,
): TrackScheduler {
  return new TrackScheduler({
    track,
    state: track.states[0],
    random: mulberry32(seed),
    pauseMultiplier,
  });
}

/** AQUILO_1 with every layer enabled, optionally on another grid. */
function allEnabledAquilo(alignmentSeconds: number): VariableTrack {
  return {
    ...AQUILO_1,
    alignmentSeconds,
    states: [{ ...AQUILO_1.states[0], numberOfEnabledLayers: [4, 4] }],
  };
}

interface Placed {
  readonly play: ScheduledPlay;
  readonly startAt: number;
}

/**
 * Asks for plays in half-second windows and reports each at once, as a player
 * with every stem ready would, so a sublayer decides its next play only after
 * the previous one is reported. Plays come back in decision order.
 */
function runToEnd(
  scheduler: TrackScheduler,
  track: VariableTrack,
  durationOf: (play: ScheduledPlay) => number,
): Placed[] {
  const placed: Placed[] = [];
  for (let until = 0; until <= track.lengthSeconds + 10; until += 0.5) {
    for (const play of scheduler.advance(until)) {
      const startAt = scheduler.confirm(play, durationOf(play), 0);
      if (startAt !== null) placed.push({ play, startAt });
    }
  }
  return placed;
}

function placedOf(
  placed: readonly Placed[],
  layerIndex: number,
  sublayerIndex: number,
) {
  return placed.filter(
    ({ play }) =>
      play.layerIndex === layerIndex && play.sublayerIndex === sublayerIndex,
  );
}

function isOnGrid(value: number, alignment: number): boolean {
  const ticks = value / alignment;
  return Math.abs(ticks - Math.round(ticks)) < 1e-6;
}

function stateOf(
  name: string,
  properties: LayerProperties,
  layerCount: number,
  enabledCount: Range,
): State {
  return {
    name,
    layersProperties: Array.from({ length: layerCount }, () => properties),
    numberOfEnabledLayers: enabledCount,
  };
}

function trackWithStates(
  layers: readonly Layer[],
  states: readonly State[],
): VariableTrack {
  return {
    name: "states",
    title: "States",
    lengthSeconds: 300,
    alignmentSeconds: 1,
    layers,
    states,
  };
}

/** Asks and reports in half-second windows from `from` to `to`, as `runToEnd` does. */
function runBetween(
  scheduler: TrackScheduler,
  from: number,
  to: number,
  durationSeconds: number,
): ScheduledPlay[] {
  const decided: ScheduledPlay[] = [];
  for (let until = from; until <= to; until += 0.5) {
    for (const play of scheduler.advance(until)) {
      decided.push(play);
      scheduler.confirm(play, durationSeconds, 0);
    }
  }
  return decided;
}

describe("TrackScheduler entering a state", () => {
  const sample = (pauseBetweenRepetitions: Range): LayerProperties =>
    singleSample([0, 0], pauseBetweenRepetitions);

  it("lands on the next undecided tick and waits a fresh start pause from there, or from the end of a sounding sample", () => {
    const track = trackWithStates(
      [layer(2, 1, null), layer(2, 1, null)],
      [
        stateOf("calm", sample([100, 100]), 2, [2, 2]),
        stateOf("busy", singleSample([3, 3], [2, 2]), 2, [2, 2]),
      ],
    );
    const [calm, busy] = track.states;
    const scheduler = makeScheduler(track, 1, 1);
    const [first, second] = scheduler.advance(10);
    scheduler.confirm(first, 50, 0);
    scheduler.confirm(second, 1, 0);
    expect(scheduler.advance(10)).toEqual([]);

    scheduler.enterState(busy, 10);

    expect(scheduler.stateAt(10)).toBe(calm);
    expect(scheduler.stateAt(11)).toBe(busy);
    // Not after the 100 s pause drawn in calm: busy's 3 s start pause from 11.
    expect(scheduler.advance(13)).toEqual([]);
    const [onLayer1] = scheduler.advance(14);
    expect(onLayer1.layerIndex).toBe(1);
    expect(onLayer1.startAt).toBe(14);
    expect(scheduler.confirm(onLayer1, 1, 0)).toBe(14);
    // 14 + 1 + busy's 2, not calm's 100.
    expect(scheduler.advance(16)).toEqual([]);
    const [again] = scheduler.advance(17);
    expect(again.startAt).toBe(17);
    // Layer 0's sample sounds until 50 and plays out, then the start pause.
    expect(scheduler.advance(52)).toEqual([]);
    const [onLayer0] = scheduler.advance(53);
    expect(onLayer0.layerIndex).toBe(0);
    expect(onLayer0.startAt).toBe(53);
  });

  it("keeps the first state in force until a second move lands, and still waits for a sounding sample", () => {
    const track = trackWithStates(
      [layer(2, 1, null)],
      [
        stateOf("a", sample([100, 100]), 1, [1, 1]),
        stateOf("b", singleSample([1, 1], [100, 100]), 1, [1, 1]),
        stateOf("c", singleSample([3, 3], [2, 2]), 1, [1, 1]),
      ],
    );
    const [a, b, c] = track.states;
    const scheduler = makeScheduler(track, 1, 1);
    const [play] = scheduler.advance(10);
    scheduler.confirm(play, 50, 0);

    scheduler.enterState(b, 10);
    scheduler.enterState(c, 10);

    expect(scheduler.stateAt(10)).toBe(a);
    expect(scheduler.stateAt(11)).toBe(c);
    expect(scheduler.advance(52)).toEqual([]);
    expect(scheduler.advance(53)[0].startAt).toBe(53);
  });

  it("throws on a state that does not fit the track, and changes nothing", () => {
    const scheduler = makeScheduler(AQUILO_1, 1, 1);
    const enabled = [...scheduler.enabledLayers()];
    const misfit = {
      ...AQUILO_1.states[0],
      name: "misfit",
      layersProperties: AQUILO_1.states[0].layersProperties.slice(0, 3),
    };

    expect(() => {
      scheduler.enterState(misfit, 5);
    }).toThrow("3 layer properties for 4 layers");
    expect(scheduler.stateAt(100)).toBe(AQUILO_1.states[0]);
    expect(scheduler.enabledLayers()).toEqual(enabled);
  });

  it("ends a move still on its way when the scheduler restarts", () => {
    const track = trackWithStates(
      [layer(2, 1, null)],
      [
        stateOf("calm", sample([100, 100]), 1, [1, 1]),
        stateOf("busy", sample([2, 2]), 1, [1, 1]),
      ],
    );
    const scheduler = makeScheduler(track, 1, 1);
    scheduler.advance(10);
    scheduler.enterState(track.states[1], 10);
    scheduler.restartAt(10);
    expect(scheduler.stateAt(10)).toBe(track.states[1]);
  });

  it("rolls the enabled layers at entry, and keeps a later override", () => {
    const track = trackWithStates(
      [layer(2, 1, null), layer(2, 1, null)],
      [
        stateOf("calm", sample([1, 1]), 2, [2, 2]),
        stateOf("busy", sample([1, 1]), 2, [1, 1]),
      ],
    );
    for (let seed = 1; seed <= 10; seed += 1) {
      const scheduler = makeScheduler(track, seed, 1);
      expect(scheduler.enabledLayers().filter(Boolean)).toHaveLength(2);
      scheduler.enterState(track.states[1], 0);
      expect(scheduler.enabledLayers().filter(Boolean)).toHaveLength(1);

      scheduler.setLayerEnabled(0, true);
      scheduler.setLayerEnabled(1, true);
      const decided = runBetween(scheduler, 1, 30, 1);
      expect(new Set(decided.map(({ layerIndex }) => layerIndex))).toEqual(
        new Set([0, 1]),
      );
      expect(scheduler.enabledLayers()).toEqual([true, true]);
    }
  });

  it("never repeats a variant across the move, for the layer or for a sublayer", () => {
    const properties = singleSample([0, 0], [0, 1]);
    const track = trackWithStates(
      [layer(3, 2, [0, 0])],
      [
        stateOf("calm", properties, 1, [1, 1]),
        stateOf("busy", properties, 1, [1, 1]),
      ],
    );
    for (let seed = 1; seed <= 30; seed += 1) {
      const scheduler = makeScheduler(track, seed, 1);
      const before = runBetween(scheduler, 0, 20, 1);
      scheduler.enterState(track.states[1], 20);
      const after = runBetween(scheduler, 20.5, 40, 1);

      expect(after[0].variant).not.toBe(before[before.length - 1].variant);
      for (const sublayerIndex of [0, 1]) {
        const lastBefore = before.filter(
          (play) => play.sublayerIndex === sublayerIndex,
        );
        const firstAfter = after.find(
          (play) => play.sublayerIndex === sublayerIndex,
        );
        expect(firstAfter?.variant).not.toBe(
          lastBefore[lastBefore.length - 1].variant,
        );
      }
    }
  });
});

describe("TrackScheduler", () => {
  describe("grid", () => {
    it.each([1, 0.1, 1.2])(
      "starts every sample on a multiple of %s s",
      (alignment) => {
        const track = allEnabledAquilo(alignment);
        for (let seed = 1; seed <= 5; seed += 1) {
          const placed = runToEnd(
            makeScheduler(track, seed, 1),
            track,
            () => 7.3,
          );
          expect(placed.length).toBeGreaterThan(10);
          for (const { play, startAt } of placed) {
            expect(isOnGrid(play.startAt, alignment)).toBe(true);
            expect(isOnGrid(startAt, alignment)).toBe(true);
          }
        }
      },
    );

    it("keeps a draw that already sits on a tick of a 1.2 s grid on that tick", () => {
      // 8.4 / 1.2 evaluates to 7.000000000000001, which a plain ceiling would
      // send to the eighth tick.
      const track = buildTrack({
        lengthSeconds: 100,
        alignmentSeconds: 1.2,
        layers: [layer(2, 1, null)],
        properties: [singleSample([8.4, 8.4], [5, 5])],
        enabledCount: [1, 1],
      });
      const [play] = makeScheduler(track, 1, 1).advance(20);
      expect(play.startAt).toBeCloseTo(8.4, 9);
    });
  });

  describe("variants", () => {
    it("never plays a layer's last variant again, and a sublayer never repeats itself with 3 or more variants", () => {
      const track = allEnabledAquilo(1);
      for (let seed = 1; seed <= 10; seed += 1) {
        const placed = runToEnd(makeScheduler(track, seed, 1), track, () => 3);
        track.layers.forEach((trackLayer, layerIndex) => {
          const ofLayer = placed.filter(
            ({ play }) => play.layerIndex === layerIndex,
          );
          for (let i = 1; i < ofLayer.length; i += 1) {
            if (trackLayer.variants > 1) {
              expect(ofLayer[i].play.variant).not.toBe(
                ofLayer[i - 1].play.variant,
              );
            }
          }
          if (trackLayer.variants >= 3) {
            for (let sub = 0; sub < trackLayer.sublayers; sub += 1) {
              const ofSublayer = placedOf(placed, layerIndex, sub);
              for (let i = 1; i < ofSublayer.length; i += 1) {
                expect(ofSublayer[i].play.variant).not.toBe(
                  ofSublayer[i - 1].play.variant,
                );
              }
            }
          }
        });
      }
    });

    it("repeats the only variant of a 1-variant layer", () => {
      const track = buildTrack({
        lengthSeconds: 100,
        alignmentSeconds: 1,
        layers: [layer(1, 1, null)],
        properties: [singleSample([0, 2], [1, 3])],
        enabledCount: [1, 1],
      });
      const placed = runToEnd(makeScheduler(track, 3, 1), track, () => 2);
      expect(placed.length).toBeGreaterThan(5);
      expect(new Set(placed.map(({ play }) => play.variant))).toEqual(
        new Set([1]),
      );
    });

    it("alternates a 2-variant layer across its 2 sublayers", () => {
      const track = buildTrack({
        lengthSeconds: 200,
        alignmentSeconds: 1,
        layers: [layer(2, 2, [0, 3])],
        properties: [singleSample([0, 2], [0, 2])],
        enabledCount: [1, 1],
      });
      for (let seed = 1; seed <= 5; seed += 1) {
        const placed = runToEnd(makeScheduler(track, seed, 1), track, () => 2);
        expect(placed.length).toBeGreaterThan(20);
        for (let i = 1; i < placed.length; i += 1) {
          expect(placed[i].play.variant).not.toBe(placed[i - 1].play.variant);
        }
      }
    });
  });

  describe("sequence structure", () => {
    // Durations are whole seconds on a 1 s grid, so a gap is duration plus the
    // draw, rounded up: 2 + [1, 2] gives 3 or 4, and 2 + [10, 12] gives 12 to
    // 14. The two pause kinds never overlap.
    const DURATION = 2;
    const track = buildTrack({
      lengthSeconds: 400,
      alignmentSeconds: 1,
      layers: [layer(4, 2, [20, 30])],
      properties: [
        {
          startPause: [5, 8],
          sequenceLength: [2, 3],
          pauseBetweenSamples: [1, 2],
          pauseBetweenRepetitions: [10, 12],
        },
      ],
      enabledCount: [1, 1],
    });

    it("spaces plays by duration plus the right pause and keeps sequences inside sequenceLength", () => {
      for (let seed = 1; seed <= 15; seed += 1) {
        const placed = runToEnd(
          makeScheduler(track, seed, 1),
          track,
          () => DURATION,
        );
        for (const sublayer of [0, 1]) {
          const starts = placedOf(placed, 0, sublayer).map(
            ({ startAt }) => startAt,
          );
          expect(starts.length).toBeGreaterThan(10);
          const sequences: number[] = [1];
          for (let i = 1; i < starts.length; i += 1) {
            const gap = starts[i] - starts[i - 1];
            if (gap >= 3 && gap <= 4) {
              sequences[sequences.length - 1] += 1;
            } else {
              expect(gap).toBeGreaterThanOrEqual(DURATION + 10);
              expect(gap).toBeLessThanOrEqual(DURATION + 12);
              sequences.push(1);
            }
          }
          // The last sequence may be cut off by the end of the track.
          for (const length of sequences.slice(0, -1)) {
            expect(length).toBeGreaterThanOrEqual(2);
            expect(length).toBeLessThanOrEqual(3);
          }
        }
      }
    });

    it("starts sublayer 0 within startPause and later sublayers a starting offset after it", () => {
      for (let seed = 1; seed <= 30; seed += 1) {
        const placed = runToEnd(
          makeScheduler(track, seed, 1),
          track,
          () => DURATION,
        );
        const [first] = placedOf(placed, 0, 0);
        const [second] = placedOf(placed, 0, 1);
        expect(first.startAt).toBeGreaterThanOrEqual(5);
        expect(first.startAt).toBeLessThanOrEqual(8);
        expect(second.startAt).toBeGreaterThanOrEqual(25);
        expect(second.startAt).toBeLessThanOrEqual(38);
      }
    });
  });

  describe("disabled layers", () => {
    const track = buildTrack({
      lengthSeconds: 300,
      alignmentSeconds: 1,
      layers: [layer(3, 1, null), layer(3, 1, null)],
      properties: [singleSample([0, 0], [0, 0]), singleSample([0, 0], [1, 1])],
      enabledCount: [2, 2],
    });

    it("schedules nothing for a disabled layer, and a re-enabled one lands on the next tick after the window", () => {
      const scheduler = makeScheduler(track, 1, 1);
      scheduler.setLayerEnabled(0, false);
      const seen: ScheduledPlay[] = [];
      for (let until = 0; until <= 100; until += 1) {
        for (const play of scheduler.advance(until)) {
          seen.push(play);
          scheduler.confirm(play, 1, 0);
        }
      }
      // The other layer kept playing, so the empty result is not an idle one.
      expect(seen.some(({ layerIndex }) => layerIndex === 1)).toBe(true);
      expect(seen.some(({ layerIndex }) => layerIndex === 0)).toBe(false);

      scheduler.advance(100.4);
      scheduler.setLayerEnabled(0, true);
      const fromLayer = scheduler
        .advance(105)
        .filter(({ layerIndex }) => layerIndex === 0);
      expect(fromLayer).toHaveLength(1);
      expect(fromLayer[0].startAt).toBe(101);
    });
  });

  describe("enabled layers", () => {
    it("rolls a count inside numberOfEnabledLayers from layers chosen at random", () => {
      const setsByCount = new Map<number, Set<string>>();
      for (let seed = 1; seed <= 200; seed += 1) {
        const enabled = makeScheduler(AQUILO_1, seed, 1).enabledLayers();
        const count = enabled.filter(Boolean).length;
        expect(count).toBeGreaterThanOrEqual(2);
        expect(count).toBeLessThanOrEqual(4);
        const sets = setsByCount.get(count) ?? new Set<string>();
        sets.add(enabled.join());
        setsByCount.set(count, sets);
      }
      expect(setsByCount.size).toBeGreaterThan(1);
      // Two enabled layers are not always the same two.
      expect(setsByCount.get(2)?.size).toBeGreaterThan(1);
    });

    it("keeps the caller's override while advancing", () => {
      const scheduler = makeScheduler(AQUILO_1, 7, 1);
      [true, false, false, false].forEach((enabled, layerIndex) => {
        scheduler.setLayerEnabled(layerIndex, enabled);
      });
      const placed = runToEnd(scheduler, AQUILO_1, () => 4);
      expect(placed.length).toBeGreaterThan(3);
      expect(new Set(placed.map(({ play }) => play.layerIndex))).toEqual(
        new Set([0]),
      );
      expect(scheduler.enabledLayers()).toEqual([true, false, false, false]);
    });
  });

  describe("pause multiplier", () => {
    const track = buildTrack({
      lengthSeconds: 1000,
      alignmentSeconds: 1,
      layers: [layer(4, 2, [20, 30])],
      properties: [
        {
          startPause: [4, 6],
          sequenceLength: [2, 2],
          pauseBetweenSamples: [2, 3],
          pauseBetweenRepetitions: [10, 12],
        },
      ],
      enabledCount: [1, 1],
    });

    it("scales the start pause and both sequence pauses but not the starting offset", () => {
      for (let seed = 1; seed <= 10; seed += 1) {
        const placed = runToEnd(makeScheduler(track, seed, 3), track, () => 1);
        const first = placedOf(placed, 0, 0);
        const second = placedOf(placed, 0, 1);
        expect(first[0].startAt).toBeGreaterThanOrEqual(12);
        expect(first[0].startAt).toBeLessThanOrEqual(18);
        // 3 x [4, 6] + [20, 30]: a scaled offset would put this beyond 70.
        expect(second[0].startAt).toBeGreaterThanOrEqual(32);
        expect(second[0].startAt).toBeLessThanOrEqual(48);
        // 1 s sample + 3 x [2, 3], then 1 s sample + 3 x [10, 12].
        expect(first[1].startAt - first[0].startAt).toBeGreaterThanOrEqual(7);
        expect(first[1].startAt - first[0].startAt).toBeLessThanOrEqual(10);
        expect(first[2].startAt - first[1].startAt).toBeGreaterThanOrEqual(31);
        expect(first[2].startAt - first[1].startAt).toBeLessThanOrEqual(37);
      }
    });

    it("applies setPauseMultiplier to later draws only", () => {
      for (let seed = 1; seed <= 10; seed += 1) {
        const scheduler = makeScheduler(track, seed, 1);
        scheduler.setPauseMultiplier(3);
        const first = placedOf(
          runToEnd(scheduler, track, () => 1),
          0,
          0,
        );
        // The start pause was drawn at construction, at multiplier 1.
        expect(first[0].startAt).toBeLessThanOrEqual(6);
        expect(first[1].startAt - first[0].startAt).toBeGreaterThanOrEqual(7);
      }
    });
  });

  describe("end of the track", () => {
    it("starts nothing at or after lengthSeconds", () => {
      const track = buildTrack({
        lengthSeconds: 20,
        alignmentSeconds: 1,
        layers: [layer(3, 1, null)],
        properties: [singleSample([0, 2], [0, 2])],
        enabledCount: [1, 1],
      });
      const scheduler = makeScheduler(track, 1, 1);
      const placed = runToEnd(scheduler, track, () => 1);
      expect(placed.length).toBeGreaterThan(3);
      for (const { play, startAt } of placed) {
        expect(play.startAt).toBeLessThan(20);
        expect(startAt).toBeLessThan(20);
      }
      expect(scheduler.advance(1000)).toEqual([]);
    });

    it("drops a draw that snaps onto lengthSeconds", () => {
      const track = buildTrack({
        lengthSeconds: 10,
        alignmentSeconds: 1,
        layers: [layer(3, 1, null)],
        properties: [singleSample([9.5, 9.5], [0, 0])],
        enabledCount: [1, 1],
      });
      expect(makeScheduler(track, 1, 1).advance(100)).toEqual([]);
    });
  });

  describe("reporting a play", () => {
    const track = buildTrack({
      lengthSeconds: 20,
      alignmentSeconds: 1,
      layers: [layer(3, 1, null)],
      properties: [
        {
          startPause: [2, 2],
          sequenceLength: [2, 2],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [10, 10],
        },
      ],
      enabledCount: [1, 1],
    });

    it("moves a late play to the next tick and spaces the following one from there", () => {
      const scheduler = makeScheduler(track, 1, 1);
      const [play] = scheduler.advance(2);
      expect(play.startAt).toBe(2);
      expect(scheduler.confirm(play, 1, 3.4)).toBe(4);
      // The second sample of the sequence follows the moved one at once.
      expect(scheduler.advance(5)[0].startAt).toBe(5);
    });

    it("answers null for a play moved to or past lengthSeconds, and plays nothing more", () => {
      const scheduler = makeScheduler(track, 1, 1);
      const [play] = scheduler.advance(2);
      expect(scheduler.confirm(play, 1, 19.5)).toBeNull();
      expect(scheduler.advance(1000)).toEqual([]);
    });

    it("counts a skip in its sequence and never puts two plays on one tick", () => {
      const scheduler = makeScheduler(track, 1, 1);
      const [skipped] = scheduler.advance(2);
      scheduler.skip(skipped);
      // No length and no pause between samples: the next tick, not the same.
      const [second] = scheduler.advance(3);
      expect(second.startAt).toBe(3);
      expect(scheduler.confirm(second, 1, 0)).toBe(3);
      // The skip was the sequence's first sample, so the repetition pause
      // follows the second: 3 + 1 + 10.
      expect(scheduler.advance(13)).toEqual([]);
      expect(scheduler.advance(14)[0].startAt).toBe(14);
    });

    it("decides nothing for a sublayer until its pending play is reported", () => {
      const scheduler = makeScheduler(track, 1, 1);
      const [play] = scheduler.advance(2);
      expect(scheduler.advance(1000)).toEqual([]);
      scheduler.confirm(play, 1, 0);
      expect(scheduler.advance(1000)).toHaveLength(1);
    });

    it("forgets pending plays on restartAt, so a late report changes nothing", () => {
      const scheduler = makeScheduler(track, 1, 1);
      const [stale] = scheduler.advance(2);
      scheduler.restartAt(10);
      expect(scheduler.confirm(stale, 1, 0)).toBeNull();
      const [fresh] = scheduler.advance(12);
      expect(fresh.startAt).toBe(12);
      scheduler.skip(stale);
      expect(scheduler.confirm(stale, 1, 0)).toBeNull();
      // The fresh play is still pending: the stale reports claimed nothing.
      expect(scheduler.advance(1000)).toEqual([]);
    });
  });

  it("throws on a state whose layersProperties length differs from the track's layers", () => {
    const state = {
      ...AQUILO_1.states[0],
      layersProperties: AQUILO_1.states[0].layersProperties.slice(0, 3),
    };
    expect(
      () =>
        new TrackScheduler({
          track: AQUILO_1,
          state,
          random: mulberry32(1),
          pauseMultiplier: 1,
        }),
    ).toThrow("3 layer properties for 4 layers");
  });
});
