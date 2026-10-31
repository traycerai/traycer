import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEAKING_RMS, watchAudioLevel } from "../audio-level";

const level = { value: 0 };
const close = vi.fn<() => Promise<void>>(() => Promise.resolve());

class FakeAudioContext {
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      getFloatTimeDomainData: (samples: Float32Array) => {
        samples.fill(level.value);
      },
    };
  }
  close = close;
}

const stream = {} as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
  level.value = 0;
  close.mockClear();
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watchAudioLevel", () => {
  it("reports speaking while the level is up and quiet after the hangover", () => {
    const reports: boolean[] = [];
    const watch = watchAudioLevel(stream, (speaking) => reports.push(speaking));
    expect(watch.available).toBe(true);

    level.value = SPEAKING_RMS * 5;
    vi.advanceTimersByTime(200);
    expect(reports).toEqual([true]);

    level.value = 0;
    vi.advanceTimersByTime(1_000);
    expect(reports).toEqual([true, false]);
    watch.stop();
  });

  it("reports quiet on stop when it last reported speaking, and nothing after", () => {
    const reports: boolean[] = [];
    const watch = watchAudioLevel(stream, (speaking) => reports.push(speaking));
    level.value = SPEAKING_RMS * 5;
    vi.advanceTimersByTime(200);
    expect(reports).toEqual([true]);

    watch.stop();
    expect(reports).toEqual([true, false]);
    expect(close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    watch.stop();
    expect(reports).toEqual([true, false]);
  });

  it("reports nothing on stop when it never spoke", () => {
    const reports: boolean[] = [];
    const watch = watchAudioLevel(stream, (speaking) => reports.push(speaking));
    watch.stop();
    expect(reports).toEqual([]);
  });

  it("is unavailable when the browser refuses the audio context", () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    const reports: boolean[] = [];
    const watch = watchAudioLevel(stream, (speaking) => reports.push(speaking));

    expect(watch.available).toBe(false);
    watch.stop();
    expect(reports).toEqual([]);
  });
});
