/**
 * The timers of the real `openWebAudioPorts` (the suspend after a pause's fade
 * and the close), over a fake `AudioContext` and fake timers. What the real
 * clock does when suspended is `browser-tests/soundtrack-output.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import type { ClockRequests, MixTap } from "../mix-capture";
import { MIX_TUNING } from "../mix-tuning";
import type { MixCapture, RecordingQuality } from "../recording";
import type { SoundtrackPorts } from "../session";
import { openWebAudioPorts } from "../web-audio-ports";

// The wait past the fade that `web-audio-ports.ts` keeps before it suspends or
// closes, for what is still on its way to the speakers. It is private there.
// What `captureMix` opens a capture with, which the real one would build nodes
// from; only the arguments are read here.
const capture = vi.hoisted(() => ({
  opened:
    vi.fn<
      (
        context: AudioContext,
        tap: MixTap,
        clock: ClockRequests,
        quality: RecordingQuality,
      ) => Promise<MixCapture>
    >(),
}));
vi.mock("../mix-capture", () => ({ openMixCapture: capture.opened }));

const NO_CAPTURE: MixCapture = {
  sampleRate: 48_000,
  audioOffsetSeconds: 0,
  start: () => undefined,
  stop: () => Promise.resolve({ frames: null, droppedFrames: null }),
};

const DRAIN_AFTER_FADE_SECONDS = 0.5;
const SUSPEND_AFTER_MS =
  (MIX_TUNING.pauseFadeSeconds + DRAIN_AFTER_FADE_SECONDS) * 1000;

interface RampTo {
  readonly value: number;
  readonly endTime: number;
}

class FakeParam {
  value = 1;
  readonly ramps: RampTo[] = [];

  cancelAndHoldAtTime(_cancelTime: number): void {}
  cancelScheduledValues(_cancelTime: number): void {}
  setValueAtTime(_value: number, _startTime: number): void {}
  linearRampToValueAtTime(value: number, endTime: number): void {
    this.ramps.push({ value, endTime });
  }
  exponentialRampToValueAtTime(_value: number, _endTime: number): void {}
}

class FakeGainNode {
  readonly gain = new FakeParam();
  connect(_destination: unknown): void {}
}

class FakeFilterNode {
  type = "lowpass";
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  connect(_destination: unknown): void {}
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];
  readonly currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  readonly destination = {};
  /** In the order made: the pause's own gain is the first. */
  readonly gains: FakeGainNode[] = [];
  readonly suspend = vi.fn<() => Promise<void>>(() => {
    this.state = "suspended";
    return Promise.resolve();
  });
  readonly resume = vi.fn<() => Promise<void>>(() => {
    this.state = "running";
    return Promise.resolve();
  });
  readonly close = vi.fn<() => Promise<void>>(() => {
    this.state = "closed";
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter(): FakeFilterNode {
    return new FakeFilterNode();
  }
}

function openPorts(): {
  readonly ports: SoundtrackPorts;
  readonly context: FakeAudioContext;
} {
  const ports = openWebAudioPorts({ tracks: [] }, 1);
  const [context] = FakeAudioContext.instances;
  return { ports, context };
}

/** What a port's owner passes to `resume`; it is only ever read for its calls. */
const onRefused = vi.fn<() => void>();

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  onRefused.mockClear();
  capture.opened.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openWebAudioPorts pause", () => {
  it("suspends the context once, after the fade and the drain and not before", async () => {
    const { ports, context } = openPorts();

    ports.pause();
    await advance(SUSPEND_AFTER_MS - 1);
    expect(context.suspend).not.toHaveBeenCalled();

    await advance(1);
    expect(context.suspend).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(context.suspend).toHaveBeenCalledTimes(1);
  });

  it("is not suspended by a resume inside the wait, and resumes the context", async () => {
    const { ports, context } = openPorts();

    ports.pause();
    await advance(SUSPEND_AFTER_MS / 2);
    ports.resume(() => undefined);
    await advance(10_000);

    expect(context.suspend).not.toHaveBeenCalled();
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("is not suspended once the device is closed inside the wait", async () => {
    const { ports, context } = openPorts();

    ports.pause();
    await advance(SUSPEND_AFTER_MS / 2);
    ports.close(MIX_TUNING.stopFadeSeconds);
    await advance(10_000);

    expect(context.suspend).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("resumes a context it has suspended", async () => {
    const { ports, context } = openPorts();
    ports.pause();
    await advance(SUSPEND_AFTER_MS);
    expect(context.suspend).toHaveBeenCalledTimes(1);

    ports.resume(() => undefined);
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("fades the pause's own gain out on pause and back up on resume", () => {
    const { ports, context } = openPorts();
    const audible = context.gains[0].gain;

    ports.pause();
    expect(audible.ramps.at(-1)).toEqual({
      value: 0,
      endTime: MIX_TUNING.pauseFadeSeconds,
    });

    ports.resume(() => undefined);
    expect(audible.ramps.at(-1)).toEqual({
      value: 1,
      endTime: MIX_TUNING.pauseFadeSeconds,
    });
  });

  it("does not report a refusal when the context resumes", async () => {
    const { ports, context } = openPorts();
    ports.pause();
    await advance(SUSPEND_AFTER_MS);

    ports.resume(onRefused);
    await advance(0);

    expect(context.state).toBe("running");
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("reports a refusal once, and logs it, when the context will not resume", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockReturnValue(undefined);
    const { ports, context } = openPorts();
    ports.pause();
    await advance(SUSPEND_AFTER_MS);
    context.resume.mockImplementationOnce(() =>
      Promise.reject(new Error("blocked by autoplay")),
    );

    ports.resume(onRefused);
    await advance(0);

    expect(context.state).toBe("suspended");
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("openWebAudioPorts clock requests", () => {
  it("runs a capture's start listeners ahead of the context's resume, and not after it unlistens", async () => {
    capture.opened.mockResolvedValue(NO_CAPTURE);
    const { ports, context } = openPorts();
    await ports.captureMix("compressed");
    const clock = capture.opened.mock.calls[0][2];
    const listener = vi.fn<() => void>();
    const unlisten = clock.onStart(listener);

    ports.pause();
    await advance(SUSPEND_AFTER_MS);
    ports.resume(() => undefined);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.invocationCallOrder[0]).toBeLessThan(
      context.resume.mock.invocationCallOrder[0],
    );

    unlisten();
    ports.pause();
    ports.resume(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it("asks for a stop only from the moment the suspend is issued until the resume", async () => {
    capture.opened.mockResolvedValue(NO_CAPTURE);
    const { ports, context } = openPorts();
    await ports.captureMix("compressed");
    const clock = capture.opened.mock.calls[0][2];
    expect(clock.stopAsked()).toBe(false);

    ports.pause();
    expect(clock.stopAsked()).toBe(false);
    await advance(SUSPEND_AFTER_MS);
    expect(context.suspend).toHaveBeenCalledTimes(1);
    expect(clock.stopAsked()).toBe(true);

    ports.resume(() => undefined);
    expect(clock.stopAsked()).toBe(false);
  });
});
