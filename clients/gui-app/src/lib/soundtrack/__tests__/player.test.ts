import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import type { OutputGain, OutputVoice, SoundtrackOutput } from "../output";
import { crossfadePlayers, TrackPlayer } from "../player";
import type { StemSource } from "../stems";
import type { Layer, LayerProperties, VariableTrack } from "../variable-sound";
import { makeAudioBuffer } from "./audio-buffer";

interface PlayCall {
  readonly kind: "play";
  readonly gain: string;
  readonly duration: number;
  readonly when: number;
  readonly fadeIn: number;
  readonly at: number;
}
interface CutCall {
  readonly kind: "cut";
  readonly gain: string;
  readonly fade: number;
  readonly at: number;
}
interface RampCall {
  readonly kind: "ramp";
  readonly gain: string;
  readonly target: number;
  readonly seconds: number;
  readonly at: number;
}
type PortCall = PlayCall | CutCall | RampCall;

function isPlay(call: PortCall): call is PlayCall {
  return call.kind === "play";
}
function isCut(call: PortCall): call is CutCall {
  return call.kind === "cut";
}
function isRamp(call: PortCall): call is RampCall {
  return call.kind === "ramp";
}

/** A port whose clock is the fake timers' clock, so ticks and time agree. */
class FakeOutput implements SoundtrackOutput {
  readonly calls: PortCall[] = [];
  private readonly base = Date.now();
  private buses = 0;

  currentTime(): number {
    return (Date.now() - this.base) / 1000;
  }

  createBus(): OutputGain {
    const name = `bus${String(this.buses)}`;
    this.buses += 1;
    return new FakeGain(name, this);
  }

  plays(gain: string): PlayCall[] {
    return this.calls.filter(isPlay).filter((call) => call.gain === gain);
  }
  allPlays(): PlayCall[] {
    return this.calls.filter(isPlay);
  }
  cuts(): CutCall[] {
    return this.calls.filter(isCut);
  }
  ramps(gain: string): RampCall[] {
    return this.calls.filter(isRamp).filter((call) => call.gain === gain);
  }
}

class FakeGain implements OutputGain {
  private readonly name: string;
  private readonly output: FakeOutput;
  private children = 0;

  constructor(name: string, output: FakeOutput) {
    this.name = name;
    this.output = output;
  }

  ramp(target: number, seconds: number): void {
    this.output.calls.push({
      kind: "ramp",
      gain: this.name,
      target,
      seconds,
      at: this.output.currentTime(),
    });
  }

  createChild(): OutputGain {
    const child = new FakeGain(
      `${this.name}/${String(this.children)}`,
      this.output,
    );
    this.children += 1;
    return child;
  }

  play(buffer: AudioBuffer, when: number, fadeInSeconds: number): OutputVoice {
    this.output.calls.push({
      kind: "play",
      gain: this.name,
      duration: buffer.duration,
      when,
      fadeIn: fadeInSeconds,
      at: this.output.currentTime(),
    });
    return {
      cut: (fadeSeconds) => {
        this.output.calls.push({
          kind: "cut",
          gain: this.name,
          fade: fadeSeconds,
          at: this.output.currentTime(),
        });
      },
    };
  }
}

/** Every sample is `durationSeconds` long; a layer can fail or be held back. */
class FakeStems implements StemSource {
  readonly requests: string[] = [];
  private readonly buffer: AudioBuffer;
  private readonly failing = new Set<string>();
  private readonly held = new Map<string, (() => void)[]>();

  constructor(durationSeconds: number) {
    this.buffer = makeAudioBuffer(durationSeconds, 10);
  }

  failLayer(layerName: string): void {
    this.failing.add(layerName);
  }

  holdLayer(layerName: string): void {
    this.held.set(layerName, []);
  }

  releaseLayer(layerName: string): void {
    for (const release of this.held.get(layerName) ?? []) release();
    this.held.delete(layerName);
  }

  load(
    _track: VariableTrack,
    layer: Layer,
    variant: number,
  ): Promise<AudioBuffer> {
    this.requests.push(`${layer.name}/${String(variant)}`);
    if (this.failing.has(layer.name)) {
      return Promise.reject(new Error("no such stem"));
    }
    const waiting = this.held.get(layer.name);
    if (waiting !== undefined) {
      return new Promise((resolve) => {
        waiting.push(() => {
          resolve(this.buffer);
        });
      });
    }
    return Promise.resolve(this.buffer);
  }
}

