import { describe, expect, it } from "vitest";
import { dictationCaptureConstraints } from "@/hooks/composer/dictation-capture-constraints";

describe("dictationCaptureConstraints", () => {
  it("does not request echo cancellation on Windows", () => {
    expect(dictationCaptureConstraints(true)).toEqual({
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it("keeps echo cancellation off Windows", () => {
    expect(dictationCaptureConstraints(false).echoCancellation).toBe(true);
  });
});
