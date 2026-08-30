import { describe, expect, it } from "vitest";
import {
  createVideoFrameLatencyWindow,
  LATENCY_WINDOW_SIZE,
  readVideoFrameLatency,
} from "@/lib/browser-view/sessions/video-frame-latency";

/** A `VideoFrameCallbackMetadata`-shaped object with only the fields the module reads. */
function metadata(input: {
  readonly captureTime?: number;
  readonly receiveTime?: number;
  readonly expectedDisplayTime?: number;
}): VideoFrameCallbackMetadata {
  const partial: Partial<
    Pick<
      VideoFrameCallbackMetadata,
      "captureTime" | "receiveTime" | "expectedDisplayTime"
    >
  > = {
    captureTime: input.captureTime,
    receiveTime: input.receiveTime,
    expectedDisplayTime: input.expectedDisplayTime,
  };
  return partial as VideoFrameCallbackMetadata;
}

function assertAllFinite(sample: {
  readonly glassToGlassMs: number | null;
  readonly networkPlusJitterMs: number | null;
  readonly decodeCompositeMs: number | null;
}): void {
  for (const value of Object.values(sample)) {
    if (value !== null) expect(Number.isNaN(value)).toBe(false);
  }
}

describe("readVideoFrameLatency", () => {
  it("splits the trip into its two legs", () => {
    const sample = readVideoFrameLatency(
      metadata({
        captureTime: 100,
        receiveTime: 160,
        expectedDisplayTime: 200,
      }),
    );
    expect(sample).toEqual({
      glassToGlassMs: 100,
      networkPlusJitterMs: 60,
      decodeCompositeMs: 40,
    });
    assertAllFinite(sample);
  });

  it("nulls the legs touching a missing captureTime but keeps decodeComposite", () => {
    const sample = readVideoFrameLatency(
      metadata({ receiveTime: 160, expectedDisplayTime: 200 }),
    );
    expect(sample.glassToGlassMs).toBeNull();
    expect(sample.networkPlusJitterMs).toBeNull();
    expect(sample.decodeCompositeMs).toBe(40);
    assertAllFinite(sample);
  });

  it("nulls the legs touching a missing receiveTime but keeps glassToGlass", () => {
    const sample = readVideoFrameLatency(
      metadata({ captureTime: 100, expectedDisplayTime: 200 }),
    );
    expect(sample.glassToGlassMs).toBe(100);
    expect(sample.networkPlusJitterMs).toBeNull();
    expect(sample.decodeCompositeMs).toBeNull();
    assertAllFinite(sample);
  });

  it("nulls every leg when a timestamp is NaN", () => {
    const sample = readVideoFrameLatency(
      metadata({
        captureTime: Number.NaN,
        receiveTime: 160,
        expectedDisplayTime: 200,
      }),
    );
    expect(sample.glassToGlassMs).toBeNull();
    expect(sample.networkPlusJitterMs).toBeNull();
    expect(sample.decodeCompositeMs).toBe(40);
    assertAllFinite(sample);
  });

  it("nulls every leg when a timestamp is Infinity", () => {
    const sample = readVideoFrameLatency(
      metadata({
        captureTime: 100,
        receiveTime: 160,
        expectedDisplayTime: Number.POSITIVE_INFINITY,
      }),
    );
    expect(sample.glassToGlassMs).toBeNull();
    expect(sample.decodeCompositeMs).toBeNull();
    expect(sample.networkPlusJitterMs).toBe(60);
    assertAllFinite(sample);
  });

  it("nulls a negative delta instead of clamping it to zero", () => {
    const sample = readVideoFrameLatency(
      metadata({
        captureTime: 200,
        receiveTime: 160,
        expectedDisplayTime: 100,
      }),
    );
    expect(sample.glassToGlassMs).toBeNull();
    expect(sample.networkPlusJitterMs).toBeNull();
    expect(sample.decodeCompositeMs).toBeNull();
    assertAllFinite(sample);
  });
});

describe("createVideoFrameLatencyWindow", () => {
  it("ignores null metadata", () => {
    const window = createVideoFrameLatencyWindow();
    window.note(null);
    expect(window.summarize()).toEqual({
      glassToGlassMs: null,
      glassToGlassP95Ms: null,
      networkPlusJitterMs: null,
      decodeCompositeMs: null,
    });
  });

  it("ignores a frame with nothing derivable", () => {
    const window = createVideoFrameLatencyWindow();
    window.note(metadata({}));
    expect(window.summarize()).toEqual({
      glassToGlassMs: null,
      glassToGlassP95Ms: null,
      networkPlusJitterMs: null,
      decodeCompositeMs: null,
    });
  });

  it("summarizes an empty window as all-null", () => {
    const window = createVideoFrameLatencyWindow();
    const summary = window.summarize();
    expect(summary.glassToGlassMs).toBeNull();
    expect(summary.glassToGlassP95Ms).toBeNull();
    expect(summary.networkPlusJitterMs).toBeNull();
    expect(summary.decodeCompositeMs).toBeNull();
  });

  it("computes nearest-rank percentiles", () => {
    const window = createVideoFrameLatencyWindow();
    for (let value = 1; value <= 10; value += 1) {
      window.note(metadata({ captureTime: 0, expectedDisplayTime: value }));
    }
    const summary = window.summarize();
    expect(summary.glassToGlassMs).toBe(5);
    expect(summary.glassToGlassP95Ms).toBe(10);
  });

  it("bounds the window at LATENCY_WINDOW_SIZE, dropping the oldest samples", () => {
    expect(LATENCY_WINDOW_SIZE).toBe(64);
    const window = createVideoFrameLatencyWindow();
    for (let index = 0; index < 64; index += 1) {
      window.note(metadata({ captureTime: 0, expectedDisplayTime: 1000 }));
    }
    for (let index = 0; index < 64; index += 1) {
      window.note(metadata({ captureTime: 0, expectedDisplayTime: 1 }));
    }
    const summary = window.summarize();
    expect(summary.glassToGlassMs).toBe(1);
    expect(summary.glassToGlassP95Ms).toBe(1);
  });
});