// Layer A starts at track time 0 and layer B at 0.2 s (0.5 s on the grid).
// Each plays one sample, then waits 4 s: with 2.2 s samples they come round
// every 6.2 s, which the 0.5 s grid snaps to 6.5.
function makeTrack(lengthSeconds: number, variantsOfA: number): VariableTrack {
  const properties = (startPause: number) => ({
    startPause: [startPause, startPause] as const,
    sequenceLength: [1, 1] as const,
    pauseBetweenSamples: [0, 0] as const,
    pauseBetweenRepetitions: [4, 4] as const,
  });
  return {
    name: "test",
    title: "Test",
    lengthSeconds,
    alignmentSeconds: 0.5,
    layers: [
      {
        name: "A",
        variants: variantsOfA,
        sublayers: 1,
        sublayerStartingOffset: null,
      },
      { name: "B", variants: 2, sublayers: 1, sublayerStartingOffset: null },
    ],
    states: [
      {
        name: "only",
        layersProperties: [properties(0), properties(0.2)],
        numberOfEnabledLayers: [2, 2],
      },
    ],
  };
}

// Two layers and two states. In "first" both layers play at once and come
// round every 6.2 s; "second" enables one layer only, which waits 1 s to start
// and 20 s between turns.
function makeStatesTrack(lengthSeconds: number): VariableTrack {
  const properties = (
    startPause: number,
    pauseBetweenRepetitions: number,
  ): LayerProperties => ({
    startPause: [startPause, startPause],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions: [pauseBetweenRepetitions, pauseBetweenRepetitions],
  });
  return {
    name: "states",
    title: "States",
    lengthSeconds,
    alignmentSeconds: 0.5,
    layers: [
      { name: "A", variants: 2, sublayers: 1, sublayerStartingOffset: null },
      { name: "B", variants: 2, sublayers: 1, sublayerStartingOffset: null },
    ],
    states: [
      {
        name: "first",
        layersProperties: [properties(0, 4), properties(0.2, 4)],
        numberOfEnabledLayers: [2, 2],
      },
      {
        name: "second",
        layersProperties: [properties(1, 20), properties(1, 20)],
        numberOfEnabledLayers: [1, 1],
      },
    ],
  };
}

const SAMPLE_SECONDS = 2.2;
const INTERVAL_SECONDS = 0.12;
const HORIZON_SECONDS = 0.6;

function makePlayerWithRandom(
  output: FakeOutput,
  stems: StemSource,
  track: VariableTrack,
  random: () => number,
): TrackPlayer {
  return new TrackPlayer({
    track,
    output,
    stems,
    random,
    silenceSeconds: [5, 5],
  });
}

function makePlayer(
  output: FakeOutput,
  stems: StemSource,
  track: VariableTrack,
  silenceSeconds: number,
): TrackPlayer {
  return new TrackPlayer({
    track,
    output,
    stems,
    random: () => 0.5,
    silenceSeconds: [silenceSeconds, silenceSeconds],
  });
}

// One layer on the 0.5 s grid whose first sample waits `startPause`, then
// repeats every 2.2 s sample + 4 s; one state per name.
function makeSingleLayerTrack(
  startPause: number,
  stateNames: readonly string[],
): VariableTrack {
  return {
    name: "single",
    title: "Single",
    lengthSeconds: 60,
    alignmentSeconds: 0.5,
    layers: [
      { name: "A", variants: 2, sublayers: 1, sublayerStartingOffset: null },
    ],
    states: stateNames.map((name) => ({
      name,
      layersProperties: [
        {
          startPause: [startPause, startPause],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [4, 4],
        },
      ],
      numberOfEnabledLayers: [1, 1],
    })),
  };
}

