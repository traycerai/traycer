/**
 * Pause, Play, Next and Previous on the real session, players and scheduler
 * behind the fake ports. A track lasts 10 s and each of its runs ends on the
 * first tick past 10.05 s; the silence after one is 8 s (the shortest, as the
 * draw below is 0 unless a test sets it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import type { MixDirector } from "../directors";
import type { SoundtrackManifest } from "../manifest";
import { MIX_TUNING } from "../mix-tuning";
import { CROSSFADE_SECONDS } from "../player";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import type { MixSignals } from "../signals";
import type { StemSource } from "../stems";
import { makeAudioBuffer } from "./audio-buffer";
import { playbackTrack } from "./playback-track";
import { FakeOutput } from "./fakes";

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};
const TASK: MixSignals = { ...HOME, view: "task" };

const EMPTY_VIEWS: SoundtrackManifest["views"] = {
  home: [],
  task: [],
  bot: [],
  settings: [],
};

/**
 * Samples of 2.2 s that note which track asked for them, so the last request is
 * the track now placing its samples. With `deferred`, a load is answered only
 * when the test lands or fails it.
 */
class RecordingStems implements StemSource {
  readonly tracks: string[] = [];
  private readonly deferred: boolean;
  private readonly waiting: Array<{
    readonly resolve: (buffer: AudioBuffer) => void;
    readonly reject: (error: Error) => void;
  }> = [];

  constructor(deferred: boolean) {
    this.deferred = deferred;
  }

