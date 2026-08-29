import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  gateClears,
  isAdoptionObservationHealthy,
  isBackfillObservationHealthy,
  isJournalObservationHealthy,
  isLegacyMarkerObservationHealthy,
  isTerminalizationObservationHealthy,
} from "../cutover-telemetry";

// Direct unit suite for the Ticket 07 §4.2 shadow/telemetry gates.

describe("gate readings — no samples is not a passing grade", () => {
  it("zero observations reads as insufficient-data, NOT a healthy ratio", () => {
    // The failure this exists to prevent: `0 / 0` rendering as "0 failures"
    // and certifying a fleet the gate never observed. An unknown that reads as
    // a pass is the fabrication class this epic keeps finding.
    expect(evaluateGate({ total: 0, healthy: 0 }, 1)).toEqual({
      kind: "insufficient-data",
      total: 0,
    });
  });

  it("below the caller's declared minimum reads as insufficient-data", () => {
    expect(evaluateGate({ total: 9, healthy: 9 }, 10)).toEqual({
      kind: "insufficient-data",
      total: 9,
    });
  });

  it("a perfect but tiny sample does NOT clear a threshold", () => {
    // Load-bearing pairing: `healthy === total` would make any ratio-only
    // check pass. The sample size is what stops one lucky host from
    // certifying the fleet.
    const reading = evaluateGate({ total: 1, healthy: 1 }, 10);
    expect(gateClears(reading, 1)).toBe(false);
  });

  it("measures once the sample is sufficient", () => {
    expect(evaluateGate({ total: 10, healthy: 8 }, 10)).toEqual({
      kind: "measured",
      ratio: 0.8,
      total: 10,
    });
  });

  it("gateClears compares the ratio, and treats the threshold as inclusive", () => {
    const reading = evaluateGate({ total: 10, healthy: 8 }, 10);
    expect(gateClears(reading, 0.8)).toBe(true);
    expect(gateClears(reading, 0.81)).toBe(false);
  });
});

describe("per-gate observation shaping", () => {
  it("gate 1 — only a concrete owner is healthy backfill", () => {
    expect(isBackfillObservationHealthy("owned")).toBe(true);
    expect(isBackfillObservationHealthy("unknown")).toBe(false);
  });

  it.each([
    ["decoded-settled", true],
    ["decoded-in-flight", false],
    ["undecodable", false],
  ] as const)("gate 2 — journal %s is healthy=%s", (observation, healthy) => {
    // In-flight-at-boot is unhealthy even though failing closed on it is
    // CORRECT behaviour: the gate measures how often the veto fires, not
    // whether firing is right.
    expect(isJournalObservationHealthy(observation)).toBe(healthy);
  });

  it("gate 3 — consumes the fence's own decision rather than re-deriving it", () => {
    // A marker with no live attempt is the pre-cutover world working normally.
    expect(
      isLegacyMarkerObservationHealthy({
        legacyMarkerPresent: true,
        attemptPhase: null,
      }),
    ).toBe(true);
    // A marker DURING a live attempt is the lock-blind actor this gate exists
    // to count - and it is the same judgement the fence aborts on. If these
    // two ever disagreed, the fleet metric would read clear while attempts
    // were being aborted in the field.
    expect(
      isLegacyMarkerObservationHealthy({
        legacyMarkerPresent: true,
        attemptPhase: "applying",
      }),
    ).toBe(false);
    expect(
      isLegacyMarkerObservationHealthy({
        legacyMarkerPresent: false,
        attemptPhase: "applying",
      }),
    ).toBe(true);
  });

  it.each([
    ["consumed-once", true],
    ["not-consumed", false],
    ["consumed-twice", false],
  ] as const)("gate 4 — adoption %s is healthy=%s", (observation, healthy) => {
    // Both failures matter and neither outranks the other: nobody consuming
    // means the producer half is unreachable; two consumers means the one-shot
    // property broke.
    expect(isAdoptionObservationHealthy(observation)).toBe(healthy);
  });

  it.each([
    ["complete", true],
    ["failed", true],
    ["superseded", true],
    ["applying", false],
    ["restarting", false],
    ["waiting-to-activate", false],
  ] as const)("gate 5 — phase %s is terminal=%s", (phase, healthy) => {
    // Terminal means REACHED AN END, not "succeeded" - `failed` and
    // `superseded` are healthy for this gate because the class being measured
    // is stuck-forever, not unsuccessful.
    expect(isTerminalizationObservationHealthy(phase)).toBe(healthy);
  });
});

// F3 calibration controls (Ticket 07 fix round). The reviewer's exact probe
// was `{total: 10, healthy: 11}` reading `ratio: 1.1` and CLEARING a 0.99
// gate — an aggregation defect certifying a cutover on bad data. `malformed`
// exists to make that impossible: a defective sample must never reach the
// ratio arm `gateClears` compares against.
describe("gate readings — malformed samples never clear, at any threshold", () => {
  it("the reviewer's exact probe — {total: 10, healthy: 11} is malformed, not a 110% pass", () => {
    const reading = evaluateGate({ total: 10, healthy: 11 }, 1);
    expect(reading).toEqual({
      kind: "malformed",
      defect: "healthy-exceeds-total",
    });
    // THE POINT: a defect must clear NOTHING, including a threshold of 0 —
    // the exact case that let `ratio: 1.1` slip through as a pass before.
    for (const threshold of [0, 0.01, 0.5, 0.99, 1]) {
      expect(gateClears(reading, threshold)).toBe(false);
    }
  });

  it.each([
    [{ total: 10.5, healthy: 5 }, "not-a-count"],
    [{ total: 10, healthy: 5.5 }, "not-a-count"],
    [{ total: NaN, healthy: 5 }, "not-a-count"],
    [{ total: 10, healthy: NaN }, "not-a-count"],
    [{ total: Infinity, healthy: 5 }, "not-a-count"],
    [{ total: 10, healthy: Infinity }, "not-a-count"],
    [{ total: -1, healthy: 0 }, "negative"],
    [{ total: 10, healthy: -1 }, "negative"],
  ] as const)("sample %o is malformed with defect %s", (sample, defect) => {
    expect(evaluateGate(sample, 1)).toEqual({ kind: "malformed", defect });
  });

  it("a VALID sample still measures and still clears — the malformed arm did not break the ordinary path", () => {
    const reading = evaluateGate({ total: 10, healthy: 9 }, 10);
    expect(reading).toEqual({ kind: "measured", ratio: 0.9, total: 10 });
    expect(gateClears(reading, 0.9)).toBe(true);
    expect(gateClears(reading, 0.91)).toBe(false);
  });
});