function isOnGrid(value: number, alignment: number): boolean {
  const ticks = value / alignment;
  return Math.abs(ticks - Math.round(ticks)) < 1e-6;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TrackPlayer scheduling", () => {
  it("hands a play to the port within 0.6 s of its start, on the 120 ms interval", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeTrack(60, 2),
      5,
    );
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(30_000);

    const plays = output.allPlays();
    expect(plays.length).toBeGreaterThan(6);
    for (const play of plays) {
      expect(isOnGrid(play.at, INTERVAL_SECONDS)).toBe(true);
      expect(play.when - play.at).toBeLessThanOrEqual(HORIZON_SECONDS + 1e-6);
      expect(play.when).toBeGreaterThanOrEqual(play.at);
    }
    // Past the first tick, a play waits for its horizon: no more than one
    // interval early.
    for (const play of plays.filter((call) => call.when > HORIZON_SECONDS)) {
      expect(play.when - play.at).toBeGreaterThan(
        HORIZON_SECONDS - INTERVAL_SECONDS - 1e-6,
      );
    }
  });

  it("fades every play in over 10 ms, on the track's grid", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeTrack(60, 2),
      5,
    );
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(30_000);

    const plays = output.allPlays();
    // Layer A's first play is at track time 0, which anchors the grid.
    const origin = plays.filter((call) => call.gain === "bus0/0")[0].when;
    expect(plays.length).toBeGreaterThan(6);
    for (const play of plays) {
      expect(play.fadeIn).toBe(0.01);
      expect(isOnGrid(play.when - origin, 0.5)).toBe(true);
    }
  });

  it.each([
    { requested: 0, applied: 0.01 },
    { requested: 0.4, applied: 0.4 },
  ])(
    "stop($requested) cuts every voice over $applied s",
    async ({ requested, applied }) => {
      const output = new FakeOutput();
      const player = makePlayer(
        output,
        new FakeStems(SAMPLE_SECONDS),
        makeTrack(60, 2),
        5,
      );
      player.start(0, 0.1);
      await vi.advanceTimersByTimeAsync(1000);
      player.stop(requested);

      const cuts = output.cuts();
      expect(cuts.map((call) => call.gain).sort()).toEqual([
        "bus0/0",
        "bus0/1",
      ]);
      for (const cut of cuts) expect(cut.fade).toBe(applied);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("takes the very first tick at start for a sample due at track time 0", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeTrack(60, 2),
      5,
    );
    const startedAt = output.currentTime();
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1000);

    const [firstA] = output.plays("bus0/0");
    expect(firstA.when - startedAt).toBeLessThan(0.5);
  });

  it.each([
    { random: 0, state: "first" },
    { random: 0.75, state: "second" },
  ])(
    "rolls the state from the random source ($state of two)",
    ({ random, state }) => {
      const output = new FakeOutput();
      const player = makePlayerWithRandom(
        output,
        new FakeStems(SAMPLE_SECONDS),
        makeSingleLayerTrack(0, ["first", "second"]),
        () => random,
      );
      player.start(0, 0.1);
      expect(player.currentState()?.name).toBe(state);
    },
  );

  it("does not cut samples that have already ended", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeSingleLayerTrack(5, ["only"]),
      5,
    );
    player.start(0, 0.1);
    // The one sample sounds from 5 s to 7.2 s; the next is not due until 11.5.
    await vi.advanceTimersByTimeAsync(9000);
    expect(output.allPlays()).toHaveLength(1);
    player.stop(0.1);
    expect(output.cuts()).toEqual([]);
  });

  it("scales the start pause by the multiplier set before start, and the next gap by one set while running", async () => {
    async function playTimes(multiplier: number, laterMultiplier: number) {
      const output = new FakeOutput();
      const player = makePlayer(
        output,
        new FakeStems(SAMPLE_SECONDS),
        makeSingleLayerTrack(5, ["only"]),
        5,
      );
      player.setPauseMultiplier(multiplier);
      player.start(0, 0.1);
      await vi.advanceTimersByTimeAsync(1000);
      player.setPauseMultiplier(laterMultiplier);
      await vi.advanceTimersByTimeAsync(25_000);
      return output.allPlays().map((call) => call.when);
    }

    const [plain] = await playTimes(1, 1);
    const [scaled, afterScaled] = await playTimes(2, 1);
    // 5 s becomes 10 s.
    expect(scaled - plain).toBeCloseTo(5, 6);
    // The gap drawn once the multiplier was back at 1: 2.2 + 4 s, snapped up.
    expect(afterScaled - scaled).toBeCloseTo(6.5, 6);
  });
});

