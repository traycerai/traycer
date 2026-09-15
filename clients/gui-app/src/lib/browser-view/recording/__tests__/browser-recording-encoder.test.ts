import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRecordingEncoder } from "../browser-recording-encoder";

/**
 * The encoder is a renderer-only object built out of `MediaRecorder`,
 * `canvas.captureStream` and `createImageBitmap`, none of which jsdom has. The
 * suite supplies them so the ORDERING and RESOURCE behaviour can be tested,
 * which is what actually goes wrong here - a real Chromium would hide both
 * defects behind fast decodes.
 */

interface FakeBitmap {
  readonly width: number;
  readonly height: number;
  readonly label: string;
  closed: boolean;
  close(): void;
}

/** Frames drawn, in the order the canvas received them. */
let drawn: string[] = [];
let bitmaps: FakeBitmap[] = [];
/** Resolvers for in-flight decodes, keyed by the frame's label. */
let pendingDecodes: Map<string, (bitmap: FakeBitmap) => void> = new Map();
let requestedFrames = 0;
let recorderStopped = false;
/** Makes the next drawImage throw, as a lost canvas context would. */
let throwOnNextDraw = false;

function makeBitmap(label: string): FakeBitmap {
  const bitmap: FakeBitmap = {
    width: 100,
    height: 50,
    label,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  bitmaps.push(bitmap);
  return bitmap;
}

beforeEach(() => {
  drawn = [];
  bitmaps = [];
  pendingDecodes = new Map();
  requestedFrames = 0;
  recorderStopped = false;
  throwOnNextDraw = false;

  // A frame's base64 is used as its label, so the draw order is observable.
  vi.stubGlobal("atob", (value: string) => {
    currentLabel = value;
    return value;
  });
  vi.stubGlobal(
    "createImageBitmap",
    (blob: Blob) =>
      new Promise<FakeBitmap>((resolve) => {
        void blob;
        const label = currentLabel;
        pendingDecodes.set(label, resolve);
      }),
  );

  class FakeMediaRecorder {
    static isTypeSupported(): boolean {
      return true;
    }
    state = "recording";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start(): void {
      /* nothing to do */
    }
    stop(): void {
      recorderStopped = true;
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["x"]) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("Blob", globalThis.Blob);

  const context = {
    clearRect: () => undefined,
    drawImage: (bitmap: FakeBitmap) => {
      if (throwOnNextDraw) {
        throwOnNextDraw = false;
        throw new Error("canvas context lost");
      }
      drawn.push(bitmap.label);
    },
  };
  const track = {
    requestFrame: () => {
      requestedFrames += 1;
    },
  };
  vi.spyOn(document, "createElement").mockImplementation(
    () =>
      ({
        width: 0,
        height: 0,
        getContext: () => context,
        captureStream: () => ({ getVideoTracks: () => [track] }),
      }) as unknown as HTMLElement,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The label the next `createImageBitmap` call should register under. */
let currentLabel = "";

/**
 * Lets the queue advance. `addFrame` chains onto a promise, so the decode for a
 * frame does not begin in the same tick the caller handed it over.
 */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function addFrame(
  encoder: { addFrame(base64: string): Promise<void> },
  label: string,
): Promise<void> {
  return encoder.addFrame(label);
}

function settleDecode(label: string): void {
  const resolve = pendingDecodes.get(label);
  if (resolve === undefined) throw new Error(`no pending decode for ${label}`);
  pendingDecodes.delete(label);
  resolve(makeBitmap(label));
}

describe("createBrowserRecordingEncoder frame ordering", () => {
  it("draws frames in arrival order even when a later decode finishes first", async () => {
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) throw new Error("encoder unavailable");

    // Two frames handed over back to back, as the IPC listener does.
    const first = addFrame(encoder, "a");
    await flush();
    // The queue must not start the second decode until the first has drawn, so
    // only "a" can be pending here.
    expect(pendingDecodes.has("b")).toBe(false);

    settleDecode("a");
    await first;

    const second = addFrame(encoder, "b");
    await flush();
    settleDecode("b");
    await second;

    expect(drawn).toEqual(["a", "b"]);
  });

  it("serializes work so a slow frame cannot be overtaken", async () => {
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) throw new Error("encoder unavailable");

    const first = addFrame(encoder, "slow");
    const second = addFrame(encoder, "fast");
    await flush();

    // "fast" cannot have begun decoding: the chain is still on "slow".
    expect([...pendingDecodes.keys()]).toEqual(["slow"]);

    settleDecode("slow");
    await first;
    await flush();
    settleDecode("fast");
    await second;

    expect(drawn).toEqual(["slow", "fast"]);
    expect(requestedFrames).toBe(2);
  });
});

describe("createBrowserRecordingEncoder finish", () => {
  it("waits for an in-flight frame before stopping the recorder", async () => {
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) throw new Error("encoder unavailable");

    const pending = addFrame(encoder, "tail");
    await flush();
    const finished = encoder.finish();

    // The last frames of a recording are the ones the user waited for; stopping
    // with a decode outstanding drops exactly those.
    expect(recorderStopped).toBe(false);

    settleDecode("tail");
    await pending;
    await finished;

    expect(drawn).toEqual(["tail"]);
    expect(recorderStopped).toBe(true);
  });
});

describe("createBrowserRecordingEncoder cancellation", () => {
  it("closes a bitmap whose decode landed after cancel", async () => {
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) throw new Error("encoder unavailable");

    const pending = addFrame(encoder, "raced");
    await flush();
    encoder.cancel();
    settleDecode("raced");
    await pending;

    // An ImageBitmap holds native memory that GC does not promptly reclaim.
    const raced = bitmaps.find((bitmap) => bitmap.label === "raced");
    expect(raced?.closed).toBe(true);
    expect(drawn).toEqual([]);
  });

  it("closes every frame drawn normally too", async () => {
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) throw new Error("encoder unavailable");

    const pending = addFrame(encoder, "kept");
    await flush();
    settleDecode("kept");
    await pending;

    expect(bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
  });
});

describe("createBrowserRecordingEncoder frame failures", () => {
  it("keeps recording after one frame throws, and still finishes the file", async () => {
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) throw new Error("encoder unavailable");

    // The queue is one promise chain, so a rejected link would be inherited by
    // every frame after it: one bad draw would discard the rest of the
    // recording AND reject finish(), whose caller does not await it.
    const bad = addFrame(encoder, "bad");
    await flush();
    throwOnNextDraw = true;
    settleDecode("bad");
    await bad;

    const good = addFrame(encoder, "good");
    await flush();
    settleDecode("good");
    await good;

    // The frame after the failure still drew.
    expect(drawn).toEqual(["good"]);

    const file = await encoder.finish();
    expect(file).not.toBeNull();
    expect(recorderStopped).toBe(true);
  });

  it("releases the bitmap of a frame that failed to draw", async () => {
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) throw new Error("encoder unavailable");

    const pending = addFrame(encoder, "leaky");
    await flush();
    throwOnNextDraw = true;
    settleDecode("leaky");
    await pending;

    const leaky = bitmaps.find((bitmap) => bitmap.label === "leaky");
    expect(leaky?.closed).toBe(true);
  });
});
