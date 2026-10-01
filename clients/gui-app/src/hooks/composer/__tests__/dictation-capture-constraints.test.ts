import { describe, expect, it } from "vitest";
import { dictationCaptureConstraints } from "@/hooks/composer/dictation-capture-constraints";

describe("dictationCaptureConstraints", () => {
  it("keeps echo cancellation, noise suppression, and auto gain", () => {
    expect(dictationCaptureConstraints()).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });
});
