import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MixDirector } from "../directors";
import type { SoundtrackManifest } from "../manifest";
import { MIX_TUNING } from "../mix-tuning";
import { CROSSFADE_SECONDS } from "../player";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import type { MixSignals, SoundtrackView } from "../signals";
import type { VariableTrack } from "../variable-sound";
import { FakeOutput, FakeStems } from "./fakes";

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

/** Two layers on one state that rolls one of them on; length 10 s. */
function trackOf(name: string): VariableTrack {
  const properties = {
    enabled: null,
    startPause: [0, 0],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions: [4, 4],
    playsPerRun: null,
  } as const;
  return {
    name,
    title: name,
    lengthSeconds: 10,
    alignmentSeconds: 0.5,
    layers: ["A", "B"].map((layerName) => ({
      name: layerName,
      variants: 1,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    })),
    states: [
      {
        name: "only",
        layersProperties: [properties, properties],
        numberOfEnabledLayers: [1, 1],
      },
    ],
    intro: null,
    outro: null,
    phases: [],
  };
}

function open(
  views: SoundtrackManifest["views"],
  tracks: readonly string[],
  heldLayers: readonly number[],
) {
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
    tracks: tracks.map(trackOf),
    views,
    stems: { tracks: [] },
  };
  const director: MixDirector = {
    plan: (_signals, context) => ({
      state: null,
      enabledLayerCount: null,
      heldLayers,
      pauseMultiplier: 1,
      layerGains: context.track.layers.map(() => 1),
      dim: false,
    }),
  };
  const onSounding =
    vi.fn<(sounding: { readonly view: SoundtrackView } | null) => void>();
  const session = new SoundtrackSession({
    manifest,
    ports,
    random: () => 0,
    director,
    resumePositions: {},
    onSounding,
  });
  return { session, output, onSounding };
}

const EMPTY_VIEWS: SoundtrackManifest["views"] = {
  home: [],
  task: [],
  bot: [],
  settings: [],
};

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

