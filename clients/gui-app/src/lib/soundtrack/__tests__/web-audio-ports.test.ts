/**
 * The timers of the real `openWebAudioPorts` (the suspend after a pause's fade
 * and the close), over a fake `AudioContext` and fake timers. What the real
 * clock does when suspended is `browser-tests/soundtrack-output.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIX_TUNING } from "../mix-tuning";
import type { SoundtrackPorts } from "../session";
import { openWebAudioPorts } from "../web-audio-ports";

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
  readonly state = "running";
  readonly destination = {};
  /** In the order made: the pause's own gain is the first. */
  readonly gains: FakeGainNode[] = [];
  readonly suspend = vi.fn<() => Promise<void>>(() => Promise.resolve());
  readonly resume = vi.fn<() => Promise<void>>(() => Promise.resolve());
  readonly close = vi.fn<() => Promise<void>>(() => Promise.resolve());

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

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
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
    ports.resume();
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

    ports.resume();
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

    ports.resume();
    expect(audible.ramps.at(-1)).toEqual({
      value: 1,
      endTime: MIX_TUNING.pauseFadeSeconds,
    });
  });
});
