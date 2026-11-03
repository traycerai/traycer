/**
 * The soundtrack store with the REAL session, directors, players and
 * scheduler behind the fake ports (`lib/soundtrack/__tests__/fakes.ts`). The
 * clock is the fake timers' clock, and everything is read off what reaches the
 * ports and off the store's state.
 */
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
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
import { MIX_TUNING } from "@/lib/soundtrack/mix-tuning";
import { CROSSFADE_SECONDS } from "@/lib/soundtrack/player";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import type { MixSignals } from "@/lib/soundtrack/signals";
import type { VariableTrack } from "@/lib/soundtrack/variable-sound";
import {
  FakeOutput,
  FakeStems,
  isRamp,
} from "@/lib/soundtrack/__tests__/fakes";
import { createSoundtrackStore } from "../soundtrack-store";

const SAMPLE_SECONDS = 2.2;
const LAYER_NAMES = ["A", "B", "C", "D"] as const;

// Four layers, one state that enables one to all of them, and a layer that
// comes round every 6.2 s. Which layers are on at the start is the random roll.
function makeTrack(name: string, lengthSeconds: number): VariableTrack {
  const properties = {
    startPause: [0, 0],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions: [4, 4],
  } as const;
  return {
    name,
    title: name,
    lengthSeconds,
    alignmentSeconds: 0.5,
    layers: LAYER_NAMES.map((layerName) => ({
      name: layerName,
      variants: 1,
      sublayers: 1,
      sublayerStartingOffset: null,
    })),
    states: [
      {
        name: "only",
        layersProperties: LAYER_NAMES.map(() => properties),
        numberOfEnabledLayers: [1, 4],
      },
    ],
  };
}

function manifestOf(
  tracks: readonly VariableTrack[],
  views: SoundtrackManifest["views"],
): SoundtrackManifest {
  return { tracks, views, stems: { tracks: [] } };
}

const SINGLE_VIEWS: SoundtrackManifest["views"] = {
  home: ["calm"],
  task: ["busy"],
  bot: [],
  settings: [],
};

const SINGLE_TRACKS = [makeTrack("calm", 60), makeTrack("busy", 60)];

/** mulberry32: the same draws on every run. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface OpenedPorts {
  readonly output: FakeOutput;
  readonly setDimmed: Mock<(dimmed: boolean) => void>;
  readonly close: Mock<(afterSeconds: number) => void>;
}

function signalsOf(overrides: Partial<MixSignals>): MixSignals {
  return {
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
    ...overrides,
  };
}

function harness(manifest: SoundtrackManifest, random: () => number) {
  const opened: OpenedPorts[] = [];
  const openPorts = vi.fn((): SoundtrackPorts => {
    const output = new FakeOutput();
    const setDimmed = vi.fn<(dimmed: boolean) => void>();
    const close = vi.fn<(afterSeconds: number) => void>();
    const ports = {
      output,
      stems: new FakeStems(SAMPLE_SECONDS),
      setDimmed,
      close,
    };
    opened.push({ output, setDimmed, close });
    return ports;
  });
  const store = createSoundtrackStore({ manifest, openPorts, random });
  return { store, openPorts, opened };
}

function singleTrackHarness(random: () => number) {
  return harness(manifestOf(SINGLE_TRACKS, SINGLE_VIEWS), random);
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

/** The target of each layer's last gain ramp, in layer order; null if never. */
function layerTargets(output: FakeOutput, bus: string): (number | null)[] {
  return LAYER_NAMES.map((_, index) => {
    const ramps = output.ramps(`${bus}/${String(index)}`);
    return ramps.length === 0 ? null : ramps[ramps.length - 1].target;
  });
}

function lastRamp(output: FakeOutput, gain: string) {
  const ramps = output.ramps(gain);
  return ramps.length === 0 ? null : ramps[ramps.length - 1];
}