describe("SoundtrackSession track pools", () => {
  it("moves a view with two tracks to the other after the first ends, and back after that", async () => {
    const { session, output } = open(
      { ...EMPTY_VIEWS, home: ["one", "two"] },
      ["one", "two"],
      [],
    );
    session.setSignals(HOME);

    // "one" ends on the first tick at or after 10.05 s; the silence is 8 s.
    await advance(11);
    const ringOut = output.ramps("bus0").at(-1);
    expect(ringOut).toMatchObject({
      target: 0,
      seconds: MIX_TUNING.outroRingOutSeconds,
    });
    const playsOnOne = output.plays("bus0/0").length;
    expect(output.ramps("bus1")).toEqual([]);
    expect(
      output.allPlays().filter((play) => play.gain.startsWith("bus1")),
    ).toEqual([]);

    await advance(8);
    const fadeIn = output.ramps("bus1")[0];
    expect(fadeIn).toMatchObject({
      target: 1,
      seconds: MIX_TUNING.fadeInSeconds,
    });
    expect(fadeIn.at - (ringOut?.at ?? 0)).toBeCloseTo(8, 5);
    expect(
      output
        .allPlays()
        .filter((play) => play.gain.startsWith("bus1"))
        .every((play) => play.at >= fadeIn.at),
    ).toBe(true);
    expect(output.plays("bus0/0")).toHaveLength(playsOnOne);

    // "two" ends about 10 s later and "one" comes back on its own bus.
    await advance(21);
    expect(output.ramps("bus0").at(-1)).toMatchObject({
      target: 1,
      seconds: MIX_TUNING.fadeInSeconds,
    });
    expect(output.calls.some((call) => call.gain.startsWith("bus2"))).toBe(
      false,
    );
    expect(
      output.plays("bus0/0").filter((play) => play.at >= 36),
    ).not.toHaveLength(0);

    expect(session.end().home).toMatchObject({ trackName: "one" });
  });

  it("turns a layer the director holds on at the next track's first run, ahead of the next replan", async () => {
    const { session, output } = open(
      { ...EMPTY_VIEWS, home: ["one", "two"] },
      ["one", "two"],
      [1],
    );
    session.setSignals(HOME);
    await advance(19);

    // "two" opened at about 18.1 s; the replan ticks fall at 15 s and 20 s.
    const fadeIn = output.ramps("bus1")[0];
    expect(fadeIn.at).toBeGreaterThan(18);
    expect(output.ramps("bus1/1").at(-1)).toMatchObject({
      target: 1,
      seconds: 1.5,
      at: fadeIn.at,
    });
    expect(
      output.plays("bus1/1").filter((play) => play.at < 20),
    ).not.toHaveLength(0);
    session.end();
  });

  it("plays a view's only track again after the silence, with no stop at its end", async () => {
    const { session, output } = open(
      { ...EMPTY_VIEWS, home: ["solo"] },
      ["solo"],
      [],
    );
    session.setSignals(HOME);
    await advance(19);

    expect(output.ramps("bus0")).toHaveLength(1);
    expect(output.calls.some((call) => call.gain.startsWith("bus1"))).toBe(
      false,
    );
    expect(output.allPlays().filter((play) => play.at > 18)).not.toHaveLength(
      0,
    );
    session.end();
  });

  it("takes a view change onto the sounding track over without a fade or a cut", async () => {
    const { session, output, onSounding } = open(
      { ...EMPTY_VIEWS, home: ["shared"], settings: ["shared"] },
      ["shared"],
      [],
    );
    session.setSignals(HOME);
    await advance(3);
    const callsBefore = output.calls.length;

    session.setSignals({ ...HOME, view: "settings" });
    expect(
      output.calls.slice(callsBefore).filter((call) => call.kind !== "play"),
    ).toEqual([]);
    expect(onSounding.mock.lastCall?.[0]?.view).toBe("settings");

    // The layer comes round every 6.5 s, and the track ends at 10 s; a gap of
    // 9 s would be a restart.
    await advance(6);
    const starts = output.plays("bus0/0").map((play) => play.when);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    starts.slice(1).forEach((when, index) => {
      expect(when - starts[index]).toBeLessThan(7);
    });
    expect(output.cuts()).toEqual([]);
    expect(output.calls.some((call) => call.gain.startsWith("bus1"))).toBe(
      false,
    );

    const positions = session.end();
    expect(positions.home).toEqual(positions.settings);
    expect(positions.home?.trackName).toBe("shared");
  });

  it("cancels a track's pending start when the view changes during the silence, and starts it on the way back", async () => {
    const { session, output } = open(
      { ...EMPTY_VIEWS, home: ["one", "two"], task: ["three"] },
      ["one", "two", "three"],
      [],
    );
    session.setSignals(HOME);
    await advance(11);
    session.setSignals({ ...HOME, view: "task" });
    await advance(9);
    expect(output.ramps("bus1")).toEqual([]);

    session.setSignals(HOME);
    expect(output.ramps("bus1")).toEqual([
      expect.objectContaining({ target: 1, seconds: CROSSFADE_SECONDS }),
    ]);
    session.end();
  });

  it("leaves the view on its track when a player fading out reaches its own run end", async () => {
    const { session, output } = open(
      { ...EMPTY_VIEWS, home: ["one"], task: ["two", "three"] },
      ["one", "two", "three"],
      [],
    );
    session.setSignals(HOME);
    // "one" fades out over 2 s from 9 s, and its run ends at 10.08 s inside the
    // fade. "two" began at 9 s and ends at about 19.1 s, so by 18.5 s a rotation
    // by "one" would have started "three" (10.08 s + 8 s) on a third bus.
    await advance(9);
    session.setSignals({ ...HOME, view: "task" });
    await advance(9.5);

    expect(output.calls.some((call) => call.gain.startsWith("bus2"))).toBe(
      false,
    );
    expect(output.ramps("bus1").every((ramp) => ramp.target > 0)).toBe(true);
    expect(session.end().task?.trackName).toBe("two");
  });

  it("starts nothing after the session ends during the silence", async () => {
    const { session, output } = open(
      { ...EMPTY_VIEWS, home: ["one", "two"] },
      ["one", "two"],
      [],
    );
    session.setSignals(HOME);
    await advance(11);
    session.end();
    await advance(30);

    expect(output.ramps("bus1")).toEqual([]);
  });
});
