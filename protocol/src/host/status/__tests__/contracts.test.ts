import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  hostBusyBreakdownSchema,
  hostStatusUpgradeV10ToV11,
  hostStatusUpgradeV11ToV12,
  hostStatusV10,
  hostStatusV11,
  hostStatusV12,
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
      expect(
        Object.is(upgraded.busySessionCount, genuineZero.busySessionCount),
      ).toBe(false);
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

const V11_RESPONSE = {
  ...V10_RESPONSE,
  busy: true,
  busySessionCount: 3,
  updateProgress: null,
};

const BUSY_BREAKDOWN = {
  workingAgents: 2,
  activeTerminalAgents: 1,
  busyTerminals: 0,
};

describe("hostStatusUpgradeV11ToV12", () => {
  it("upgrades a v1.1 response with busyBreakdown: null, NOT a fabricated zero object", () => {
    const parsed = hostStatusV11.responseSchema.parse(V11_RESPONSE);
    const upgraded = hostStatusUpgradeV11ToV12.upgradeResponse(parsed);
    expect(upgraded.busyBreakdown).toBeNull();
    expect(upgraded.busySessionCount).toBe(3);
    expect(upgraded.busy).toBe(true);
    expect(() => hostStatusV12.responseSchema.parse(upgraded)).not.toThrow();
  });

  it("leaves the request identity-mapped", () => {
    expect(hostStatusUpgradeV11ToV12.upgradeRequest({})).toEqual({});
  });

  describe("null vs a genuine zero breakdown — different claims", () => {
    it("an upgraded v1.1 host's breakdown is null (never reported), not zeros", () => {
      const parsed = hostStatusV11.responseSchema.parse(V11_RESPONSE);
      const upgraded = hostStatusUpgradeV11ToV12.upgradeResponse(parsed);
      expect(upgraded.busyBreakdown).toBeNull();
      expect(upgraded.busyBreakdown).not.toEqual({
        workingAgents: 0,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      });
    });

    it("a real v1.2 host reporting a zero breakdown parses as zeros, not null", () => {
      const genuineZero = hostStatusV12.responseSchema.parse({
        ...V11_RESPONSE,
        busy: false,
        busySessionCount: 0,
        busyBreakdown: {
          workingAgents: 0,
          activeTerminalAgents: 0,
          busyTerminals: 0,
        },
      });
      expect(genuineZero.busyBreakdown).toEqual({
        workingAgents: 0,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      });
      expect(genuineZero.busyBreakdown).not.toBeNull();
    });
  });
});

describe("host.status@1.2 busyBreakdown", () => {
  it("round-trips a populated breakdown", () => {
    const payload = {
      ...V11_RESPONSE,
      busyBreakdown: BUSY_BREAKDOWN,
    };
    const parsed = hostStatusV12.responseSchema.parse(payload);
    expect(parsed.busyBreakdown).toEqual(BUSY_BREAKDOWN);
    expect(hostBusyBreakdownSchema.parse(BUSY_BREAKDOWN)).toEqual(
      BUSY_BREAKDOWN,
    );
  });

  it("round-trips busyBreakdown: null", () => {
    const parsed = hostStatusV12.responseSchema.parse({
      ...V11_RESPONSE,
      busyBreakdown: null,
    });
    expect(parsed.busyBreakdown).toBeNull();
  });

  it("rejects a negative component", () => {
    expect(
      hostStatusV12.responseSchema.safeParse({
        ...V11_RESPONSE,
        busyBreakdown: { ...BUSY_BREAKDOWN, busyTerminals: -1 },
      }).success,
    ).toBe(false);
  });
});

describe("host.status registry membership", () => {
  it("installs @1.0, @1.1, and @1.2 on the unary registry at major 1", () => {
    const entry = hostRpcRegistry["host.status"];
    expect(entry).toBeDefined();
    expect(entry[1].latestMinor).toBe(2);
    expect(entry[1].versions[0].contract).toBe(hostStatusV10);
    expect(entry[1].versions[1].contract).toBe(hostStatusV11);
    expect(entry[1].versions[2].contract).toBe(hostStatusV12);
    expect(entry[1].versions[2].upgradeFromPreviousVersion).toBe(
      hostStatusUpgradeV11ToV12,
    );
  });
});