function onCount(targets: readonly (number | null)[]): number {
  return targets.filter((target) => target !== null && target > 0).length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("soundtrack store: a session", () => {
  it("opens the ports on enable and starts the view's track on the first signals", async () => {
    const { store, openPorts, opened } = singleTrackHarness(seededRandom(1));
    store.getState().enable();

    expect(store.getState().enabled).toBe(true);
    expect(openPorts).toHaveBeenCalledTimes(1);
    // Nothing is playing before a view is known.
    expect(opened[0].output.calls).toEqual([]);
    expect(store.getState().soundingView).toBeNull();

    store.getState().setSignals(signalsOf({ view: "home" }));
    await advance(1);

    const { output } = opened[0];
    expect(lastRamp(output, "bus0")).toMatchObject({
      target: 1,
      seconds: MIX_TUNING.fadeInSeconds,
    });
    expect(output.allPlays().length).toBeGreaterThan(0);
    expect(store.getState().soundingView).toBe("home");
    expect(store.getState().lastPlan).toEqual({
      state: null,
      enabledLayerCount: null,
      heldLayers: [],
      pauseMultiplier: 1,
      layerGains: [1, 1, 1, 1],
      dim: false,
    });
    expect(opened[0].setDimmed).toHaveBeenLastCalledWith(false);
  });

  it("cuts the samples sounding over the stop fade on disable", async () => {
    const { store, opened } = singleTrackHarness(seededRandom(1));
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home" }));
    // A sample is under way: they last 2.2 s from the first tick.
    await advance(1);
    store.getState().disable();

    const cuts = opened[0].output.cuts();
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.map((cut) => cut.fade)).toEqual(
      cuts.map(() => MIX_TUNING.stopFadeSeconds),
    );
  });

  it("fades out, closes the ports and stores where each view got to on disable", async () => {
    const { store, opened } = singleTrackHarness(seededRandom(1));
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home" }));
    await advance(3);
    store.getState().disable();

    const { output, close } = opened[0];
    expect(close).toHaveBeenCalledWith(MIX_TUNING.stopFadeSeconds);
    expect(lastRamp(output, "bus0")).toMatchObject({
      target: 0,
      seconds: MIX_TUNING.stopFadeSeconds,
    });
    const state = store.getState();
    expect(state.enabled).toBe(false);
    expect(state.soundingView).toBeNull();
    expect(state.lastPlan).toBeNull();
    // 3 s in, less the 50 ms the first sample waits before the track's start.
    expect(state.resumePositions.home?.trackName).toBe("calm");
    expect(state.resumePositions.home?.elapsedSeconds).toBeGreaterThan(2.9);
    expect(state.resumePositions.home?.elapsedSeconds).toBeLessThan(3);
  });

  it("stays off when the audio device will not open, and opens on the next gesture", () => {
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    const { store, openPorts } = singleTrackHarness(seededRandom(1));
    openPorts.mockImplementationOnce(() => {
      throw new Error("no audio device");
    });
    store.getState().enable();

    expect(store.getState().enabled).toBe(false);
    expect(warn).toHaveBeenCalled();
    store.getState().setSignals(signalsOf({ view: "home" }));
    expect(store.getState().soundingView).toBeNull();

    // Off stays retryable: the next gesture opens it.
    store.getState().enable();
    expect(store.getState().enabled).toBe(true);
  });

  it("does nothing with signals while off, and keeps none for when it is switched on", () => {
    const { store, openPorts, opened } = singleTrackHarness(seededRandom(1));
    store.getState().setSignals(signalsOf({ view: "home", blocking: 2 }));
    expect(openPorts).not.toHaveBeenCalled();
    expect(store.getState().soundingView).toBeNull();
    expect(store.getState().lastPlan).toBeNull();

    store.getState().enable();
    expect(store.getState().soundingView).toBeNull();
    expect(opened[0].output.calls).toEqual([]);
  });
});

