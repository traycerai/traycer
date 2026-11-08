/**
 * What the decision log says of Pause, Play, Next and Previous, over the real
 * session and players behind the fake ports. Tracks last 10 s, and the silence
 * after a run is 8 s (the draw is 0).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MixDirector } from "../directors";
import type { SoundtrackManifest } from "../manifest";
import { SoundtrackSession, type SoundtrackPorts } from "../session";
import { SoundtrackLogRelay, type SoundtrackLogEvent } from "../session-log";
import type { MixSignals } from "../signals";
import { captureNothing, FakeOutput, FakeStems } from "./fakes";
import { playbackTrack } from "./playback-track";

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};
const TASK: MixSignals = { ...HOME, view: "task" };

const STATIC_PLAN: MixDirector = {
  plan: (_signals, context) => ({
    state: null,
    enabledLayerCount: null,
    heldLayers: [],
    pauseMultiplier: 1,
    layerGains: context.track.layers.map(() => 1),
    dim: false,
  }),
};

interface Opened {
  readonly session: SoundtrackSession;
  readonly output: FakeOutput;
  readonly events: SoundtrackLogEvent[];
  /** What the log and the refusal callback said, in the order they happened. */
  readonly order: string[];
  /** The `onRefused` each Play handed the ports, oldest first. */
  readonly refusals: (() => void)[];
}

function open(
  home: readonly string[],
  task: readonly string[],
  listening: boolean,
): Opened {
  const relay = new SoundtrackLogRelay();
  const events: SoundtrackLogEvent[] = [];
  const order: string[] = [];
  if (listening) {
    relay.listen((event) => {
      events.push(event);
      if (event.type === "pause" && event.cause === "refused-resume") {
        order.push("log:pause-refused");
      }
    });
  }
  const output = new FakeOutput();
  const refusals: (() => void)[] = [];
  const ports: SoundtrackPorts = {
    output,
    stems: new FakeStems(2.2),
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck: () => undefined,
    close: () => undefined,
    log: relay,
    captureMix: captureNothing,
    pause: () => {
      output.stopClock();
    },
    resume: (onRefused) => {
      refusals.push(onRefused);
      output.startClock();
    },
  };
  const session = new SoundtrackSession({
    manifest: {
      tracks: [...new Set([...home, ...task])].map((name) =>
        playbackTrack(name, 10),
      ),
      views: { home, task, bot: [], settings: [] },
      stems: { tracks: [] },
    } satisfies SoundtrackManifest,
    ports,
    random: () => 0,
    director: STATIC_PLAN,
    resumePositions: {},
    onSounding: () => undefined,
    onResumeRefused: () => {
      order.push("callback");
    },
  });
  return { session, output, events, order, refusals };
}

/** The tracks `home` has: `tracks`, and signals on `home`. */
function openHome(tracks: readonly string[]): Opened {
  const opened = open(tracks, [], true);
  opened.session.setSignals(HOME);
  return opened;
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

function skips(events: readonly SoundtrackLogEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "skip"
      ? [`${event.direction}:${event.to}:${event.cause}`]
      : [],
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the log of Pause and Play", () => {
  it("writes pause and play, cause person, at the audio clock's time, which a pause holds", async () => {
    const { session, events } = openHome(["one"]);
    await advance(3);
    session.pause();
    await advance(50);
    session.play();

    const marks = events.filter(
      (event) => event.type === "pause" || event.type === "play",
    );
    expect(marks).toEqual([
      { type: "pause", t: 3, cause: "person" },
      { type: "play", t: 3, cause: "person" },
    ]);
    session.end();
  });

  it.each(["next", "previous"] as const)(
    "writes play cause skip and then the skip when %s wakes a paused session",
    async (direction) => {
      const { session, events } = openHome(["one", "two"]);
      await advance(3);
      session.pause();
      events.length = 0;

      session[direction]();

      expect(
        events.flatMap((event) =>
          event.type === "play" || event.type === "skip" ? [event.type] : [],
        ),
      ).toEqual(["play", "skip"]);
      expect(events.find((event) => event.type === "play")).toMatchObject({
        cause: "skip",
      });
      session.end();
    },
  );
});

