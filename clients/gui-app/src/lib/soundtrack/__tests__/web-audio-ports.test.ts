/**
 * The timers of the real `openWebAudioPorts` (the suspend after a pause's fade
 * and the close), over a fake `AudioContext` and fake timers. What the real
 * clock does when suspended is `browser-tests/soundtrack-output.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import type { MixTap } from "../mix-capture";
import { MIX_TUNING } from "../mix-tuning";
import type { MixCapture, RecordingQuality } from "../recording";
import type { SoundtrackPorts } from "../session";
import { openWebAudioPorts } from "../web-audio-ports";

// What `captureMix` opens a capture with, which the real one would build nodes
// from; only the arguments are read here.
const capture = vi.hoisted(() => ({
  opened:
    vi.fn<
      (
        context: AudioContext,
        tap: MixTap,
        quality: RecordingQuality,
      ) => Promise<MixCapture>
    >(),
}));
vi.mock("../mix-capture", () => ({ openMixCapture: capture.opened }));

const MIX_SAMPLE_RATE = 48_000;
// Deliberately NOT `MIX_SAMPLE_RATE`: a context the real constructor call
// never asked for a rate from would come back at this rate instead, so the
// "opens at the recording's rate" test can actually fail if production stops
// requesting it. If this matched `MIX_SAMPLE_RATE`, that test would pass
// whether or not `openWebAudioPorts` ever passed a `sampleRate` option.
const DEFAULT_FAKE_SAMPLE_RATE = 44_100;

const NO_CAPTURE: MixCapture = {
  sampleRate: 48_000,
  audioOffsetSeconds: 0,
  start: () => undefined,
  stop: () => Promise.resolve({ frames: null, droppedFrames: null }),
};

// The wait past the fade that `web-audio-ports.ts` keeps before it suspends or
// closes, for what is still on its way to the speakers. It is private there.
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
  readonly sampleRate: number;
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

  constructor(options: { readonly sampleRate: number } | undefined) {
    this.sampleRate = options?.sampleRate ?? DEFAULT_FAKE_SAMPLE_RATE;
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

describe("openWebAudioPorts captureMix", () => {
  it("opens the context at the recording's rate, so a captured frame and an encoded sample are the same thing", () => {
    const { context } = openPorts();
    expect(context.sampleRate).toBe(MIX_SAMPLE_RATE);
  });

  it("opens a capture with the context and a tap, and nothing else", async () => {
    capture.opened.mockResolvedValue(NO_CAPTURE);
    const { ports, context } = openPorts();
    await ports.captureMix("compressed");

    expect(capture.opened).toHaveBeenCalledTimes(1);
    const [calledContext, , quality] = capture.opened.mock.calls[0];
    expect(calledContext).toBe(context);
    expect(quality).toBe("compressed");
  });
});
