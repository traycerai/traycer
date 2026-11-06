import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MixDirector } from "../directors";
import type { SoundtrackManifest } from "../manifest";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import type { MixSignals } from "../signals";
import type { Layer, LayerProperties, VariableTrack } from "../variable-sound";
import { FakeOutput, FakeStems } from "./fakes";

const SIGNALS: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

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

function properties(enabled: boolean | null): LayerProperties {
  return {
    enabled,
    startPause: [0, 0],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions: [4, 4],
    playsPerRun: null,
  };
}

/** One state over three layers, with `pins` and the roll's count fixed. */
function trackOf(
  pins: readonly (boolean | null)[],
  rolledCount: number,
): VariableTrack {
  return {
    name: "fixed",
    title: "Fixed",
    lengthSeconds: 60,
    alignmentSeconds: 0.5,
    layers: [layerOf("A"), layerOf("B"), layerOf("C")],
    states: [
      {
        name: "only",
        layersProperties: pins.map(properties),
        numberOfEnabledLayers: [rolledCount, rolledCount],
      },
    ],
    intro: null,
    outro: null,
    phases: [],
  };
}

/** The target of each layer gain's last ramp, in layer order. */
function layerTargets(output: FakeOutput): (number | undefined)[] {
  return [0, 1, 2].map(
    (index) => output.ramps(`bus0/${String(index)}`).at(-1)?.target,
  );
}

/** Opens a session on `track` whose director asks for `plannedCount` layers. */
function openSession(
  track: VariableTrack,
  plannedCount: number,
): { session: SoundtrackSession; output: FakeOutput } {
  const output = new FakeOutput();
  const ports: SoundtrackPorts = {
    output,
    stems: new FakeStems(2.2),
    setDimmed: vi.fn<(dimmed: boolean) => void>(),
    setVolume: vi.fn<(volume: number) => void>(),
    duck: vi.fn<(chimeSeconds: number) => void>(),
    close: vi.fn<(afterSeconds: number) => void>(),
  };
  const manifest: SoundtrackManifest = {
    tracks: [track],
    views: { home: [track.name], task: [], bot: [], settings: [] },
    stems: { tracks: [] },
  };
  const director: MixDirector = {
    plan: (_signals, context) => ({
      state: null,
      enabledLayerCount: plannedCount,
      heldLayers: [],
      pauseMultiplier: 1,
      layerGains: context.track.layers.map(() => 1),
      dim: false,
    }),
  };
  const session = new SoundtrackSession({
    manifest,
    ports,
    random: () => 0,
    director,
    resumePositions: {},
    onSounding: vi.fn<() => void>(),
  });
  return { session, output };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SoundtrackSession with layers the state fixes", () => {
  it("makes the count up from the layers the roll may still turn on", () => {
    // The roll gives [off, on, off]: layer 0 is pinned off, and a random of 0
    // would otherwise pick it for the layer the plan still needs.
    const { session, output } = openSession(trackOf([false, null, null], 1), 2);
    session.setSignals(SIGNALS);

    expect(layerTargets(output)).toEqual([0, 1, 1]);
    session.end();
  });

  it("trims the count from the layers the roll may still turn off", () => {
    // The roll gives [on, on, off]: layer 0 is pinned on, and a random of 0
    // would otherwise pick it for the layer to drop.
    const { session, output } = openSession(trackOf([true, null, null], 2), 1);
    session.setSignals(SIGNALS);

    expect(layerTargets(output)).toEqual([1, 0, 0]);
    session.end();
  });
});
