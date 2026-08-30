import { describe, expect, it } from "vitest";
import { isVideoPlaneStale } from "@/lib/browser-view/sessions/use-screencast-session";

/** `VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame`'s floor. */
const STALE_AFTER_MS = 8_000;

/**
 * The post-occlusion window: the tile was hidden for minutes, came back at
 * `visibleSince`, and the last PRESENTED frame predates the whole stretch.
 */
const RETURN = {
  visibleSince: 100_000,
  videoFrameAt: 20_000,
  now: 100_000 + STALE_AFTER_MS,
} as const;

describe("isVideoPlaneStale", () => {
  it("does not declare a decoding stream dead when compositing has not resumed", () => {
    // `requestVideoFrameCallback` is exactly what is fragile across the
    // visible edge, so decode progress - not presentation - is the evidence.
    expect(
      isVideoPlaneStale({
        ...RETURN,
        decodeAdvancedAt: RETURN.now - 1_000,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(false);
  });

  it("still declares a stream dead when decoding actually stopped", () => {
    expect(
      isVideoPlaneStale({
        ...RETURN,
        decodeAdvancedAt: RETURN.visibleSince - 40_000,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(true);
    // No stats sample at all is no evidence, not evidence of life.
    expect(
      isVideoPlaneStale({
        ...RETURN,
        decodeAdvancedAt: null,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(true);
  });

  it("never judges a round over the window it was hidden for", () => {
    // Decode and presentation both predate the return, but the tile has only
    // been observable for a moment: the clock runs from `visibleSince`.
    expect(
      isVideoPlaneStale({
        ...RETURN,
        now: RETURN.visibleSince + 1_000,
        decodeAdvancedAt: 20_000,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(false);
  });

  it("counts presentation too, once it is the fresher signal", () => {
    expect(
      isVideoPlaneStale({
        visibleSince: RETURN.visibleSince,
        videoFrameAt: RETURN.now - 500,
        decodeAdvancedAt: 20_000,
        now: RETURN.now,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(false);
  });
});