describe("TrackPlayer resume", () => {
  it("holds the position while stopped and continues from it with the same state and enabled layers", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeTrack(60, 2),
      5,
    );
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(3000);
    player.setLayerEnabled(1, false);
    const state = player.currentState();
    const before = player.elapsed();
    expect(before).toBeGreaterThan(2);

    player.stop(0.1);
    expect(player.elapsed()).toBe(before);
    await vi.advanceTimersByTimeAsync(5000);
    expect(player.elapsed()).toBe(before);

    const restartedAt = output.currentTime();
    const playsBefore = output.allPlays().length;
    player.start(player.elapsed(), 0.1);
    expect(player.elapsed()).toBeGreaterThanOrEqual(before);
    expect(player.currentState()).toBe(state);
    expect(player.enabledLayers()).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(player.elapsed()).toBeGreaterThan(before + 1.5);
    expect(player.elapsed()).toBeLessThanOrEqual(before + 2);
    // Layer A resumes on the first tick at or after the remembered position,
    // not from track time 0 (nor after another start pause).
    const resumed = output.allPlays().slice(playsBefore)[0];
    expect(resumed.gain).toBe("bus0/0");
    expect(resumed.when - restartedAt).toBeLessThanOrEqual(0.6);
  });

  it("waits a fresh start pause from the remembered position", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeSingleLayerTrack(5, ["only"]),
      5,
    );
    const startedAt = output.currentTime();
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(8000);
    // The first sample sits at track time 5, which gives the start lead.
    const [first] = output.allPlays();
    const lead = first.when - 5 - startedAt;
    player.stop(0.1);
    const position = player.elapsed();

    const resumedAt = output.currentTime();
    player.start(position, 0.1);
    await vi.advanceTimersByTimeAsync(8000);
    const [resumed] = output.allPlays().slice(1);
    const trackTime = resumed.when - (resumedAt - position + lead);
    expect(trackTime).toBeCloseTo(Math.ceil((position + 5) / 0.5) * 0.5, 6);
  });
});

describe("TrackPlayer end of track", () => {
  it("cuts at the end, stays silent for silenceSeconds, then starts a fresh state at track time 0", async () => {
    const output = new FakeOutput();
    // 8 s samples are still sounding when the 5 s track ends.
    const player = makePlayer(output, new FakeStems(8), makeTrack(5, 2), 3);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1000);
    player.setLayerEnabled(1, false);
    expect(player.currentState()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(4500);

    const cuts = output.cuts();
    expect(cuts.map((call) => call.gain).sort()).toEqual(["bus0/0", "bus0/1"]);
    for (const cut of cuts) expect(cut.fade).toBe(0.01);
    expect(player.currentState()).toBeNull();
    expect(player.elapsed()).toBe(0);

    const endedAt = cuts[0].at;
    const playsAtEnd = output.allPlays().length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(output.allPlays()).toHaveLength(playsAtEnd);
    expect(player.currentState()).toBeNull();
    expect(player.elapsed()).toBe(0);

    await vi.advanceTimersByTimeAsync(3000);
    const fresh = output.allPlays().slice(playsAtEnd);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0].at).toBeGreaterThanOrEqual(endedAt + 3);
    expect(fresh[0].at).toBeLessThanOrEqual(
      endedAt + 3 + INTERVAL_SECONDS + 1e-6,
    );
    expect(player.currentState()).not.toBeNull();
    // Rolled afresh: the override made before the end is gone.
    expect(player.enabledLayers()).toEqual([true, true]);
    // Track time counts from the fresh start, not from the first play.
    expect(player.elapsed()).toBeLessThanOrEqual(
      output.currentTime() - fresh[0].at,
    );
  });
});

