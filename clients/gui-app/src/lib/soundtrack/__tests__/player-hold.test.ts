/**
 * `TrackPlayer.hold` on its own: the output's clock is never stopped here, so
 * what stays still is the player's doing and not the clock's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import { TrackPlayer } from "../player";
import type { VariableTrack } from "../variable-sound";
import type { StemSource } from "../stems";
import { FakeOutput, FakeStems } from "./fakes";

const LENGTH_SECONDS = 10;

/** One layer playing at 3 s and every 6 s after, through a track of 10 s. */
function oneLayerTrack(): VariableTrack {
  return {
    name: "held",
    title: "Held",
    lengthSeconds: LENGTH_SECONDS,
    alignmentSeconds: 0.5,
    layers: [
      {
        name: "A",
        variants: 1,
        role: null,
        sublayers: 1,
        sublayerStartingOffset: null,
        pan: null,
      },
    ],
    states: [
      {
        name: "only",
        layersProperties: [
          {
            enabled: null,
            startPause: [3, 3],
            sequenceLength: [1, 1],
            pauseBetweenSamples: [0, 0],
            pauseBetweenRepetitions: [0, 0],
            playsPerRun: null,
          },
        ],
        numberOfEnabledLayers: [1, 1],
      },
    ],
    intro: null,
    outro: null,
    phases: [],
  };
}

function playerOver(output: FakeOutput, stems: StemSource) {
  const onRunEnd = vi.fn<(silenceSeconds: number) => void>();
  const player = new TrackPlayer({
    track: oneLayerTrack(),
    output,
    stems,
    random: () => 0,
    silenceSeconds: [5, 5],
    resumeAt: 0,
    onRunStart: () => undefined,
    onRunEnd,
  });
  return { player, onRunEnd };
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

describe("TrackPlayer hold", () => {
  it("places nothing and ends no run while held, with the output's clock still running, and goes on at release", async () => {
    const output = new FakeOutput();
    const { player, onRunEnd } = playerOver(output, new FakeStems(2));
    player.start(0, 0.1);
    await advance(1);
    player.hold();
    const callsAtHold = output.calls.length;
    expect(vi.getTimerCount()).toBe(0);

    // The first sample is due at 3 s and the run ends past 10 s.
    await advance(60);
    expect(output.calls).toHaveLength(callsAtHold);
    expect(output.allPlays()).toEqual([]);
    expect(onRunEnd).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    player.release();
    await advance(0.5);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
  });

  it("holds a load that lands meanwhile until release, and places it then", async () => {
    const output = new FakeOutput();
    const stems = new FakeStems(2);
    stems.holdLayer("A");
    const { player } = playerOver(output, stems);
    player.start(0, 0.1);
    // The first sample is requested a lookahead before its 3 s.
    await advance(2.8);
    expect(stems.requests).toEqual(["A/1"]);

    player.hold();
    stems.releaseLayer("A");
    await advance(0.1);
    expect(output.allPlays()).toEqual([]);

    player.release();
    await advance(0.1);
    expect(output.allPlays()).toHaveLength(1);
  });

  it("holds a load that fails meanwhile until release, and reports it then", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
    const output = new FakeOutput();
    // `FakeStems` decides to fail when a load is asked for; this one fails a
    // load that is already on its way.
    const requested: Array<(error: Error) => void> = [];
    const stems: StemSource = {
      load: () =>
        new Promise<AudioBuffer>((_resolve, reject) => {
          requested.push(reject);
        }),
    };
    const { player } = playerOver(output, stems);
    player.start(0, 0.1);
    await advance(2.8);
    expect(requested).toHaveLength(1);

    player.hold();
    requested[0](new Error("no such stem"));
    await advance(0.1);
    expect(warn).not.toHaveBeenCalled();

    player.release();
    await advance(0.1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(output.allPlays()).toEqual([]);
  });
});
