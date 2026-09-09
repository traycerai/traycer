import { describe, expect, it } from "vitest";
import {
  deriveRttDeadlineMs,
  deriveSpecDeadlineMs,
  MAX_CONTROL_PLANE_RTT_MS,
} from "../rtt-deadlines";

describe("deriveRttDeadlineMs", () => {
  it("applies the 4x variance term", () => {
    // max(floor, round(roundTrips * (rtt + 4 * variance)))
    // = max(0, round(2 * (100 + 4 * 25))) = round(2 * 200) = 400.
    const deadline = deriveRttDeadlineMs({
      floorMs: 0,
      roundTrips: 2,
      rttMs: 100,
      varianceMs: 25,
      maxRttMs: MAX_CONTROL_PLANE_RTT_MS,
    });

    expect(deadline).toBe(400);
  });

  it("clamps both rtt and variance to maxRttMs before deriving", () => {
    // Both rtt and variance are far above maxRttMs (1_000); each clamps to
    // 1_000 before the formula runs: round(1 * (1_000 + 4 * 1_000)) = 5_000.
    const deadline = deriveRttDeadlineMs({
      floorMs: 0,
      roundTrips: 1,
      rttMs: 50_000,
      varianceMs: 50_000,
      maxRttMs: 1_000,
    });

    expect(deadline).toBe(5_000);
  });

  it("returns the floor untouched when rttMs is null", () => {
    const deadline = deriveRttDeadlineMs({
      floorMs: 7_500,
      roundTrips: 3,
      rttMs: null,
      varianceMs: 999,
      maxRttMs: MAX_CONTROL_PLANE_RTT_MS,
    });

    expect(deadline).toBe(7_500);
  });
});

describe("deriveSpecDeadlineMs", () => {
  it("is the variance-free derivation against the spec's own floor", () => {
    const spec = { floorMs: 1_000, roundTrips: 3 };

    // Below the floor while the measurement is small, and the derived value
    // once it is not: round(3 * 250) = 750 < 1_000, round(3 * 500) = 1_500.
    expect(deriveSpecDeadlineMs(spec, null)).toBe(1_000);
    expect(deriveSpecDeadlineMs(spec, 250)).toBe(1_000);
    expect(deriveSpecDeadlineMs(spec, 500)).toBe(1_500);
  });

  it("clamps the measured rtt at MAX_CONTROL_PLANE_RTT_MS", () => {
    const spec = { floorMs: 0, roundTrips: 2 };

    // Anchored to the arithmetic, not to the other call: comparing the two
    // derivations alone passes just as well with no clamp at all, since both
    // sides would move together.
    expect(deriveSpecDeadlineMs(spec, 60_000)).toBe(
      2 * MAX_CONTROL_PLANE_RTT_MS,
    );
    expect(deriveSpecDeadlineMs(spec, 60_000)).toBe(
      deriveSpecDeadlineMs(spec, MAX_CONTROL_PLANE_RTT_MS),
    );
  });

  it("treats a negative or zero rtt as the floor, never below it", () => {
    // Mutation: dropping `Math.max(rttMs, 0)` - a clock-skewed negative sample
    // would then SHORTEN every derived window instead of leaving the floor.
    const spec = { floorMs: 8_000, roundTrips: 4 };

    expect(deriveSpecDeadlineMs(spec, 0)).toBe(8_000);
    expect(deriveSpecDeadlineMs(spec, -500)).toBe(8_000);
    expect(deriveSpecDeadlineMs(spec, -100_000)).toBe(8_000);
    // With variance in play the clamp is observable rather than absorbed by
    // `Math.max(floorMs, ...)`: unclamped this reads -500 + 400 = -100 and
    // collapses to the floor, so the variance term buys nothing.
    expect(
      deriveRttDeadlineMs({
        floorMs: 0,
        roundTrips: 1,
        rttMs: -500,
        varianceMs: 100,
        maxRttMs: MAX_CONTROL_PLANE_RTT_MS,
      }),
    ).toBe(400);
  });

  it("floors a negative variance at 0 and rounds a fractional product", () => {
    // Mutation: dropping `Math.max(varianceMs, 0)` (a negative variance would
    // SHORTEN a liveness window below the measurement it is protecting), or
    // dropping `Math.round` (a fractional millisecond deadline).
    expect(
      deriveRttDeadlineMs({
        floorMs: 0,
        roundTrips: 1,
        rttMs: 100,
        varianceMs: -25,
        maxRttMs: MAX_CONTROL_PLANE_RTT_MS,
      }),
    ).toBe(100);
    expect(
      deriveRttDeadlineMs({
        floorMs: 0,
        roundTrips: 3,
        rttMs: 10.5,
        varianceMs: 0.1,
        maxRttMs: MAX_CONTROL_PLANE_RTT_MS,
      }),
    ).toBe(33);
  });
});