describe("crossfadePlayers", () => {
  function twoPlayers() {
    const output = new FakeOutput();
    const stems = new FakeStems(SAMPLE_SECONDS);
    const track = makeTrack(60, 2);
    return {
      output,
      from: makePlayer(output, stems, track, 5),
      to: makePlayer(output, stems, track, 5),
    };
  }

  it("fades `from` to 0 over 2 s then stops it where it was, and starts `to` from its remembered position with its bus rising over 2 s", async () => {
    const { output, from, to } = twoPlayers();
    from.start(0, 0.1);
    to.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(2000);
    to.stop(0.01);
    const remembered = to.elapsed();
    await vi.advanceTimersByTimeAsync(1000);

    const startedAt = output.currentTime();
    crossfadePlayers(from, to);
    expect(output.ramps("bus0").at(-1)).toMatchObject({
      target: 0,
      seconds: 2,
    });
    expect(output.ramps("bus1").at(-1)).toMatchObject({
      target: 1,
      seconds: 2,
    });
    expect(to.elapsed()).toBeGreaterThanOrEqual(remembered);
    expect(to.elapsed()).toBeLessThan(remembered + 0.2);

    await vi.advanceTimersByTimeAsync(1900);
    expect(output.ramps("bus0").at(-1)?.seconds).toBe(2);
    await vi.advanceTimersByTimeAsync(400);
    const stopRamp = output.ramps("bus0").at(-1);
    expect(stopRamp).toMatchObject({ target: 0, seconds: 0.01 });
    expect(stopRamp?.at).toBeGreaterThanOrEqual(startedAt + 2);
    expect(stopRamp?.at).toBeLessThanOrEqual(
      startedAt + 2 + INTERVAL_SECONDS + 1e-6,
    );

    const held = from.elapsed();
    const playsOnFrom = output.plays("bus0/0").length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(from.elapsed()).toBe(held);
    expect(output.plays("bus0/0")).toHaveLength(playsOnFrom);
    expect(to.elapsed()).toBeGreaterThan(remembered + 10);
  });

  it("cancels the pending stop when the crossfade is reversed midway", async () => {
    const { output, from, to } = twoPlayers();
    from.start(0, 0.1);
    to.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(3000);

    crossfadePlayers(from, to);
    await vi.advanceTimersByTimeAsync(1000);
    crossfadePlayers(to, from);
    expect(output.ramps("bus0").at(-1)).toMatchObject({
      target: 1,
      seconds: 2,
    });
    expect(output.ramps("bus1").at(-1)).toMatchObject({
      target: 0,
      seconds: 2,
    });

    // Past the first fade's end (2 s after it began) and the second's.
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      output
        .ramps("bus0")
        .every((ramp) => ramp.seconds !== 0.01 || ramp.target !== 0),
    ).toBe(true);
    const heldTo = to.elapsed();
    const fromBefore = from.elapsed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(from.elapsed()).toBeGreaterThan(fromBefore + 1.5);
    expect(to.elapsed()).toBe(heldTo);
  });
});

describe("TrackPlayer layer gains", () => {
  it("ramps a layer over 1.5 s to 0 when disabled and to its target when enabled", () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeTrack(60, 2),
      5,
    );
    player.start(0, 0.1);
    player.setLayerTarget(1, 0.6);
    expect(output.ramps("bus0/1").at(-1)).toMatchObject({
      target: 0.6,
      seconds: 1.5,
    });

    player.setLayerEnabled(1, false);
    expect(output.ramps("bus0/1").at(-1)).toMatchObject({
      target: 0,
      seconds: 1.5,
    });
    player.setLayerTarget(1, 0.8);
    expect(output.ramps("bus0/1").at(-1)).toMatchObject({
      target: 0,
      seconds: 1.5,
    });
    player.setLayerEnabled(1, true);
    expect(output.ramps("bus0/1").at(-1)).toMatchObject({
      target: 0.8,
      seconds: 1.5,
    });
  });

  it("keeps a target across a stop and restart", async () => {
    const output = new FakeOutput();
    const player = makePlayer(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeTrack(60, 2),
      5,
    );
    player.setLayerTarget(0, 0.4);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1000);
    player.stop(0.1);
    player.start(player.elapsed(), 0.1);
    expect(output.ramps("bus0/0").at(-1)?.target).toBe(0.4);
  });
});

describe("TrackPlayer stems", () => {
  it("logs a stem that will not load once, keeps playing and tries it again", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
    const output = new FakeOutput();
    const stems = new FakeStems(SAMPLE_SECONDS);
    stems.failLayer("A");
    const player = makePlayer(output, stems, makeTrack(60, 1), 5);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(40_000);

    expect(
      stems.requests.filter((request) => request === "A/1").length,
    ).toBeGreaterThan(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ layer: "A", variant: 1 });
    expect(output.plays("bus0/0")).toHaveLength(0);
    expect(output.plays("bus0/1").length).toBeGreaterThan(4);
  });

  it("starts a slow stem on a later grid tick, and does not hold back another layer", async () => {
    const output = new FakeOutput();
    const stems = new FakeStems(SAMPLE_SECONDS);
    stems.holdLayer("A");
    const player = makePlayer(output, stems, makeTrack(60, 2), 5);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1200);
    // B's first play is at track time 0.5, which anchors the grid.
    const [firstB] = output.plays("bus0/1");
    expect(output.plays("bus0/0")).toHaveLength(0);
    const trackStart = firstB.when - 0.5;
    const arrivedAt = output.currentTime() - trackStart;

    stems.releaseLayer("A");
    await vi.advanceTimersByTimeAsync(1000);
    const [lateA] = output.plays("bus0/0");
    const startAt = lateA.when - trackStart;
    expect(startAt).toBeGreaterThanOrEqual(arrivedAt);
    expect(startAt).toBeLessThan(arrivedAt + 0.5 + 1e-6);
    expect(isOnGrid(startAt, 0.5)).toBe(true);
  });

  it("starts nothing for a stem that arrives after stop", async () => {
    const output = new FakeOutput();
    const stems = new FakeStems(SAMPLE_SECONDS);
    stems.holdLayer("A");
    const player = makePlayer(output, stems, makeTrack(60, 2), 5);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(500);
    player.stop(0.1);
    expect(stems.requests.some((request) => request.startsWith("A/"))).toBe(
      true,
    );

    stems.releaseLayer("A");
    await vi.advanceTimersByTimeAsync(2000);
    expect(output.plays("bus0/0")).toHaveLength(0);
  });
});

