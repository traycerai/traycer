import { describe, expect, it, vi } from "vitest";
import {
  BrowserPageRecording,
  RECORDING_MAX_DURATION_MS,
  RECORDING_MAX_FRAMES,
  recordingIntervalMs,
  recordingStopReason,
  type BrowserRecordingFrame,
  type BrowserRecordingStopReason,
} from "../browser-page-recording";

vi.mock("../../../app/logger", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => ({ message: String(error) }),
}));

interface FakeImage {
  getSize(): { readonly width: number; readonly height: number };
  toJPEG(quality: number): Uint8Array;
  toDataURL(): string;
  isEmpty(): boolean;
  crop(): FakeImage;
  toPNG(): Uint8Array;
}

function image(bytes: readonly number[]): FakeImage {
  const self: FakeImage = {
    getSize: () => ({ width: 800, height: 600 }),
    toJPEG: () => Uint8Array.from(bytes),
    toDataURL: () => "",
    isEmpty: () => bytes.length === 0,
    crop: () => self,
    toPNG: () => Uint8Array.from(bytes),
  };
  return self;
}

class FakePage {
  destroyed = false;
  captureCount = 0;
  failNext = false;

  capturePage(): Promise<FakeImage> {
    this.captureCount += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("mid-navigation"));
    }
    return Promise.resolve(image([1, 2, 3]));
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

describe("recordingIntervalMs", () => {
  it("paces by the last capture's cost", () => {
    expect(recordingIntervalMs(120)).toBe(120);
  });

  it("never spends a whole core on capture", () => {
    expect(recordingIntervalMs(0)).toBe(40);
  });

  it("stops widening past the ceiling", () => {
    expect(recordingIntervalMs(9_999)).toBe(500);
  });

  it("treats an unmeasurable cost as the slowest cadence", () => {
    expect(recordingIntervalMs(Number.NaN)).toBe(500);
  });
});

describe("recordingStopReason", () => {
  it("keeps going while every bound is unmet", () => {
    expect(
      recordingStopReason({ elapsedMs: 1_000, frameCount: 10, pageGone: false }),
    ).toBeNull();
  });

  it("reports a page that went away first, whatever else is true", () => {
    // The other two are limits; this one means there is nothing left to capture.
    expect(
      recordingStopReason({
        elapsedMs: RECORDING_MAX_DURATION_MS,
        frameCount: RECORDING_MAX_FRAMES,
        pageGone: true,
      }),
    ).toBe("page-gone");
  });

  it("stops a recording nobody ended, by clock", () => {
    expect(
      recordingStopReason({
        elapsedMs: RECORDING_MAX_DURATION_MS,
        frameCount: 1,
        pageGone: false,
      }),
    ).toBe("duration-limit");
  });

  it("stops one whose host outran the clock, by frame count", () => {
    expect(
      recordingStopReason({
        elapsedMs: 1,
        frameCount: RECORDING_MAX_FRAMES,
        pageGone: false,
      }),
    ).toBe("frame-limit");
  });
});

describe("BrowserPageRecording", () => {
  function harness(): {
    readonly page: FakePage;
    readonly recording: BrowserPageRecording;
    readonly frames: BrowserRecordingFrame[];
    readonly stops: BrowserRecordingStopReason[];
  } {
    const page = new FakePage();
    const frames: BrowserRecordingFrame[] = [];
    const stops: BrowserRecordingStopReason[] = [];
    return {
      page,
      recording: new BrowserPageRecording(page),
      frames,
      stops,
    };
  }

  it("captures an immediate first frame with its real size", async () => {
    const { page, recording, frames, stops } = harness();
    expect(
      recording.start(
        {
          quality: 80,
          onFrame: (frame) => frames.push(frame),
          onStopped: (reason) => stops.push(reason),
        },
        Date.now(),
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(frames[0]).toMatchObject({ sequence: 0, width: 800, height: 600 });
    expect(page.captureCount).toBeGreaterThan(0);
    recording.stop("requested");
  });

  it("refuses a second recording rather than interleaving two", () => {
    const { recording, frames, stops } = harness();
    const input = {
      quality: 80,
      onFrame: (frame: BrowserRecordingFrame) => frames.push(frame),
      onStopped: (reason: BrowserRecordingStopReason) => stops.push(reason),
    };
    expect(recording.start(input, Date.now())).toBe(true);
    expect(recording.start(input, Date.now())).toBe(false);
    recording.stop("requested");
  });

  it("refuses to start on a page that is already gone", () => {
    const { page, recording, frames, stops } = harness();
    page.destroyed = true;
    expect(
      recording.start(
        {
          quality: 80,
          onFrame: (frame) => frames.push(frame),
          onStopped: (reason) => stops.push(reason),
        },
        Date.now(),
      ),
    ).toBe(false);
  });

  it("reports why it stopped, once", () => {
    const { recording, frames, stops } = harness();
    recording.start(
      {
        quality: 80,
        onFrame: (frame) => frames.push(frame),
        onStopped: (reason) => stops.push(reason),
      },
      Date.now(),
    );
    recording.stop("requested");
    recording.stop("requested");
    expect(stops).toEqual(["requested"]);
    expect(recording.isRecording()).toBe(false);
  });

  it("treats one failed capture as a dropped frame, not a failed recording", async () => {
    const { page, recording, frames, stops } = harness();
    page.failNext = true;
    recording.start(
      {
        quality: 80,
        onFrame: (frame) => frames.push(frame),
        onStopped: (reason) => stops.push(reason),
      },
      Date.now(),
    );
    // A page mid-navigation cannot be captured and is about to be captureable
    // again; ending the recording would lose everything before it.
    await vi.waitFor(() => expect(page.captureCount).toBeGreaterThan(1));
    expect(stops).toEqual([]);
    recording.stop("requested");
  });

  it("ends when the page goes away mid-recording", async () => {
    const { page, recording, frames, stops } = harness();
    recording.start(
      {
        quality: 80,
        onFrame: (frame) => frames.push(frame),
        onStopped: (reason) => stops.push(reason),
      },
      Date.now(),
    );
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    page.destroyed = true;
    await vi.waitFor(() => expect(stops).toEqual(["page-gone"]));
  });
});