describe("soundtrack store: views", () => {
  it("crossfades to another view's track, and back resumes the first where it left off", async () => {
    const { store, opened } = singleTrackHarness(seededRandom(1));
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home" }));
    await advance(3);

    store.getState().setSignals(signalsOf({ view: "task" }));
    const { output } = opened[0];
    expect(lastRamp(output, "bus0")).toMatchObject({
      target: 0,
      seconds: CROSSFADE_SECONDS,
    });
    expect(lastRamp(output, "bus1")).toMatchObject({
      target: 1,
      seconds: CROSSFADE_SECONDS,
    });
    expect(store.getState().soundingView).toBe("task");

    await advance(4);
    store.getState().setSignals(signalsOf({ view: "home" }));
    expect(lastRamp(output, "bus1")).toMatchObject({
      target: 0,
      seconds: CROSSFADE_SECONDS,
    });
    expect(lastRamp(output, "bus0")).toMatchObject({
      target: 1,
      seconds: CROSSFADE_SECONDS,
    });
    expect(store.getState().soundingView).toBe("home");
    // It is the first view's player again and not a third.
    expect(output.calls.some((call) => call.gain.startsWith("bus2"))).toBe(
      false,
    );

    store.getState().disable();
    const positions = store.getState().resumePositions;
    // Home was left at 3 s and its fade ended at 5 s, where it stopped.
    expect(positions.home?.elapsedSeconds).toBeGreaterThan(4.9);
    expect(positions.home?.elapsedSeconds).toBeLessThan(5.2);
    expect(positions.task?.trackName).toBe("busy");
  });

  it("fades out for a view with no track, and sounds again when one with a track returns", async () => {
    const { store, opened } = singleTrackHarness(seededRandom(1));
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home" }));
    await advance(2);

    store.getState().setSignals(signalsOf({ view: "bot" }));
    const { output } = opened[0];
    expect(lastRamp(output, "bus0")).toMatchObject({
      target: 0,
      seconds: CROSSFADE_SECONDS,
    });
    expect(store.getState().soundingView).toBeNull();
    // No player was made for a view with nothing to play.
    expect(output.calls.some((call) => call.gain.startsWith("bus1"))).toBe(
      false,
    );

    await advance(3);
    store.getState().setSignals(signalsOf({ view: "home" }));
    expect(store.getState().soundingView).toBe("home");
    expect(lastRamp(output, "bus0")).toMatchObject({ target: 1 });
  });

  it("resumes the same track at the stored position through a new player after off and on", async () => {
    const random = vi.fn(() => 0);
    const twoHomeTracks = [makeTrack("calm", 60), makeTrack("calm-b", 60)];
    const { store, opened } = harness(
      manifestOf(twoHomeTracks, { ...SINGLE_VIEWS, home: ["calm", "calm-b"] }),
      random,
    );
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home" }));
    await advance(6);
    store.getState().disable();
    const stored = store.getState().resumePositions.home;
    expect(stored?.trackName).toBe("calm");

    // A pick now would land on the other track.
    random.mockReturnValue(0.99);
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home" }));
    await advance(2);
    expect(opened).toHaveLength(2);
    expect(opened[1].output.allPlays().length).toBeGreaterThan(0);
    store.getState().disable();

    const resumed = store.getState().resumePositions.home;
    expect(resumed?.trackName).toBe("calm");
    // From where it was left, for the 2 s it played (less the 50 ms lead).
    expect(resumed?.elapsedSeconds).toBeGreaterThan(
      (stored?.elapsedSeconds ?? 0) + 1.9,
    );
    expect(resumed?.elapsedSeconds).toBeLessThan(
      (stored?.elapsedSeconds ?? 0) + 2.01,
    );
  });
});