describe("TrackPlayer enterState", () => {
  function playerOnStatesTrack(lengthSeconds: number) {
    const output = new FakeOutput();
    const player = makePlayerWithRandom(
      output,
      new FakeStems(SAMPLE_SECONDS),
      makeStatesTrack(lengthSeconds),
      () => 0,
    );
    return { output, player };
  }

  it("is taken by the next play only, when called during the silence", async () => {
    const { player } = playerOnStatesTrack(5);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(player.currentState()).toBeNull();

    player.enterState("second");
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.currentState()).toBeNull();

    // The 5 s silence ends at about 10.3 s and that play runs to about 15.5 s.
    await vi.advanceTimersByTimeAsync(5000);
    expect(player.currentState()?.name).toBe("second");

    await vi.advanceTimersByTimeAsync(5000);
    expect(player.currentState()).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(player.currentState()?.name).toBe("first");
  });

  it("lands on a later tick while playing, cutting nothing and ramping the gains at once", async () => {
    const { output, player } = playerOnStatesTrack(60);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1000);
    // Layer A's first sample is at track time 0, which anchors track time.
    const origin = output.plays("bus0/0")[0].when;

    const calledAt = output.currentTime();
    player.enterState("second");
    expect(player.currentState()?.name).toBe("first");
    expect(player.enabledLayers()).toEqual([true, false]);
    expect(output.ramps("bus0/0").at(-1)).toEqual({
      kind: "ramp",
      gain: "bus0/0",
      target: 1,
      seconds: 1.5,
      at: calledAt,
    });
    expect(output.ramps("bus0/1").at(-1)).toEqual({
      kind: "ramp",
      gain: "bus0/1",
      target: 0,
      seconds: 1.5,
      at: calledAt,
    });

    // The call fell at track time 0.95, so the move lands on the tick at 1.
    const landsAt = origin + 1;
    const untilLanding = Math.round((landsAt - output.currentTime()) * 1000);
    await vi.advanceTimersByTimeAsync(untilLanding - 10);
    expect(player.currentState()?.name).toBe("first");
    await vi.advanceTimersByTimeAsync(20);
    expect(player.currentState()?.name).toBe("second");

    await vi.advanceTimersByTimeAsync(26_000);
    expect(output.cuts()).toEqual([]);
    // Layer A's sample sounds to 2.2 s, then the 1 s start pause of "second"
    // falls on 3.5 s, and its 20 s pause gives 3.5 + 2.2 + 20 = 26.
    const after = output
      .plays("bus0/0")
      .map((call) => call.when - origin)
      .filter((trackTime) => trackTime > 1);
    expect(after).toHaveLength(2);
    expect(after[0]).toBeCloseTo(3.5, 6);
    expect(after[1]).toBeCloseTo(26, 6);
    // Layer B was rolled out and plays no more.
    expect(output.plays("bus0/1")).toHaveLength(1);
  });

  it("does nothing when asked for the state already in force", async () => {
    async function runWith(restate: boolean) {
      const { output, player } = playerOnStatesTrack(60);
      player.start(0, 0.1);
      await vi.advanceTimersByTimeAsync(1000);
      const rampsBefore = output.calls.filter(isRamp).length;
      if (restate) player.enterState("first");
      expect(output.calls.filter(isRamp)).toHaveLength(rampsBefore);
      await vi.advanceTimersByTimeAsync(12_000);
      return output.allPlays().map((call) => call.when);
    }

    const untouched = await runWith(false);
    expect(untouched.length).toBeGreaterThan(3);
    expect(await runWith(true)).toEqual(untouched);
  });

  it("is taken at the next start when stopped, keeping the position and rolling the layers afresh", async () => {
    const { player } = playerOnStatesTrack(60);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(3000);
    player.setLayerEnabled(0, false);
    player.stop(0.1);
    const position = player.elapsed();

    player.enterState("second");
    expect(player.currentState()?.name).toBe("first");

    player.start(position, 0.1);
    expect(player.currentState()?.name).toBe("second");
    expect(player.elapsed()).toBeGreaterThanOrEqual(position);
    expect(player.elapsed()).toBeLessThan(position + 0.2);
    expect(player.enabledLayers()).toEqual([true, false]);
  });

  it("takes the last choice made while stopped, and keeps the layers it had", async () => {
    const { player } = playerOnStatesTrack(60);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(3000);
    player.setLayerEnabled(0, false);
    player.stop(0.1);

    player.enterState("second");
    player.enterState("first");
    player.start(player.elapsed(), 0.1);

    expect(player.currentState()?.name).toBe("first");
    expect(player.enabledLayers()).toEqual([false, true]);
  });

  it("throws on an unknown name, playing or stopped, and changes nothing", async () => {
    const { player } = playerOnStatesTrack(60);
    player.start(0, 0.1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(() => {
      player.enterState("nowhere");
    }).toThrow("nowhere");
    expect(player.currentState()?.name).toBe("first");

    player.stop(0.1);
    expect(() => {
      player.enterState("nowhere");
    }).toThrow("nowhere");
    expect(player.currentState()?.name).toBe("first");
    // Nothing was kept for the next start.
    player.start(player.elapsed(), 0.1);
    expect(player.currentState()?.name).toBe("first");
  });
});

