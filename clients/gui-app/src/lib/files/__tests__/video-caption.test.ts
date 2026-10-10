import { describe, expect, it } from "vitest";
import {
  formatVideoCaption,
  formatVideoDuration,
} from "@/lib/files/video-caption";

describe("formatVideoDuration", () => {
  it("reads like a player clock: m:ss under an hour, h:mm:ss past it", () => {
    expect(formatVideoDuration(59)).toBe("0:59");
    expect(formatVideoDuration(102)).toBe("1:42");
    expect(formatVideoDuration(3725)).toBe("1:02:05");
  });
});

describe("formatVideoCaption", () => {
  it("joins duration, dimensions and size once all are known", () => {
    expect(
      formatVideoCaption({
        durationSeconds: 102,
        width: 1920,
        height: 1080,
        byteLength: 18 * 1024 * 1024,
      }),
    ).toBe("1:42 · 1920 × 1080 · 18.0 MiB");
  });

  it("shows only the size before the element has reported its metadata", () => {
    expect(
      formatVideoCaption({
        durationSeconds: null,
        width: null,
        height: null,
        byteLength: 2048,
      }),
    ).toBe("2.0 KiB");
  });

  it("skips a duration that is not a length (a live stream, a broken file)", () => {
    const facts = { width: 640, height: 360, byteLength: null };
    expect(formatVideoCaption({ ...facts, durationSeconds: Infinity })).toBe(
      "640 × 360",
    );
    expect(formatVideoCaption({ ...facts, durationSeconds: NaN })).toBe(
      "640 × 360",
    );
  });

  it("skips dimensions the element reports as zero", () => {
    expect(
      formatVideoCaption({
        durationSeconds: 5,
        width: 0,
        height: 0,
        byteLength: null,
      }),
    ).toBe("0:05");
  });

  it("is empty when nothing is known", () => {
    expect(
      formatVideoCaption({
        durationSeconds: null,
        width: null,
        height: null,
        byteLength: null,
      }),
    ).toBe("");
  });
});
