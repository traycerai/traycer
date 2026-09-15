import { describe, expect, it } from "vitest";
import { pipCaptureIntervalMs } from "../browser-pip-capture";

describe("pipCaptureIntervalMs", () => {
  it("gives a host with headroom a faster cadence than the retired 5 fps", () => {
    // A small mirror captured in 8ms used to wait 200ms regardless.
    expect(pipCaptureIntervalMs(8)).toBeLessThan(200);
  });

  it("never spends a core on a thumbnail, however fast the capture", () => {
    expect(pipCaptureIntervalMs(0)).toBe(40);
    expect(pipCaptureIntervalMs(1)).toBe(40);
  });

  it("paces a loaded host at its own measured cost", () => {
    expect(pipCaptureIntervalMs(120)).toBe(120);
  });

  it("stops widening past the ceiling, so a slow host still looks alive", () => {
    expect(pipCaptureIntervalMs(5_000)).toBe(500);
  });

  it("treats an unmeasurable duration as the slowest cadence, not the fastest", () => {
    expect(pipCaptureIntervalMs(Number.NaN)).toBe(500);
  });

  it("ignores a negative measurement rather than inverting the pacing", () => {
    expect(pipCaptureIntervalMs(-50)).toBe(40);
  });
});