describe("TrackPlayer scheduling inside one lookahead window", () => {
  /** One layer of two variants, with no pauses, on the given grid. */
  function twoVariantTrack(
    alignmentSeconds: number,
    sublayers: number,
    offset: number,
    enabledLayers: number,
  ): VariableTrack {
    const properties: LayerProperties = {
      startPause: [0, 0],
      sequenceLength: [1, 1],
      pauseBetweenSamples: [0, 0],
      pauseBetweenRepetitions: [0, 0],
    };
    return {
      name: "window",
      title: "Window",
      lengthSeconds: 60,
      alignmentSeconds,
      layers: [
        {
          name: "A",
          variants: 2,
          sublayers,
          sublayerStartingOffset: [offset, offset],
        },
      ],
      states: ["first", "second"].map((name) => ({
        name,
        layersProperties: [properties],
        numberOfEnabledLayers: [enabledLayers, enabledLayers],
      })),
    };
  }

  function playerOn(
    output: FakeOutput,
    track: VariableTrack,
    load: StemSource["load"],
  ): TrackPlayer {
    return makePlayerWithRandom(output, { load }, track, () => 0);
  }

  it("loses no grid tick when samples are shorter than the timer's interval", async () => {
    const output = new FakeOutput();
    const player = playerOn(output, twoVariantTrack(0.1, 1, 0, 1), () =>
      Promise.resolve(makeAudioBuffer(0.05, 50)),
    );
    player.start(0, 0.01);
    await vi.advanceTimersByTimeAsync(1000);

    const plays = output.allPlays();
    const starts = plays
      .map((play) => Number((play.when - plays[0].when).toFixed(4)))
      .filter((trackTime) => trackTime < 1);
    expect(starts).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  it("does not repeat a variant when sublayers' first decodes finish out of order", async () => {
    const output = new FakeOutput();
    const slow = Promise.withResolvers<AudioBuffer>();
    let ready = false;
    // Variant 1 is 10 s long and variant 2 is 2 s, which tells them apart below.
    const player = playerOn(
      output,
      twoVariantTrack(1, 2, 1, 1),
      (_track, _layer, variant) =>
        variant === 1 && !ready
          ? slow.promise
          : Promise.resolve(makeAudioBuffer(variant === 1 ? 10 : 2, 10)),
    );
    player.start(0, 0.01);
    await vi.advanceTimersByTimeAsync(1400);
    ready = true;
    slow.resolve(makeAudioBuffer(10, 10));
    await vi.advanceTimersByTimeAsync(2000);

    const heard = output
      .allPlays()
      .toSorted((a, b) => a.when - b.when)
      .map((play) => play.duration);
    expect(heard.length).toBeGreaterThan(2);
    for (let i = 1; i < heard.length; i += 1) {
      expect(heard[i]).not.toBe(heard[i - 1]);
    }
  });

  it("does not let a play still decoding separate two samples of one variant", async () => {
    const output = new FakeOutput();
    const slow = Promise.withResolvers<AudioBuffer>();
    const track: VariableTrack = {
      ...twoVariantTrack(0.1, 3, 0, 1),
      layers: [
        {
          name: "A",
          variants: 2,
          sublayers: 3,
          sublayerStartingOffset: [0.1, 0.2],
        },
      ],
    };
    // Draw 9 is the third sublayer's offset, so the three fall on 0, 0.1 and 0.2.
    let drawn = 0;
    const random = (): number => {
      drawn += 1;
      return drawn === 9 ? 0.999 : 0;
    };
    // Variant 1 is 10 s long and variant 2 is 20 s, which tells them apart below.
    const player = makePlayerWithRandom(
      output,
      {
        load: (_track, _layer, variant) =>
          variant === 2
            ? slow.promise
            : Promise.resolve(makeAudioBuffer(10, 10)),
      },
      track,
      random,
    );
    player.start(0, 0.01);
    await vi.advanceTimersByTimeAsync(300);
    slow.resolve(makeAudioBuffer(20, 10));
    await vi.advanceTimersByTimeAsync(1000);

    const heard = output
      .allPlays()
      .toSorted((a, b) => a.when - b.when)
      .map((play) => play.duration);
    expect(heard).toEqual([10, 20, 10]);
  });

  it("drops a decode from before a restart, and plays the one after it", async () => {
    const output = new FakeOutput();
    const old = Promise.withResolvers<AudioBuffer>();
    const fresh = Promise.withResolvers<AudioBuffer>();
    let requests = 0;
    const player = playerOn(output, twoVariantTrack(1, 1, 0, 1), () => {
      requests += 1;
      return requests === 1 ? old.promise : fresh.promise;
    });
    player.start(0, 0.01);
    await vi.advanceTimersByTimeAsync(20);
    player.stop(0.01);
    player.start(player.elapsed(), 0.01);

    old.resolve(makeAudioBuffer(2, 10));
    await vi.advanceTimersByTimeAsync(100);
    expect(output.allPlays()).toEqual([]);
    fresh.resolve(makeAudioBuffer(2, 10));
    await vi.advanceTimersByTimeAsync(100);
    expect(output.allPlays()).toHaveLength(1);
  });

  it("schedules nothing from a failed decode that comes back after a stop", async () => {
    const output = new FakeOutput();
    const failing = Promise.withResolvers<AudioBuffer>();
    let requests = 0;
    // On this fine a grid, a next sample would fall inside the lookahead.
    const player = playerOn(output, twoVariantTrack(0.1, 1, 0, 1), () => {
      requests += 1;
      return failing.promise;
    });
    player.start(0, 0.01);
    await vi.advanceTimersByTimeAsync(20);
    player.stop(0.01);

    failing.reject(new Error("no such stem"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toBe(1);
  });

  it("drops a decode from before a state move, and starts the new state on its tick", async () => {
    const output = new FakeOutput();
    const old = Promise.withResolvers<AudioBuffer>();
    let requests = 0;
    const player = playerOn(output, twoVariantTrack(1, 1, 0, 1), () => {
      requests += 1;
      return requests === 1
        ? old.promise
        : Promise.resolve(makeAudioBuffer(2, 10));
    });
    player.start(0, 0.01);
    await vi.advanceTimersByTimeAsync(20);
    player.enterState("second");

    old.resolve(makeAudioBuffer(2, 10));
    await vi.advanceTimersByTimeAsync(100);
    expect(output.allPlays()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    const [play] = output.allPlays();
    expect(play.when).toBe(1.05);
  });

  it("enables a silent layer on the next tick that has not gone, not one past the lookahead", async () => {
    const output = new FakeOutput();
    const player = playerOn(output, twoVariantTrack(1, 1, 0, 0), () =>
      Promise.resolve(makeAudioBuffer(10, 10)),
    );
    player.start(0, 0.01);
    // Track time is about 0.55, and the lookahead has already reached past 1.
    await vi.advanceTimersByTimeAsync(600);
    player.setLayerEnabled(0, true);
    await vi.advanceTimersByTimeAsync(2000);

    const [play] = output.allPlays();
    expect(play.when).toBe(1.05);
  });
});
