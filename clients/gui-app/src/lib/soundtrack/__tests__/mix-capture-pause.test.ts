/**
 * When the compressed capture pauses its recorder, over the real
 * `openWebAudioPorts` and the real `captureMix("compressed")`, with a context
 * whose suspends this test lets take hold and whose `statechange` it reports.
 * A suspension that takes hold after a newer Play, or with no report at all, is
 * what is under test; the real clock is
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

/**
 * Its state moves only when the test reports it, so a resume nothing has
 * reported is one still pending, and the context reads suspended through it.
 */
class FakeAudioContext extends EventTarget {
  static readonly instances: FakeAudioContext[] = [];
  readonly currentTime = 0;
  readonly sampleRate = 48_000;
  state: ContextState = "running";
  readonly destination = {};
  private readonly suspensions: (() => void)[] = [];
  readonly suspend = vi.fn<() => Promise<void>>(
    () =>
      new Promise((resolve) => {
        this.suspensions.push(resolve);
      }),
  );
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

  /** The oldest suspend still waiting takes hold, and reports nothing. */
  async takeHold(): Promise<void> {
    const resolve = this.suspensions.shift();
    if (resolve === undefined) throw new Error("No suspend is waiting");
    resolve();
    await advance(0);
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
  it("pauses once a Pause's suspension takes hold, and a Play resumes it ahead of the context", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);

    await context.takeHold();
    expect(recorder.pause).toHaveBeenCalledTimes(1);

    ports.resume(() => undefined);
    expect(recorder.resume).toHaveBeenCalledTimes(1);
    expect(recorder.resume.mock.invocationCallOrder[0]).toBeLessThan(
      context.resume.mock.invocationCallOrder[0],
    );
  });

  it("is not paused by a suspension that takes hold after a Play, nor by its late report", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);

    ports.resume(() => undefined);
    await context.takeHold();
    // Late: the Play is out, and the state has not left suspended yet.
    context.report("suspended");
    context.report("running");

    expect(recorder.pause).not.toHaveBeenCalled();
  });

  it("is paused by a newer Pause's suspension, and not by an older one that takes hold first", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);
    ports.resume(() => undefined);
    await pauseUntilSuspendIssued(opened, 2);

    await context.takeHold();
    expect(recorder.pause).not.toHaveBeenCalled();

    await context.takeHold();
    expect(recorder.pause).toHaveBeenCalledTimes(1);
  });

  it("is paused by a Pause whose suspension takes hold while the Play's resume is pending, with no statechange", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder } = opened;
    await pauseUntilSuspendIssued(opened, 1);
    await context.takeHold();
    context.report("suspended");
    // The Play resumes the recorder at once; the context still reads suspended.
    ports.resume(() => undefined);
    expect(recorder.state).toBe("recording");

    await pauseUntilSuspendIssued(opened, 2);
    await context.takeHold();

    expect(recorder.pause).toHaveBeenCalledTimes(2);
    expect(recorder.state).toBe("paused");
  });

  it("leaves a recorder told to stop alone, so that a Play still reaches the context", async () => {
    const opened = await openCapturing();
    const { ports, context, recorder, capture } = opened;
    // Answered only when the recorder says it has stopped, which it has not.
    void capture.stop();

    await pauseUntilSuspendIssued(opened, 1);
    await context.takeHold();
    ports.resume(() => undefined);

    expect(recorder.pause).not.toHaveBeenCalled();
    expect(recorder.resume).not.toHaveBeenCalled();
    expect(context.resume).toHaveBeenCalledOnce();
  });
});
