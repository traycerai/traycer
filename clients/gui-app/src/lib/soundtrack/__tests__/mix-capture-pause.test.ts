/**
 * When the compressed capture pauses its recorder, over the real
 * `openWebAudioPorts` and the real `captureMix("compressed")`, with a context
 * whose state and `statechange` this test drives. The context reports a
 * suspension late, which is what is under test; the real clock is
 * `browser-tests/soundtrack-recording.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIX_TUNING } from "../mix-tuning";
import type { MixCapture } from "../recording";
import type { SoundtrackPorts } from "../session";
import { openWebAudioPorts } from "../web-audio-ports";

// The wait past the fade that `web-audio-ports.ts` keeps before it suspends.
const DRAIN_AFTER_FADE_SECONDS = 0.5;
const SUSPEND_AFTER_MS =
  (MIX_TUNING.pauseFadeSeconds + DRAIN_AFTER_FADE_SECONDS) * 1000;

class FakeParam {
  value = 1;
  cancelAndHoldAtTime(_cancelTime: number): void {}
  cancelScheduledValues(_cancelTime: number): void {}
  setValueAtTime(_value: number, _startTime: number): void {}
  linearRampToValueAtTime(_value: number, _endTime: number): void {}
  exponentialRampToValueAtTime(_value: number, _endTime: number): void {}
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  type = "lowpass";
  channelCount = 2;
  readonly stream = { getTracks: (): { stop: () => void }[] => [] };
  connect(_destination: unknown): void {}
  disconnect(_destination: unknown): void {}
}

type ContextState = "running" | "suspended";

class FakeAudioContext extends EventTarget {
  static readonly instances: FakeAudioContext[] = [];
  readonly currentTime = 0;
  readonly sampleRate = 48_000;
  state: ContextState = "running";
  readonly destination = {};
  readonly suspend = vi.fn<() => Promise<void>>(() => Promise.resolve());
  readonly resume = vi.fn<() => Promise<void>>(() => Promise.resolve());

  constructor() {
    super();
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeNode {
    return new FakeNode();
  }

  createBiquadFilter(): FakeNode {
    return new FakeNode();
  }

  createMediaStreamDestination(): FakeNode {
    return new FakeNode();
  }

  /** What the browser does some time after a suspend or a resume. */
  report(state: ContextState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeConstantSource extends FakeNode {
  start(): void {}
  stop(): void {}
}

class FakeMediaRecorder extends EventTarget {
  static readonly instances: FakeMediaRecorder[] = [];
  state: "inactive" | "recording" | "paused" = "inactive";
  readonly pause = vi.fn<() => void>(() => {
    this.refuseIfInactive();
    this.state = "paused";
  });
  readonly resume = vi.fn<() => void>(() => {
    this.refuseIfInactive();
    this.state = "recording";
  });

  constructor() {
    super();
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
  }

  private refuseIfInactive(): void {
    if (this.state === "inactive") throw new Error("InvalidStateError");
  }
}

interface Opened {
  readonly ports: SoundtrackPorts;
  readonly context: FakeAudioContext;
  readonly recorder: FakeMediaRecorder;
  readonly capture: MixCapture;
}

/** Ports and a compressed capture started on a running context. */
async function openCapturing(): Promise<Opened> {
  const ports = openWebAudioPorts({ tracks: [] }, 1);
  const capture = await ports.captureMix("compressed");
  capture.start({
    onFirstFrame: () => undefined,
    onChunk: () => undefined,
    onError: () => undefined,
  });
  return {
    ports,
    context: FakeAudioContext.instances[0],
    recorder: FakeMediaRecorder.instances[0],
    capture,
  };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** A Pause, up to the moment the ports issue `context.suspend()`. */
async function pauseUntilSuspendIssued(
  { ports }: Opened,
  suspends: number,
): Promise<void> {
  ports.pause();
  await advance(SUSPEND_AFTER_MS);
  expect(FakeAudioContext.instances[0].suspend).toHaveBeenCalledTimes(suspends);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances.length = 0;
  FakeMediaRecorder.instances.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("ConstantSourceNode", FakeConstantSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the compressed capture's recorder across a pause", () => {
  it("is not paused by a suspended report that comes after a Play, then or when the context runs", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);

    ports.resume(() => undefined);
    // Late: the Play is out, and the state has not left suspended yet.
    context.report("suspended");
    context.report("running");

    expect(recorder.pause).not.toHaveBeenCalled();
  });

  it("is still paused by a newer Pause, after it ignored that stale report", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);
    ports.resume(() => undefined);
    context.report("suspended");
    context.report("running");

    await pauseUntilSuspendIssued(opened, 2);
    context.report("suspended");

    expect(recorder.pause).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale report until the newer Pause's suspend is issued and reported", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);
    ports.resume(() => undefined);

    // A Pause inside the window: its suspend waits out the fade.
    ports.pause();
    context.report("suspended");
    expect(recorder.pause).not.toHaveBeenCalled();

    await advance(SUSPEND_AFTER_MS);
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.report("suspended");
    expect(recorder.pause).toHaveBeenCalledTimes(1);
  });

  it("leaves a recorder told to stop alone, so that a Play still reaches the context", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder, capture } = opened;
    // Answered only when the recorder says it has stopped, which it has not.
    void capture.stop();

    await pauseUntilSuspendIssued(opened, 1);
    context.report("suspended");
    ports.resume(() => undefined);

    expect(recorder.pause).not.toHaveBeenCalled();
    expect(recorder.resume).not.toHaveBeenCalled();
    expect(context.resume).toHaveBeenCalledOnce();
  });

  it("pauses on the suspended report of an ordinary Pause, and a Play resumes it ahead of the context", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);

    context.report("suspended");
    expect(recorder.pause).toHaveBeenCalledTimes(1);

    ports.resume(() => undefined);
    expect(recorder.resume).toHaveBeenCalledTimes(1);
    expect(recorder.resume.mock.invocationCallOrder[0]).toBeLessThan(
      context.resume.mock.invocationCallOrder[0],
    );
  });
});
