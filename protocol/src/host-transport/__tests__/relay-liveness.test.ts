import { describe, expect, it } from "vitest";
import {
  createRelayPathEstimator,
  MAX_RELAY_PATH_RTT_MS,
} from "../relay-liveness";

// `deadlineMs(floor)` = max(floor, round(3 * (srtt + 4 * rttvar))): the
// round-trip multiplier is the estimator's own constant, not a caller's.
describe("createRelayPathEstimator", () => {
  it("returns the floor unchanged before any sample completes", () => {
    const estimator = createRelayPathEstimator();
    expect(estimator.deadlineMs(5_000)).toBe(5_000);
    expect(estimator.deadlineMs(0)).toBe(0);
  });

  it("seeds srtt=sample and rttvar=sample/2 from the first sample (RFC 6298 first-sample seed)", () => {
    const estimator = createRelayPathEstimator();
    estimator.notePingSent(0);
    estimator.notePongReceived(100);

    // round(3 * (100 + 4 * 50)) = 900.
    expect(estimator.deadlineMs(0)).toBe(900);
  });

  it("converges toward 3 x srtt as identical samples drive rttvar to zero", () => {
    const estimator = createRelayPathEstimator();
    // Each round multiplies rttvar by (1 - RTT_VAR_BETA) = 0.75.
    for (let i = 0; i < 100; i++) {
      estimator.notePingSent(i * 1_000);
      estimator.notePongReceived(i * 1_000 + 100);
    }

    expect(estimator.deadlineMs(0)).toBe(300);
  });

  it("clamps a sample above MAX_RELAY_PATH_RTT_MS before folding it in", () => {
    const estimator = createRelayPathEstimator();
    estimator.notePingSent(0);
    estimator.notePongReceived(MAX_RELAY_PATH_RTT_MS + 50_000);

    // srtt clamps to the ceiling (10s) and seeds rttvar at half of it, so the
    // window is round(3 * (10_000 + 4 * 5_000)) rather than the ~9 minutes the
    // raw sample would have produced.
    expect(estimator.deadlineMs(0)).toBe(90_000);
  });

  it("measures nothing from a run that had two pings outstanding (Karn)", () => {
    const estimator = createRelayPathEstimator();
    estimator.notePingSent(0);
    estimator.notePingSent(50);
    estimator.notePongReceived(100);

    expect(estimator.deadlineMs(0)).toBe(0);
  });

  it("measures nothing from the run that follows a retirement", () => {
    const estimator = createRelayPathEstimator();
    estimator.notePingSent(0);
    // The wake probe's ping: the open run is retired unsampled, and the pong
    // that eventually answers it carries the suspend, so it is not a sample.
    estimator.retireRun();
    estimator.notePingSent(10);
    estimator.notePongReceived(110);

    expect(estimator.deadlineMs(0)).toBe(0);
  });

  it("measures again on the run after the one a retirement poisoned", () => {
    const estimator = createRelayPathEstimator();
    estimator.notePingSent(0);
    estimator.retireRun();
    estimator.notePingSent(10);
    estimator.notePongReceived(110);
    // A retirement poisons ONE run. Leaving the flag set would keep every
    // later deadline at the floor for the whole socket lifetime.
    estimator.notePingSent(1_000);
    estimator.notePongReceived(1_100);

    expect(estimator.deadlineMs(0)).toBe(900);
  });
});
