import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEAKING_RMS, watchAudioLevel } from "../audio-level";

const level = { value: 0 };
const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
const resume = vi.fn<() => Promise<void>>(() => Promise.resolve());
const contextState = { value: "running" };

class FakeAudioContext {
  get state(): string {
    return contextState.value;
  }
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
  resume = resume;
}

const stream = {} as MediaStream;

interface Reports {
  readonly speaking: boolean[];
  readonly healthy: boolean[];
}

function watch(): { reports: Reports; stop: () => void } {
  const reports: Reports = { speaking: [], healthy: [] };
  const handle = watchAudioLevel(
    stream,
    (speaking) => reports.speaking.push(speaking),
    (healthy) => reports.healthy.push(healthy),
  );
  return { reports, stop: () => handle.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
  level.value = 0;
  contextState.value = "running";
  close.mockClear();
  resume.mockClear();
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watchAudioLevel", () => {
  it("reports speaking while the level is up and quiet after the hangover", () => {
    const { reports, stop } = watch();

    level.value = SPEAKING_RMS * 5;
    vi.advanceTimersByTime(200);
    expect(reports.speaking).toEqual([true]);

    level.value = 0;
    vi.advanceTimersByTime(1_000);
    expect(reports.speaking).toEqual([true, false]);
    stop();
  });

  it("reports quiet and unhealthy on stop when it last reported speaking, and nothing after", () => {
    const { reports, stop } = watch();
    level.value = SPEAKING_RMS * 5;
    vi.advanceTimersByTime(200);
    expect(reports.speaking).toEqual([true]);
    expect(reports.healthy).toEqual([false, true]);

    stop();
    expect(reports.speaking).toEqual([true, false]);
    expect(reports.healthy).toEqual([false, true, false]);
    expect(close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    stop();
    expect(reports.speaking).toEqual([true, false]);
  });

  it("reports nothing speaking on stop when it never spoke", () => {
    const { reports, stop } = watch();
    stop();
    expect(reports.speaking).toEqual([]);
  });

  it("is not healthy when the browser refuses the audio context", () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    const { reports, stop } = watch();

    expect(reports.healthy).toEqual([false]);
    stop();
    expect(reports.speaking).toEqual([]);
  });

  it("never reports healthy for a suspended context reading silence, and resumes it", () => {
    contextState.value = "suspended";
    const { reports, stop } = watch();

    vi.advanceTimersByTime(2_000);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(reports.healthy).toEqual([false]);
    stop();
  });

  it("reports healthy on the first non-zero sample of a running context", () => {
    const { reports, stop } = watch();
    vi.advanceTimersByTime(500);
    expect(reports.healthy).toEqual([false]);

    level.value = 0.001;
    vi.advanceTimersByTime(100);
    expect(reports.healthy).toEqual([false, true]);
    stop();
  });
});