describe("soundtrack store: directors", () => {
  it("re-plans at once when the director changes, and the player gets what the rules say", async () => {
    const { store, opened } = singleTrackHarness(seededRandom(7));
    store.getState().enable();
    store
      .getState()
      .setSignals(signalsOf({ view: "home", working: 2, blocking: 1 }));
    await advance(1);
    expect(store.getState().lastPlan?.heldLayers).toEqual([]);

    store.getState().setDirector("rules");

    const state = store.getState();
    expect(state.directorId).toBe("rules");
    // 0.12 + 0.3 + 0.2 = 0.62 over the state's 1 to 4 layers is 3.
    expect(state.lastPlan).toMatchObject({
      enabledLayerCount: 3,
      heldLayers: [1],
      dim: false,
    });
    expect(state.lastPlan?.pauseMultiplier).toBeCloseTo(1.6 - 1.2 * 0.62, 10);
    const targets = layerTargets(opened[0].output, "bus0");
    expect(onCount(targets)).toBe(3);
    // B is held on at its lifted gain.
    expect(targets[1]).toBe(1.25);
    expect(opened[0].setDimmed).toHaveBeenLastCalledWith(false);
  });

  it("dims the mix through the port while a failure is unread, and lifts it when it is read", () => {
    const { store, opened } = singleTrackHarness(seededRandom(7));
    store.getState().setDirector("rules");
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home", failure: 1 }));
    expect(opened[0].setDimmed).toHaveBeenLastCalledWith(true);

    store.getState().setSignals(signalsOf({ view: "home" }));
    expect(opened[0].setDimmed).toHaveBeenLastCalledWith(false);
  });

  it("keeps a held B on when the count trims the others", async () => {
    const { store, opened } = singleTrackHarness(seededRandom(3));
    store.getState().setDirector("rules");
    store.getState().enable();
    store
      .getState()
      .setSignals(
        signalsOf({ view: "home", working: 3, blocking: 2, failure: 1 }),
      );
    await advance(1);
    expect(onCount(layerTargets(opened[0].output, "bus0"))).toBe(4);

    // Intensity falls to 0.32, a count of 2, with one prompt still blocking.
    store.getState().setSignals(signalsOf({ view: "home", blocking: 1 }));

    const targets = layerTargets(opened[0].output, "bus0");
    expect(store.getState().lastPlan?.enabledLayerCount).toBe(2);
    expect(onCount(targets)).toBe(2);
    expect(targets[1]).toBe(1.25);
  });

  it("restores the plan's layers every 5 s after a track's end discards them", async () => {
    const shortHome = [makeTrack("short", 10)];
    const { store, opened } = harness(
      manifestOf(shortHome, { ...SINGLE_VIEWS, home: ["short"] }),
      () => 0,
    );
    store.getState().setDirector("rules");
    store.getState().enable();
    store.getState().setSignals(signalsOf({ view: "home", blocking: 1 }));
    await advance(3);
    const { output } = opened[0];
    // Only A rolled on at zero; the plan held B on beside it.
    expect(lastRamp(output, "bus0/1")?.target).toBe(1.25);

    // The track ends at 10 s and is silent for 8 s; the run that follows rolls
    // its layers afresh, and B is off with nothing having restated the plan.
    await advance(16);
    expect(lastRamp(output, "bus0/1")?.target).toBe(0);

    // The next 5 s tick sets it again.
    await advance(2);
    expect(lastRamp(output, "bus0/1")?.target).toBe(1.25);
  });

  it("does not re-plan identical signals, and a restated plan flips no layer", async () => {
    const { store, opened } = singleTrackHarness(seededRandom(11));
    store.getState().setDirector("rules");
    store.getState().enable();
    const busy = signalsOf({ view: "home", working: 1, blocking: 1 });
    store.getState().setSignals(busy);
    await advance(1);

    const planBefore = store.getState().lastPlan;
    const callsBefore = opened[0].output.calls.length;
    store.getState().setSignals({ ...busy });
    expect(store.getState().lastPlan).toBe(planBefore);
    expect(opened[0].output.calls).toHaveLength(callsBefore);

    // The 5 s tick restates the plan: gains are ramped to where they were and
    // no layer goes on or off.
    const targetsBefore = layerTargets(opened[0].output, "bus0");
    const rampsBefore = opened[0].output.calls.filter(isRamp).length;
    await advance(MIX_TUNING.replanIntervalMs / 1000);
    expect(opened[0].output.calls.filter(isRamp).length).toBeGreaterThan(
      rampsBefore,
    );
    expect(layerTargets(opened[0].output, "bus0")).toEqual(targetsBefore);
    expect(store.getState().lastPlan).toEqual(planBefore);
  });
});
