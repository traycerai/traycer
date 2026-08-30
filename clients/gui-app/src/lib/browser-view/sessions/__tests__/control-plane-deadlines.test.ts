import { describe, expect, it } from "vitest";
import { MAX_CONTROL_PLANE_RTT_MS } from "@traycer/protocol/host/browser/control-plane-rtt";
import {
  deriveViewerDeadlineMs,
  VIEWER_CONTROL_PLANE_DEADLINES,
} from "@/lib/browser-view/sessions/control-plane-deadlines";

describe("deriveViewerDeadlineMs", () => {
  it("returns each spec's floor exactly when no rtt has been measured", () => {
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.armBuffer, null),
    ).toBe(1_000);
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.firstFrame, null),
    ).toBe(15_000);
    expect(
      deriveViewerDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame,
        null,
      ),
    ).toBe(8_000);
  });

  it("keeps the floor at a small rtt - JPEG-plane behaviour at low RTT is unchanged", () => {
    // 2.5 * 50 = 125, 6 * 50 = 300, 4 * 50 = 200 - all well under their floors.
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.armBuffer, 50),
    ).toBe(1_000);
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.firstFrame, 50),
    ).toBe(15_000);
    expect(
      deriveViewerDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame,
        50,
      ),
    ).toBe(8_000);
  });

  it("scales past the floor by the spec's own roundTrips multiplier", () => {
    // 2.5 * 2000 = 5000 > 1000 floor.
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.armBuffer, 2_000),
    ).toBe(5_000);
    // 6 * 2600 = 15600 > 15000 floor.
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.firstFrame, 2_600),
    ).toBe(15_600);
    // 4 * 2500 = 10000 > 8000 floor.
    expect(
      deriveViewerDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame,
        2_500,
      ),
    ).toBe(10_000);
  });

  it("clamps at the max control-plane rtt, so a stalled sample can't blow up the deadline", () => {
    const atClamp = deriveViewerDeadlineMs(
      VIEWER_CONTROL_PLANE_DEADLINES.firstFrame,
      MAX_CONTROL_PLANE_RTT_MS,
    );
    const wayPastClamp = deriveViewerDeadlineMs(
      VIEWER_CONTROL_PLANE_DEADLINES.firstFrame,
      50_000,
    );
    expect(atClamp).toBe(6 * MAX_CONTROL_PLANE_RTT_MS);
    expect(wayPastClamp).toBe(atClamp);
  });

  it("treats a negative or zero rtt as safe - never below the floor", () => {
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.armBuffer, 0),
    ).toBe(1_000);
    expect(
      deriveViewerDeadlineMs(VIEWER_CONTROL_PLANE_DEADLINES.armBuffer, -500),
    ).toBe(1_000);
    expect(
      deriveViewerDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.firstFrame,
        -100_000,
      ),
    ).toBe(15_000);
  });
});
