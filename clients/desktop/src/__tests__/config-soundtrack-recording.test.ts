import { describe, expect, it } from "vitest";
import { soundtrackRecordingAllowed } from "../config";

// The source tree always bakes "dev", so the gate is driven through the
// function `canRecordSoundtrack` is computed with.
describe("which desktop builds may record the music", () => {
  it.each([
    ["dev", true],
    ["staging", true],
    ["production", false],
    // A value no build is stamped with today: off, not on.
    ["preview", false],
  ])("answers %s with %s", (environment, allowed) => {
    expect(soundtrackRecordingAllowed(environment)).toBe(allowed);
  });
});
