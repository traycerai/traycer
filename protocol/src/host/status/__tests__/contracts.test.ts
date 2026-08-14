import { describe, expect, it } from "vitest";
import {
  hostStatusUpgradeV10ToV11,
  hostStatusV10,
  hostStatusV11,
} from "../contracts";

const V10_RESPONSE = {
  ready: true,
  hostVersion: "1.3.0",
  protocolVersion: { major: 1, minor: 0 },
};

describe("hostStatusUpgradeV10ToV11", () => {
  it("upgrades a v1.0 response with busySessionCount: null, NOT a fabricated 0", () => {
    const parsed = hostStatusV10.responseSchema.parse(V10_RESPONSE);
    const upgraded = hostStatusUpgradeV10ToV11.upgradeResponse(parsed);
    expect(upgraded.busySessionCount).toBeNull();
    expect(upgraded.busy).toBe(false);
    expect(upgraded.updateProgress).toBeNull();
    // The upgraded shape must itself satisfy v1.1's schema — a nullable
    // count is only useful downstream if the contract it upgrades INTO
    // actually accepts it.
    expect(() => hostStatusV11.responseSchema.parse(upgraded)).not.toThrow();
  });

  it("leaves the request identity-mapped", () => {
    expect(hostStatusUpgradeV10ToV11.upgradeRequest({})).toEqual({});
  });

  // The review's point: a test that asserts the SAME observable shape for
  // both an upgraded (never-reported) count and a genuine zero would still
  // pass if the upgrade normalized `null` back to `0` with `?? 0`. These
  // assert two DIFFERENT fields of the parsed result — presence-ness via
  // `toBeNull`/`toBe(0)`, and the raw value each round-trips to — so a
  // regression collapsing them back together fails at least one assertion
  // here, not zero.
  describe("null vs a genuine zero — different claims, asserted as different fields", () => {
    it("an upgraded v1.0 host's count is null (never reported), not zero", () => {
      const parsed = hostStatusV10.responseSchema.parse(V10_RESPONSE);
      const upgraded = hostStatusUpgradeV10ToV11.upgradeResponse(parsed);
      expect(upgraded.busySessionCount).toBeNull();
      expect(upgraded.busySessionCount).not.toBe(0);
    });

    it("a real v1.1 host reporting zero parses as the number 0, not null", () => {
      const genuineZero = hostStatusV11.responseSchema.parse({
        ...V10_RESPONSE,
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
      });
      expect(genuineZero.busySessionCount).toBe(0);
      expect(genuineZero.busySessionCount).not.toBeNull();
    });

    it("the two results are not interchangeable under strict equality", () => {
      const parsed = hostStatusV10.responseSchema.parse(V10_RESPONSE);
      const upgraded = hostStatusUpgradeV10ToV11.upgradeResponse(parsed);
      const genuineZero = hostStatusV11.responseSchema.parse({
        ...V10_RESPONSE,
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
      });
      expect(upgraded).not.toEqual(genuineZero);
      expect(Object.is(upgraded.busySessionCount, genuineZero.busySessionCount)).toBe(
        false,
      );
    });
  });

  it("rejects a v1.1 response schema that still fabricates 0 for an absent count", () => {
    // Documents WHY the upgrade must not go back to `?? 0`: v1.1's schema
    // itself accepts a real 0 as valid data (it is not distinguishable at
    // the wire level), so the guarantee has to live in the upgrade function,
    // not in something the schema can catch. This pins the function's
    // output directly rather than relying on a schema rejection that does
    // not exist.
    const parsed = hostStatusV10.responseSchema.parse(V10_RESPONSE);
    const upgraded = hostStatusUpgradeV10ToV11.upgradeResponse(parsed);
    expect(upgraded.busySessionCount).not.toBe(0);
  });
});