describe("the log of Next and Previous", () => {
  it("says pick for a track drawn from the pool", async () => {
    const { session, events } = openHome(["one", "two"]);
    await advance(3);

    session.next();

    expect(skips(events)).toEqual(["next:two:pick"]);
    session.end();
  });

  it("says history for the tracks Previous went back over, forward and back", async () => {
    const { session, events } = openHome(["one", "two"]);
    await advance(3);
    session.next();
    await advance(1);

    session.previous();
    await advance(1);
    session.next();
    await advance(1);
    session.previous();

    expect(skips(events)).toEqual([
      "next:two:pick",
      "previous:one:history",
      "next:two:history",
      "previous:one:history",
    ]);
    session.end();
  });

  it("says restart for a Next with one track and a Previous with none earlier", async () => {
    const { session, events } = openHome(["solo"]);
    await advance(3);

    session.next();
    await advance(1);
    session.previous();

    expect(skips(events)).toEqual([
      "next:solo:restart",
      "previous:solo:restart",
    ]);
    session.end();
  });

  it("says silence for a Next in the silence between two tracks", async () => {
    const { session, events } = openHome(["one", "two"]);
    // The run ends at about 10.1 s and the silence lasts 8 s.
    await advance(12);

    session.next();

    expect(skips(events)).toEqual(["next:two:silence"]);
    session.end();
  });

  it("writes the skip ahead of the cancels and the run it causes", async () => {
    const { session, events } = openHome(["solo"]);
    // The second sample is placed at 6 s for 6.55 s, ahead of the clock.
    await advance(6.2);
    events.length = 0;

    session.next();

    const types = events.map((event) => event.type);
    const skip = types.indexOf("skip");
    const cancel = types.indexOf("sample-cancel");
    const start = types.indexOf("run-start");
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeGreaterThan(skip);
    expect(start).toBeGreaterThan(cancel);
    session.end();
  });

  it("writes nothing for any of it while nobody listens", async () => {
    const quiet = open(["one", "two"], ["two"], false);
    const writes: SoundtrackLogEvent[] = [];
    const log = quiet.session.ports.log;
    const spy = vi.spyOn(log, "write").mockImplementation((event) => {
      writes.push(event);
    });

    quiet.session.setSignals(HOME);
    await advance(3);
    quiet.session.pause();
    quiet.session.setSignals(TASK);
    quiet.session.play();
    quiet.session.next();
    quiet.session.previous();
    quiet.session.logNow();
    quiet.session.end();

    expect(log.listening()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("the log of a refused Play", () => {
  it("writes pause cause refused-resume ahead of the refusal callback", async () => {
    const { session, events, order, refusals } = openHome(["one"]);
    await advance(2);
    session.pause();
    session.play();

    refusals[0]();

    expect(order).toEqual(["log:pause-refused", "callback"]);
    expect(events.at(-1)).toMatchObject({
      type: "pause",
      cause: "refused-resume",
    });
    session.end();
  });

  it("writes nothing and calls nothing for a refusal a later pause has superseded", async () => {
    const { session, events, order, refusals } = openHome(["one"]);
    await advance(2);
    session.pause();
    session.play();
    session.pause();
    const logged = events.length;

    refusals[0]();

    expect(events).toHaveLength(logged);
    expect(order).toEqual([]);
    session.end();
  });
});

describe("logNow during a pause", () => {
  it("says paused, and keeps the view in front when signals moved on meanwhile", async () => {
    const opened = open(["one"], ["two"], true);
    opened.session.setSignals(HOME);
    await advance(2);
    opened.session.pause();
    opened.session.setSignals(TASK);
    opened.events.length = 0;

    opened.session.logNow();

    expect(opened.events.find((event) => event.type === "sounding")).toEqual(
      expect.objectContaining({ view: "home", paused: true }),
    );
    expect(opened.events.find((event) => event.type === "signals")).toEqual(
      expect.objectContaining({ view: "task" }),
    );
    opened.session.end();
  });
});
