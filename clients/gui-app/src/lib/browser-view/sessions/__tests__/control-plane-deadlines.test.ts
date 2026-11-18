import { describe, expect, it } from "vitest";
import { deriveSpecDeadlineMs } from "@traycer/protocol/host-transport/rtt-deadlines";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";

/**
 * Each spec's floor and roundTrips multiplier, stated once here rather than
 * restated per assertion below.
 *
 * What is pinned here is only THIS k-table: that each viewer window carries
 * the floor and multiplier it is supposed to. The arithmetic itself (clamps,
 * variance, rounding) belongs to `deriveRttDeadlineMs` and is pinned in
 * `protocol/src/host-transport/__tests__/rtt-deadlines.test.ts`.
 */
const SPECS = [
  {
    name: "armBuffer",
    spec: VIEWER_CONTROL_PLANE_DEADLINES.armBuffer,
    floor: 1_000,
    roundTrips: 2.5,
  },
  {
    name: "firstFrame",
    spec: VIEWER_CONTROL_PLANE_DEADLINES.firstFrame,
    floor: 15_000,
    roundTrips: 6,
  },
  {
    name: "staleWithoutFrame",
    spec: VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame,
    floor: 8_000,
    roundTrips: 4,
  },
] as const;

describe("deriveSpecDeadlineMs", () => {
  it.each(SPECS)(
    "returns $name's floor exactly when no rtt has been measured",
    ({ spec, floor }) => {
      expect(deriveSpecDeadlineMs(spec, null)).toBe(floor);
    },
  );

  it.each([
    { ...SPECS[0], rtt: 2_000 },
    { ...SPECS[1], rtt: 2_600 },
    { ...SPECS[2], rtt: 2_500 },
  ])(
    "scales $name past the floor by its own roundTrips multiplier",
    ({ spec, roundTrips, rtt }) => {
      expect(deriveSpecDeadlineMs(spec, rtt)).toBe(roundTrips * rtt);
    },
  );
});
