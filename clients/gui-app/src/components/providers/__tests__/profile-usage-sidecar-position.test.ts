import { describe, expect, it } from "vitest";
import { deriveProfileUsageSidecarPosition } from "../profile-usage-sidecar-position";

const BASE = {
  anchor: { left: 200, right: 400, top: 300 },
  sidecarWidth: 280,
  sidecarHeight: 240,
  viewportWidth: 1_000,
  viewportHeight: 800,
  gap: 8,
  padding: 12,
};

describe("deriveProfileUsageSidecarPosition", () => {
  it("prefers the right and preserves the row top when it fits", () => {
    expect(deriveProfileUsageSidecarPosition(BASE)).toEqual({
      side: "right",
      left: 408,
      top: 300,
    });
  });

  it("flips left when the right side cannot fit", () => {
    expect(
      deriveProfileUsageSidecarPosition({
        ...BASE,
        anchor: { left: 500, right: 760, top: 300 },
      }),
    ).toEqual({ side: "left", left: 212, top: 300 });
  });

  it("shifts vertically within viewport padding", () => {
    expect(
      deriveProfileUsageSidecarPosition({
        ...BASE,
        anchor: { left: 200, right: 400, top: 720 },
      }),
    ).toEqual({ side: "right", left: 408, top: 548 });
  });

  it("hides when neither side has enough room", () => {
    expect(
      deriveProfileUsageSidecarPosition({
        ...BASE,
        anchor: { left: 250, right: 750, top: 300 },
      }),
    ).toBeNull();
  });
});
