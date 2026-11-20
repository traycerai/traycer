import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIX_TUNING } from "../mix-tuning";
import { TrackPlayer } from "../player";
import {
  SoundtrackLogRelay,
  type SoundtrackLog,
  type SoundtrackLogEvent,
} from "../session-log";
import type { StemSource } from "../stems";
import type {
  Bookend,
  Layer,
  LayerProperties,
  VariableTrack,
} from "../variable-sound";
import { makeAudioBuffer } from "./audio-buffer";
import { FakeOutput } from "./fakes";

const LENGTH_SECONDS = 10;
const OUTRO: Bookend = { name: "O", variants: 1, pan: null };

const PROPERTIES: LayerProperties = {
  enabled: null,
  startPause: [3, 3],
  sequenceLength: [1, 1],
  pauseBetweenSamples: [0, 0],
  pauseBetweenRepetitions: [0, 0],
  playsPerRun: null,
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

function buildTrack(outro: Bookend | null): VariableTrack {
  return {
    name: "logged",
    title: "Logged",
    lengthSeconds: LENGTH_SECONDS,
    alignmentSeconds: 0.5,
    layers: [layerOf("A"), layerOf("B")],
    states: [
      {
        name: "only",
        layersProperties: [PROPERTIES, PROPERTIES],
        numberOfEnabledLayers: [2, 2],
      },
    ],
    intro: null,
    outro,
    phases: [],
  };
}

const STEMS: StemSource = {
  load: (_track, layer) =>
    Promise.resolve(makeAudioBuffer(layer.name === "O" ? 3 : 6, 10)),
};

function playerOn(
  track: VariableTrack,
  log: SoundtrackLog,
): { player: TrackPlayer; output: FakeOutput } {
  const output = new FakeOutput();
  const player = new TrackPlayer({
    track,
    output,
    stems: STEMS,
    random: () => 0,
    log,
    silenceSeconds: [5, 5],
    resumeAt: 0,
    onRunStart: () => undefined,
    onRunEnd: () => undefined,
  });
  return { player, output };
}

function loggedPlayer(track: VariableTrack): {
  player: TrackPlayer;
  events: SoundtrackLogEvent[];
} {
  const relay = new SoundtrackLogRelay();
  const events: SoundtrackLogEvent[] = [];
  relay.listen((event) => events.push(event));
  return { player: playerOn(track, relay).player, events };
}

/** Layer A starts at 3 s and layer B at 8 s; each sample lasts 6 s. */
function staggeredTrack(): VariableTrack {
  const track = buildTrack(null);
  const [first] = track.states;
  return {
    ...track,
    states: [
      {
        ...first,
        layersProperties: [PROPERTIES, { ...PROPERTIES, startPause: [8, 8] }],
      },
    ],
  };
}

/** A second state to move to, with the layers as they were. */
function twoStateTrack(): VariableTrack {
  const track = buildTrack(null);
  const [first] = track.states;
  return { ...track, states: [first, { ...first, name: "other" }] };
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TrackPlayer's decision log", () => {
  it("writes a run with an outro in order: run-start, samples, outro fade, run-end", async () => {
    const { player, events } = loggedPlayer(buildTrack(OUTRO));
    player.start(0, 0.1);
    await advance(14);

    const arc = events
      .filter((event) => event.type !== "track-gain")
      .map((event) => {
        if (event.type === "sample")
          return `sample:${event.layer}:${String(event.role)}`;
        if (event.type === "layer-gain")
          return `layer-gain:${event.layer}:${event.cause}`;
        return event.type;
      });
    expect(arc).toEqual([
      "run-start",
      "layer-gain:A:restore",
      "layer-gain:B:restore",
      "sample:A:null",
      "sample:B:null",
      "sample:A:null",
      "sample:B:null",
      "sample:O:outro",
      "layer-gain:A:outro-fade",
      "layer-gain:B:outro-fade",
      "run-end",
    ]);
    expect(events.find((event) => event.type === "run-start")).toMatchObject({
      track: "logged",
      state: "only",
    });
    expect(events.find((event) => event.type === "run-end")).toMatchObject({
      ending: "outro",
      fade: MIX_TUNING.outroRingOutSeconds,
      silence: 5,
    });
  });

  it("ends a track with no outro as rang-out once the last sample has played", async () => {
    const { player, events } = loggedPlayer(buildTrack(null));
    player.start(0, 0.1);
    await advance(20);

    const ends = events.filter((event) => event.type === "run-end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      ending: "rang-out",
      fade: MIX_TUNING.ringOutFadeSeconds,
      silence: 5,
    });
  });

  it("writes a sample-cancel after the sample when a stop cuts it before it started", async () => {
    const { player, events } = loggedPlayer(buildTrack(null));
    player.start(0, 0.1);
    // The first samples are placed ahead of their start at 3 s.
    await advance(2.95);
    player.stop(1);

    const arc = events.flatMap((event) =>
      event.type === "sample" || event.type === "sample-cancel"
        ? [
            `${event.type}:${event.layer}:${String(event.variant)}:${String(event.start)}`,
          ]
        : [],
    );
    expect(arc).toEqual([
      "sample:A:1:3.05",
      "sample:B:1:3.05",
      "sample-cancel:A:1:3.05",
      "sample-cancel:B:1:3.05",
    ]);
  });

  it("writes nothing, and builds no event, while no one listens", async () => {
    const writes: SoundtrackLogEvent[] = [];
    const quiet: SoundtrackLog = {
      listening: () => false,
      write: (event) => {
        writes.push(event);
      },
    };
    const { player, output } = playerOn(twoStateTrack(), quiet);

    player.start(0, 0.1);
    await advance(4);
    player.enterState("other");
    player.setLayerTarget(0, 0.5);
    player.setLayerEnabled(1, false);
    await advance(1);
    player.stop(1);

    expect(output.allPlays().length).toBeGreaterThan(0);
    expect(output.ramps("bus0/0").length).toBeGreaterThan(1);
    expect(writes).toEqual([]);
  });

  it("writes a layer-gain only for the layers whose gain moves", async () => {
    const { player, events } = loggedPlayer(buildTrack(null));
    player.start(0, 0.1);
    await advance(1);
    player.setLayerEnabled(1, false);
    events.length = 0;

    // B is off, so a new target moves nothing; A's moves.
    player.setLayerTarget(1, 0.5);
    player.setLayerTarget(0, 0.5);

    expect(events).toEqual([
      expect.objectContaining({
        type: "layer-gain",
        layer: "A",
        target: 0.5,
        cause: "director",
      }),
    ]);
  });

  it("cancels only the samples that had not started when it stopped", async () => {
    const { player, events } = loggedPlayer(staggeredTrack());
    player.start(0, 0.1);
    // A's sample sounds from 3.05 s; B's is placed for 8.05 s.
    await advance(7.8);
    player.stop(1);

    const cancels = events.filter((event) => event.type === "sample-cancel");
    expect(cancels).toEqual([
      expect.objectContaining({ layer: "B", start: 8.05 }),
    ]);
  });
});
