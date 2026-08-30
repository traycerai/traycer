import { describe, expect, it } from "vitest";
import {
  createRelayPathEstimator,
  MAX_RELAY_PATH_RTT_MS,
} from "../relay-liveness";
import {
  deriveDeadlineMs,
  deriveRttDeadlineMs,
} from "../../host/browser/control-plane-rtt";

describe("createRelayPathEstimator", () => {
  it("returns the floor unchanged before any sample completes", () => {
    const estimator = createRelayPathEstimator();
    expect(estimator.deadlineMs(5_000, 3)).toBe(5_000);
    expect(estimator.rttMs()).toBeNull();
  });

  it("seeds srtt=sample and rttvar=sample/2 from the first sample (RFC 6298 first-sample seed)", () => {
    const estimator = createRelayPathEstimator();
    estimator.noteRoundTrip(100);

    expect(estimator.rttMs()).toBe(100);
    // deadlineMs(floor, roundTrips) = max(floor, round(roundTrips * (srtt +
    // 4 * rttvar))) = max(floor, round(1 * (100 + 4 * 50))) = max(floor, 300).
    expect(estimator.deadlineMs(0, 1)).toBe(300);
  });

  it("converges toward 3 x srtt as identical samples drive rttvar to zero", () => {
    const estimator = createRelayPathEstimator();
    // Feed enough identical samples for the EWMA variance term to decay near
    // zero: each round multiplies rttvar by (1 - RTT_VAR_BETA) = 0.75.
    for (let i = 0; i < 100; i++) estimator.noteRoundTrip(100);

    expect(estimator.rttMs()).toBe(100);
    // With rttvar ~0, deadlineMs(0, 3) approaches round(3 * (100 + 4 * 0)) = 300.
    expect(estimator.deadlineMs(0, 3)).toBe(300);
  });

  it("clamps a sample above MAX_RELAY_PATH_RTT_MS before folding it in", () => {
    const estimator = createRelayPathEstimator();
    estimator.noteRoundTrip(MAX_RELAY_PATH_RTT_MS + 50_000);

    // The clamp applies before the first-sample seed, so srtt reads exactly
    // the ceiling, never the raw oversized sample.
    expect(estimator.rttMs()).toBe(MAX_RELAY_PATH_RTT_MS);
  });
});

// No dedicated suite exists yet under
// traycer/protocol/src/host/browser/__tests__/ for control-plane-rtt.ts, so
// these cases for `deriveRttDeadlineMs` (the shared arithmetic
// `createRelayPathEstimator.deadlineMs` above delegates to) live here instead.
describe("deriveRttDeadlineMs", () => {
  it("with varianceMs: 0 is exactly the old deriveDeadlineMs", () => {
    const spec = { floorMs: 1_000, roundTrips: 3 };
    const rttMs = 250;

    expect(
      deriveRttDeadlineMs({
        floorMs: spec.floorMs,
        roundTrips: spec.roundTrips,
        rttMs,
        varianceMs: 0,
        maxRttMs: MAX_RELAY_PATH_RTT_MS,
      }),
    ).toBe(deriveDeadlineMs(spec, rttMs, spec.floorMs));
  });

  it("applies the 4x variance term", () => {
    // max(floor, round(roundTrips * (rtt + 4 * variance)))
    // = max(0, round(2 * (100 + 4 * 25))) = round(2 * 200) = 400.
    const deadline = deriveRttDeadlineMs({
      floorMs: 0,
      roundTrips: 2,
      rttMs: 100,
      varianceMs: 25,
      maxRttMs: MAX_RELAY_PATH_RTT_MS,
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
      maxRttMs: MAX_RELAY_PATH_RTT_MS,
    });

    expect(deadline).toBe(7_500);
  });
});
