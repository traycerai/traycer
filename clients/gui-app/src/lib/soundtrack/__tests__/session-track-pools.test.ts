import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MixDirector } from "../directors";
import type { SoundtrackManifest } from "../manifest";
import { MIX_TUNING } from "../mix-tuning";
import { CROSSFADE_SECONDS } from "../player";
import {
  SoundtrackSession,
  type ResumePositions,
  type SoundtrackPorts,
} from "../session";
import type { MixSignals, SoundtrackView } from "../signals";
import type { StemSource } from "../stems";
import type { VariableTrack } from "../variable-sound";
import { makeAudioBuffer } from "./audio-buffer";
import { SoundtrackLogRelay } from "../session-log";
import { captureNothing, FakeOutput, FakeStems } from "./fakes";

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
      role: null,
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

interface SessionConfig {
  readonly views: SoundtrackManifest["views"];
  readonly tracks: readonly VariableTrack[];
  readonly stems: StemSource;
  readonly heldLayers: readonly number[];
  readonly resumePositions: ResumePositions;
}

function openWith(config: SessionConfig) {
  const output = new FakeOutput();
  const ports: SoundtrackPorts = {
    output,
    stems: config.stems,
    setDimmed: vi.fn<(dimmed: boolean) => void>(),
    setVolume: vi.fn<(volume: number) => void>(),
    duck: vi.fn<(chimeSeconds: number) => void>(),
    close: vi.fn<(afterSeconds: number) => void>(),
    log: new SoundtrackLogRelay(),
    captureMix: captureNothing,
  };
  const manifest: SoundtrackManifest = {
    tracks: config.tracks,
    views: config.views,
    stems: { tracks: [] },
  };
  const director: MixDirector = {
    plan: (_signals, context) => ({
      state: null,
      enabledLayerCount: null,
      heldLayers: config.heldLayers,
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
    resumePositions: config.resumePositions,
    onSounding,
  });
  return { session, output, onSounding };
}

/** Tracks of 10 s whose samples last 2.2 s. */
function open(
  views: SoundtrackManifest["views"],
  tracks: readonly string[],
  heldLayers: readonly number[],
) {
  return openWith({
    views,
    tracks: tracks.map(trackOf),
    stems: new FakeStems(2.2),
    heldLayers,
    resumePositions: {},
  });
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

  it("restarts a track another view left partway as a fresh run, with its intro and the plan restated", async () => {
    // B has a 2 s intro and layers of 2.2 s; its layers wait for the intro.
    const lengths = new Map([
      ["I", 2],
      ["A", 2.2],
      ["B", 2.2],
    ]);
    const stems: StemSource = {
      load: (_track, layer) =>
        Promise.resolve(makeAudioBuffer(lengths.get(layer.name) ?? 2.2, 10)),
    };
    const introTrack: VariableTrack = {
      ...trackOf("B"),
      lengthSeconds: 40,
      intro: { name: "I", variants: 1, pan: null },
    };
    const { session, output } = openWith({
      views: { ...EMPTY_VIEWS, task: ["B"], home: ["A", "B"] },
      tracks: [trackOf("A"), introTrack],
      stems,
      heldLayers: [1],
      resumePositions: {},
    });
    session.setSignals({ ...HOME, view: "task" });
    await advance(3);
    // B (bus0) fades out over 2 s and is stopped at 5 s, 4.99 s into its
    // track. A (bus1) began at 3 s and ends at about 13.1 s; B follows 8 s
    // later, at about 21.1 s.
    session.setSignals(HOME);
    await advance(19);

    const restart = output.ramps("bus0").at(-1);
    expect(restart).toMatchObject({
      target: 1,
      seconds: MIX_TUNING.fadeInSeconds,
    });
    expect(restart?.at).toBeGreaterThan(21);
    expect(output.plays("bus0/2").filter((play) => play.at > 21)).toHaveLength(
      1,
    );
    // The fresh roll leaves layer 1 off, and the plan held it on at the start.
    expect(output.ramps("bus0/1").at(-1)).toMatchObject({
      target: 1,
      seconds: 1.5,
      at: restart?.at,
    });

    // At 22 s a start from the top is under 1 s in; a resume would be near 6 s.
    const position = session.end().home;
    expect(position?.trackName).toBe("B");
    expect(position?.elapsedSeconds).toBeGreaterThan(0.5);
    expect(position?.elapsedSeconds).toBeLessThan(1.5);
  });

  describe("when the track a rotation picks is still fading out from the previous view", () => {
    /**
     * Task plays B from 0; at 9 s home resumes A at 9.5 s and B fades out until
     * 11 s. A ends at about 9.6 s and the rotation picks B, which would end its
     * own run at 10.08 s if it were still playing; its start is due at 17.6 s.
     */
    async function openFadingRotation() {
      const opened = openWith({
        views: {
          ...EMPTY_VIEWS,
          home: ["A", "B"],
          task: ["B"],
          settings: ["C"],
        },
        tracks: [trackOf("A"), trackOf("B"), trackOf("C")],
        stems: new FakeStems(2.2),
        heldLayers: [],
        resumePositions: { home: { trackName: "A", elapsedSeconds: 9.5 } },
      });
      opened.session.setSignals({ ...HOME, view: "task" });
      await advance(9);
      opened.session.setSignals(HOME);
      await advance(2);
      return opened;
    }

    it("starts nothing after the session ends", async () => {
      const { session, output } = await openFadingRotation();
      session.end();
      const callsAtEnd = output.calls.length;
      await advance(20);

      expect(output.calls.slice(callsAtEnd)).toEqual([]);
    });

    it("does not start it while another view's track is in front", async () => {
      const { session, output } = await openFadingRotation();
      session.setSignals({ ...HOME, view: "settings" });
      await advance(20);

      expect(
        output.ramps("bus0").filter((ramp) => ramp.at > 11 && ramp.target > 0),
      ).toEqual([]);
      expect(output.plays("bus0/0").filter((play) => play.at > 11)).toEqual([]);
      session.end();
    });
  });

  it("cuts the track in its ring-out when the view moves on, and leaves its buses silent for good", async () => {
    // Each track's one sample plays from 0 for 60 s, far past the 10 s length
    // and the 2 s crossfade.
    const { session, output } = openWith({
      views: { ...EMPTY_VIEWS, home: ["one"], settings: ["two"] },
      tracks: [trackOf("one"), trackOf("two")],
      stems: new FakeStems(60),
      heldLayers: [],
      resumePositions: {},
    });
    session.setSignals(HOME);
    await advance(12);
    expect(output.cuts()).toEqual([]);

    session.setSignals({ ...HOME, view: "settings" });
    await advance(CROSSFADE_SECONDS + 1);
    const cuts = output.cuts();
    expect(cuts).toHaveLength(1);
    expect(cuts[0].gain).toMatch(/^bus0\//);
    const onOldBus = () =>
      output.calls.filter((call) => call.gain.startsWith("bus0")).length;
    const settled = onOldBus();

    await advance(40);
    expect(onOldBus()).toBe(settled);
    session.end();
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