  load(track: { readonly name: string }): Promise<AudioBuffer> {
    this.tracks.push(track.name);
    if (!this.deferred) return Promise.resolve(makeAudioBuffer(2.2, 10));
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  /** The track whose samples were asked for last. */
  last(): string | undefined {
    return this.tracks.at(-1);
  }

  land(): void {
    for (const load of this.waiting.splice(0)) {
      load.resolve(makeAudioBuffer(2.2, 10));
    }
  }

  fail(): void {
    for (const load of this.waiting.splice(0)) {
      load.reject(new Error("no such stem"));
    }
  }
}

function directorHolding(heldLayers: readonly number[]): MixDirector {
  return {
    plan: (_signals, context) => ({
      state: null,
      enabledLayerCount: null,
      heldLayers,
      pauseMultiplier: 1,
      layerGains: context.track.layers.map(() => 1),
      dim: false,
    }),
  };
}

/** The value `random` answers, so that a test can steer the track a skip picks. */
interface Draw {
  value: number;
}

interface OpenConfig {
  readonly views: SoundtrackManifest["views"];
  readonly tracks: readonly string[];
  readonly deferredStems: boolean;
}

function open(config: OpenConfig) {
  const output = new FakeOutput();
  const stems = new RecordingStems(config.deferredStems);
  const duck = vi.fn<(chimeSeconds: number) => void>();
  const close = vi.fn<(afterSeconds: number) => void>();
  const ports: SoundtrackPorts = {
    output,
    stems,
    setDimmed: vi.fn<(dimmed: boolean) => void>(),
    setVolume: vi.fn<(volume: number) => void>(),
    duck,
    close,
    pause: () => {
      output.stopClock();
    },
    resume: () => {
      output.startClock();
    },
  };
  const draw: Draw = { value: 0 };
  const onSounding =
    vi.fn<(sounding: { readonly view: string } | null) => void>();
  const session = new SoundtrackSession({
    manifest: {
      tracks: config.tracks.map((name) => playbackTrack(name, 10)),
      views: config.views,
      stems: { tracks: [] },
    },
    ports,
    random: () => draw.value,
    director: directorHolding([]),
    resumePositions: {},
    onSounding,
  });
  return { session, output, stems, duck, close, draw, onSounding };
}

/** One view, `home`, with these tracks. */
function openHome(tracks: readonly string[]) {
  return open({
    views: { ...EMPTY_VIEWS, home: tracks },
    tracks,
    deferredStems: false,
  });
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

describe("SoundtrackSession pause", () => {
  it("places nothing, ends no run and rotates nothing past a run's end, with no timer left", async () => {
    const { session, output, stems, onSounding } = openHome(["one", "two"]);
    session.setSignals(HOME);
    await advance(4);

    session.pause();
    expect(vi.getTimerCount()).toBe(0);
    const calls = output.calls.length;
    const loads = stems.tracks.length;
    const soundings = onSounding.mock.calls.length;

    // The run would end at about 10 s and the silence be over 8 s after it.
    await advance(100);
    expect(output.calls).toHaveLength(calls);
    expect(stems.tracks).toHaveLength(loads);
    expect(onSounding).toHaveBeenCalledTimes(soundings);
    expect(vi.getTimerCount()).toBe(0);

    // The 4 s already played count: the run ends at 10 s of track time.
    session.play();
    await advance(7);
    const ringOut = output.ramps("bus0").at(-1);
    expect(ringOut).toMatchObject({
      target: 0,
      seconds: MIX_TUNING.outroRingOutSeconds,
    });
    expect(ringOut?.at).toBeGreaterThan(10);
    expect(ringOut?.at).toBeLessThan(10.3);
    session.end();
  });

  it("holds the silence between tracks: no start, no timer, and the rest of it after Play", async () => {
    const { session, output } = openHome(["one", "two"]);
    session.setSignals(HOME);
    await advance(11);
    const ringOut = output.ramps("bus0").at(-1);
    const silenceStart = ringOut?.at ?? 0;
    expect(ringOut?.target).toBe(0);

    // 5 s into the 8 s silence, with 3 s of it left.
    await advance(silenceStart + 5 - output.currentTime());
    session.pause();
    expect(vi.getTimerCount()).toBe(0);
    const calls = output.calls.length;

    await advance(1000);
    expect(output.calls).toHaveLength(calls);
    expect(output.ramps("bus1")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    session.play();
    await advance(2.5);
    expect(output.ramps("bus1")).toEqual([]);

    await advance(1);
    const fadeIn = output.ramps("bus1")[0];
    expect(fadeIn).toMatchObject({
      target: 1,
      seconds: MIX_TUNING.fadeInSeconds,
    });
    expect(fadeIn.at - silenceStart).toBeCloseTo(8, 2);
    // The player rotated away is stopped and released at Play: it has no tick.
    session.end();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds the silence of a view's only track as well", async () => {
    const { session, output } = openHome(["solo"]);
    session.setSignals(HOME);
    await advance(11);
    const playsBefore = output.allPlays().length;
    session.pause();
    expect(vi.getTimerCount()).toBe(0);

    await advance(1000);
    expect(output.allPlays()).toHaveLength(playsBefore);

    // The silence began at about 10.1 s and ran 8 s: the first 11 s clock
    // seconds left 7 s of it.
    session.play();
    await advance(5);
    expect(output.allPlays()).toHaveLength(playsBefore);
    await advance(3);
    expect(output.allPlays().length).toBeGreaterThan(playsBefore);
    session.end();
  });

  it("leaves a stem that lands during a pause unplaced until Play", async () => {
    const { session, output, stems } = open({
      views: { ...EMPTY_VIEWS, home: ["one"] },
      tracks: ["one"],
      deferredStems: true,
    });
    session.setSignals(HOME);
    expect(stems.tracks).toHaveLength(1);

    session.pause();
    stems.land();
    await advance(5);
    expect(output.allPlays()).toEqual([]);

    session.play();
    await advance(0.1);
    expect(output.allPlays()).not.toEqual([]);
    session.end();
  });

  it("leaves a stem that fails during a pause unreported until Play", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
    const { session, stems } = open({
      views: { ...EMPTY_VIEWS, home: ["one"] },
      tracks: ["one"],
      deferredStems: true,
    });
    session.setSignals(HOME);

    session.pause();
    stems.fail();
    await advance(5);
    expect(warn).not.toHaveBeenCalled();

    session.play();
    await advance(0.1);
    expect(warn).toHaveBeenCalled();
    session.end();
  });

  it("starts nothing for signals that arrive during a pause, until Play", async () => {
    const { session, output, onSounding } = openHome(["one"]);
    session.pause();
    session.setSignals(HOME);
    await advance(20);
    expect(output.calls).toEqual([]);
    expect(onSounding).not.toHaveBeenCalled();

    session.play();
    expect(output.ramps("bus0")).toEqual([
      expect.objectContaining({
        target: 1,
        seconds: MIX_TUNING.fadeInSeconds,
      }),
    ]);
    expect(onSounding).toHaveBeenCalled();
    session.end();
  });

  it("crossfades nothing for a view change during a pause, and does at Play", async () => {
    const { session, output, onSounding } = open({
      views: { ...EMPTY_VIEWS, home: ["one"], task: ["two"] },
      tracks: ["one", "two"],
      deferredStems: false,
    });
    session.setSignals(HOME);
    await advance(3);
    session.pause();
    const calls = output.calls.length;

    session.setSignals(TASK);
    await advance(20);
    expect(output.calls).toHaveLength(calls);
    expect(output.ramps("bus1")).toEqual([]);
    expect(onSounding.mock.lastCall?.[0]?.view).toBe("home");

    session.play();
    expect(output.ramps("bus0").at(-1)).toMatchObject({
      target: 0,
      seconds: CROSSFADE_SECONDS,
    });
    expect(output.ramps("bus1")).toEqual([
      expect.objectContaining({ target: 1, seconds: CROSSFADE_SECONDS }),
    ]);
    expect(onSounding.mock.lastCall?.[0]?.view).toBe("task");
    session.end();
  });

  it("applies a director chosen during a pause at Play and not before", async () => {
    const { session, output } = openHome(["one"]);
    session.setSignals(HOME);
    await advance(1);
    session.pause();

    session.setDirector(directorHolding([1]));
    await advance(5);
    expect(output.ramps("bus0/1").every((ramp) => ramp.target === 0)).toBe(
      true,
    );

    session.play();
    expect(output.ramps("bus0/1").at(-1)).toMatchObject({ target: 1 });
    session.end();
  });

  it("leaves no duck from a chime heard during a pause", () => {
    const { session, duck } = openHome(["one"]);
    session.pause();
    session.duck(3);
    session.play();
    expect(duck).not.toHaveBeenCalled();

    session.duck(3);
    expect(duck).toHaveBeenCalledExactlyOnceWith(3);
  });
});

describe("SoundtrackSession next and previous", () => {
  /** Steers the random pick of the next skip, then back to the first other track. */
  function skipPicking(draw: Draw, pick: number, skip: () => void): void {
    draw.value = pick;
    skip();
    draw.value = 0;
  }

  it("steps back and forward along a browser-style history, and rotation clears what is ahead", async () => {
    const { session, stems, draw } = openHome(["one", "two", "three"]);
    session.setSignals(HOME);
    await advance(1);
    expect(stems.last()).toBe("one");

    // From "one" the others are [two, three]: a draw of 0.99 picks "three".
    skipPicking(draw, 0.99, () => {
      session.next();
    });
    expect(stems.last()).toBe("three");
    session.previous();
    expect(stems.last()).toBe("one");

    // Forward is where the person was, and not the pick a draw of 0 would make.
    session.next();
    expect(stems.last()).toBe("three");
    session.previous();
    expect(stems.last()).toBe("one");

    // "one" plays on and ends; rotation picks "two" (draw 0) and drops "three".
    await advance(20);
    expect(stems.last()).toBe("two");
    // Ahead is gone, and "three" is not behind either: the history is
    // [one, two], so Previous goes back to "one" and Next forward to "two".
    session.previous();
    expect(stems.last()).toBe("one");
    session.next();
    expect(stems.last()).toBe("two");
    session.end();
  });

  it.each([
    ["Next", (session: SoundtrackSession) => session.next()],
    ["Previous", (session: SoundtrackSession) => session.previous()],
  ])(
    "plays on %s while paused, and does not stay paused",
    async (_label, skip) => {
      const { session, output } = openHome(["one", "two"]);
      session.setSignals(HOME);
      await advance(3);
      session.pause();
      await advance(10);
      const calls = output.calls.length;

      skip(session);
      expect(output.calls.length).toBeGreaterThan(calls);
      // The clock runs again, which a session still paused would not do.
      const clock = output.currentTime();
      await advance(1);
      expect(output.currentTime()).toBeCloseTo(clock + 1, 2);
      session.end();
    },
  );

  it("goes back to the top of the track when nothing is earlier", async () => {
    const { session, output, stems } = openHome(["one", "two"]);
    session.setSignals(HOME);
    await advance(5);
    const loads = stems.tracks.length;

    session.previous();
    expect(stems.tracks.length).toBeGreaterThan(loads);
    expect(stems.last()).toBe("one");
    expect(output.calls.some((call) => call.gain.startsWith("bus1"))).toBe(
      false,
    );
    await advance(1);
    const position = session.end().home;
    expect(position?.trackName).toBe("one");
    expect(position?.elapsedSeconds).toBeLessThan(1.5);
  });

  it("restarts a view's only track from its top on Next", async () => {
    const { session, output, stems } = openHome(["solo"]);
    session.setSignals(HOME);
    await advance(5);
    const loads = stems.tracks.length;

    session.next();
    expect(stems.tracks.length).toBeGreaterThan(loads);
    expect(output.calls.some((call) => call.gain.startsWith("bus1"))).toBe(
      false,
    );
    await advance(1);
    expect(session.end().home?.elapsedSeconds).toBeLessThan(1.5);
  });

  it("drops the oldest track once the history is full", () => {
    const { session, stems } = openHome(["one", "two"]);
    session.setSignals(HOME);

    // Two tracks alternate, so entry n of the history is "one" when n is even.
    // The last 50 of 61 entries are kept: the oldest of them is entry 11, "two".
    const steps = MIX_TUNING.trackHistoryLength + 10;
    for (let step = 0; step < steps; step += 1) session.next();
    expect(stems.last()).toBe("one");

    for (let back = 0; back < MIX_TUNING.trackHistoryLength - 1; back += 1) {
      session.previous();
    }
    expect(stems.last()).toBe("two");

    // At the oldest kept entry, Previous restarts it: with the bound missing it
    // would step on to entry 10, "one".
    const loads = stems.tracks.length;
    session.previous();
    expect(stems.tracks.length).toBeGreaterThan(loads);
    expect(stems.last()).toBe("two");
    session.end();
  });

  it("restarts from its top a track still fading out, and its old run cannot end and rotate", async () => {
    const { session, output, stems } = openHome(["one", "two"]);
    session.setSignals(HOME);
    // "one" would end its run at 10.08 s, inside the fade out that a skip at
    // 9 s begins; Previous at 9.5 s brings it back before then.
    await advance(9);
    session.next();
    expect(stems.last()).toBe("two");
    await advance(0.5);
    session.previous();
    expect(stems.last()).toBe("one");

    await advance(5);
    // No ring-out after the restart and no start of "two" a silence later.
    const restart = output.ramps("bus0").at(-1);
    expect(restart).toMatchObject({
      target: 1,
      seconds: CROSSFADE_SECONDS,
    });
    expect(
      output
        .ramps("bus1")
        .filter((ramp) => ramp.seconds === MIX_TUNING.fadeInSeconds),
    ).toEqual([]);
    // The silence the old run's end would have begun at 10.08 s is over at
    // 18.08 s; the restarted run's own end is not until 19.6 s.
    await advance(4.4);
    expect(
      output
        .ramps("bus1")
        .filter((ramp) => ramp.seconds === MIX_TUNING.fadeInSeconds),
    ).toEqual([]);
    expect(session.end().home?.trackName).toBe("one");
  });

  describe("during the silence between tracks", () => {
    it("starts the track rotation picked at once on Next, and nothing fires afterwards", async () => {
      const { session, output, stems } = openHome(["one", "two"]);
      session.setSignals(HOME);
      await advance(11);
      expect(output.ramps("bus1")).toEqual([]);

      session.next();
      expect(output.ramps("bus1")).toEqual([
        expect.objectContaining({
          target: 1,
          seconds: MIX_TUNING.fadeInSeconds,
        }),
      ]);
      expect(stems.last()).toBe("two");

      // The silence's 8 s would end 7 s from now; "two" itself ends 10 s on.
      await advance(9);
      expect(output.ramps("bus1")).toHaveLength(1);
      expect(output.ramps("bus0").at(-1)?.target).toBe(0);
      expect(session.end().home?.trackName).toBe("two");
    });

    it("goes back to the track that just ended on Previous, and nothing fires afterwards", async () => {
      const { session, output, stems } = openHome(["one", "two"]);
      session.setSignals(HOME);
      await advance(11);

      session.previous();
      expect(output.ramps("bus0").at(-1)).toMatchObject({
        target: 1,
        seconds: CROSSFADE_SECONDS,
      });
      expect(stems.last()).toBe("one");

      await advance(9);
      expect(output.ramps("bus1")).toEqual([]);
      expect(session.end().home?.trackName).toBe("one");
    });

    it("restarts a view's only track from its top on Next, and its silence's own start does not fire", async () => {
      const { session, output, stems } = openHome(["solo"]);
      session.setSignals(HOME);
      await advance(11);
      const loads = stems.tracks.length;

      session.next();
      expect(stems.tracks.length).toBeGreaterThan(loads);
      expect(output.ramps("bus0").at(-1)).toMatchObject({
        target: 1,
        seconds: CROSSFADE_SECONDS,
      });
      const ramps = output.ramps("bus0").length;

      // The silence's 8 s would end 7 s from now; the new run lasts 10 s.
      await advance(9);
      expect(output.ramps("bus0")).toHaveLength(ramps);
      session.end();
    });
  });

  it("stops the track a skip is fading out when the session ends in the crossfade", async () => {
    const { session, close } = openHome(["one", "two"]);
    session.setSignals(HOME);
    await advance(1);
    session.next();
    await advance(0.5);

    session.end();
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
