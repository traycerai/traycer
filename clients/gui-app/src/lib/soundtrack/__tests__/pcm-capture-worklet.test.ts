/**
 * The lossless capture's worklet, run in a stand-in for the audio thread's
 * scope: the free globals `currentFrame` and `currentTime`, a base
 * `AudioWorkletProcessor` with a `port`, and `registerProcessor`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PCM_CAPTURE_FINISH,
  PCM_CAPTURE_PROCESSOR,
} from "../pcm-capture-protocol";

const QUANTUM = 128;
const BATCH_FRAMES = 8192;
const START_FRAME = 4_851_328;
const START_TIME = 101.1;

interface Posted {
  readonly message: unknown;
  readonly transfer: readonly unknown[] | null;
}

class FakePort {
  readonly posted: Posted[] = [];
  private readonly listeners: ((event: MessageEvent) => void)[] = [];

  addEventListener(
    _type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    this.listeners.push(listener);
  }

  start(): void {}

  postMessage(
    message: unknown,
    transfer: readonly unknown[] | undefined,
  ): void {
    this.posted.push({ message, transfer: transfer ?? null });
  }

  /** What the page does: send `data` to the worklet's listener. */
  send(data: unknown): void {
    for (const listener of this.listeners) {
      listener(new MessageEvent("message", { data }));
    }
  }
}

interface Processor {
  process(inputs: Float32Array[][]): boolean;
}

let port: FakePort;
let registered: { readonly name: string; readonly make: () => Processor };

async function loadProcessor(): Promise<Processor> {
  await import("../pcm-capture-worklet");
  return registered.make();
}

function runQuantum(
  processor: Processor,
  frame: number,
  value: number,
): boolean {
  vi.stubGlobal("currentFrame", frame);
  vi.stubGlobal("currentTime", START_TIME + (frame - START_FRAME) / 48_000);
  const channel = new Float32Array(QUANTUM).fill(value);
  return processor.process([[channel, channel]]);
}

function messagesOf(type: string): Record<string, unknown>[] {
  return port.posted.flatMap(({ message }) =>
    typeof message === "object" &&
    message !== null &&
    Reflect.get(message, "type") === type
      ? [Object.fromEntries(Object.entries(message))]
      : [],
  );
}

/** The captured frames, each quantum read as its first left sample. */
function quantaCaptured(): number[] {
  const values: number[] = [];
  for (const { buffer } of messagesOf("pcm")) {
    if (!(buffer instanceof ArrayBuffer)) throw new Error("pcm without bytes");
    const samples = new Int16Array(buffer);
    for (let frame = 0; frame < samples.length / 2; frame += QUANTUM) {
      values.push(samples[frame * 2]);
    }
  }
  return values;
}

beforeEach(() => {
  vi.resetModules();
  port = new FakePort();
  class FakeProcessor {
    readonly port = port;
  }
  vi.stubGlobal("AudioWorkletProcessor", FakeProcessor);
  vi.stubGlobal(
    "registerProcessor",
    (name: string, processor: new () => Processor) => {
      registered = { name, make: () => new processor() };
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the PCM capture worklet", () => {
  it("registers under its name, posts the first frame's time once, and keeps contiguous quanta in order", async () => {
    const processor = await loadProcessor();
    expect(registered.name).toBe(PCM_CAPTURE_PROCESSOR);

    runQuantum(processor, START_FRAME, 0.25);
    runQuantum(processor, START_FRAME + QUANTUM, 0.5);
    runQuantum(processor, START_FRAME + 2 * QUANTUM, 0.75);
    port.send(PCM_CAPTURE_FINISH);

    expect(messagesOf("first-frame")).toEqual([
      { type: "first-frame", time: START_TIME },
    ]);
    expect(quantaCaptured()).toEqual([8192, 16384, 24575]);
    expect(messagesOf("finished")).toEqual([
      { type: "finished", frames: 3 * QUANTUM, droppedFrames: 0 },
    ]);
  });

  it("fills frames the thread went past with silence, and counts them as dropped", async () => {
    const processor = await loadProcessor();

    runQuantum(processor, START_FRAME, 0.25);
    // Three quanta past where the next one was due.
    runQuantum(processor, START_FRAME + 4 * QUANTUM, 0.5);
    port.send(PCM_CAPTURE_FINISH);

    expect(quantaCaptured()).toEqual([8192, 0, 0, 0, 16384]);
    expect(messagesOf("finished")).toEqual([
      { type: "finished", frames: 5 * QUANTUM, droppedFrames: 3 * QUANTUM },
    ]);
  });

  it("writes a quantum handed over twice under one frame number and the one after it as three in a row, with no silence", async () => {
    const processor = await loadProcessor();

    // As a starved audio thread was seen to call: A, A, then A + 2 quanta.
    runQuantum(processor, START_FRAME, 0.25);
    runQuantum(processor, START_FRAME, 0.5);
    runQuantum(processor, START_FRAME + 2 * QUANTUM, 0.75);
    port.send(PCM_CAPTURE_FINISH);

    expect(quantaCaptured()).toEqual([8192, 16384, 24575]);
    expect(messagesOf("finished")).toEqual([
      { type: "finished", frames: 3 * QUANTUM, droppedFrames: 0 },
    ]);
  });

  it("hands a batch over at 8192 frames as one transferred buffer, and the remainder on finish", async () => {
    const processor = await loadProcessor();

    for (let quantum = 0; quantum < BATCH_FRAMES / QUANTUM; quantum += 1) {
      runQuantum(processor, START_FRAME + quantum * QUANTUM, 0.25);
    }
    // Posted in order: the first frame, then the batch with its buffer.
    const [batch] = messagesOf("pcm");
    expect(batch.buffer).toBeInstanceOf(ArrayBuffer);
    expect(port.posted[1].transfer).toEqual([batch.buffer]);
    expect(messagesOf("pcm")).toHaveLength(1);

    runQuantum(processor, START_FRAME + BATCH_FRAMES, 0.5);
    port.send(PCM_CAPTURE_FINISH);

    const sizes = messagesOf("pcm").map((message) =>
      message.buffer instanceof ArrayBuffer ? message.buffer.byteLength : -1,
    );
    expect(sizes).toEqual([BATCH_FRAMES * 4, QUANTUM * 4]);
    expect(messagesOf("finished")).toEqual([
      { type: "finished", frames: BATCH_FRAMES + QUANTUM, droppedFrames: 0 },
    ]);
  });

  it("returns false after finish and captures nothing more", async () => {
    const processor = await loadProcessor();
    expect(runQuantum(processor, START_FRAME, 0.25)).toBe(true);
    port.send(PCM_CAPTURE_FINISH);
    const postedAtFinish = port.posted.length;

    expect(runQuantum(processor, START_FRAME + QUANTUM, 0.5)).toBe(false);

    expect(port.posted).toHaveLength(postedAtFinish);
  });
});
