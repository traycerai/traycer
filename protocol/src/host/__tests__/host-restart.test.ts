import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  hostRestartUpgradeV10ToV11,
  hostRestartUpgradeV11ToV12,
  hostRestartV10,
  hostRestartV11,
  hostRestartV12,
} from "@traycer/protocol/host/restart/contracts";
import {
  hostRestartResponseSchema,
  hostRestartResponseV11Schema,
} from "@traycer/protocol/host/restart/schemas";

/**
 * `blockers: null` is the deliberate upgrade answer, NOT a fabricated
 * all-false: a v1.0 host never stated which deny signals refused the claim,
 * so the client must not put an affirmative "nothing is blocking" in a v1.0
 * host's mouth. See `hostRestartUpgradeV10ToV11`'s own comment for the
 * distinction this test pins.
 */
describe("hostRestartUpgradeV10ToV11.upgradeResponse", () => {
  it("maps a v1.0 busy response to blockers: null, leaving the count untouched", () => {
    const v10Response = {
      outcome: "busy" as const,
      verdict: { busySessionCount: 3 },
    };

    const upgraded = hostRestartUpgradeV10ToV11.upgradeResponse(v10Response);

    expect(upgraded).toEqual({
      outcome: "busy",
      verdict: { busySessionCount: 3, blockers: null },
    });
    // The bridged result is a valid v1.1 response.
    expect(hostRestartResponseV11Schema.parse(upgraded)).toEqual(upgraded);
  });

  it("passes an accepted response through unchanged", () => {
    const v10Response = { outcome: "accepted" as const };

    const upgraded = hostRestartUpgradeV10ToV11.upgradeResponse(v10Response);

    expect(upgraded).toEqual({ outcome: "accepted" });
    expect(hostRestartResponseV11Schema.parse(upgraded)).toEqual(upgraded);
  });
});

/**
 * `busyBreakdown: null` is the deliberate upgrade answer, NOT a fabricated
 * zero object: a v1.1 host never stated how the total splits, so the client
 * must not put an affirmative "idle by every kind" in a v1.1 host's mouth.
 */
describe("hostRestartUpgradeV11ToV12.upgradeResponse", () => {
  it("maps a v1.1 busy response to busyBreakdown: null, leaving count and blockers untouched", () => {
    const v11Response = {
      outcome: "busy" as const,
      verdict: {
        busySessionCount: 3,
        blockers: { workingAgents: true, runningTerminals: false },
      },
    };

    const upgraded = hostRestartUpgradeV11ToV12.upgradeResponse(v11Response);

    expect(upgraded).toEqual({
      outcome: "busy",
      verdict: {
        busySessionCount: 3,
        blockers: { workingAgents: true, runningTerminals: false },
        busyBreakdown: null,
      },
    });
    expect(hostRestartResponseSchema.parse(upgraded)).toEqual(upgraded);
  });

  it("passes an accepted response through unchanged", () => {
    const v11Response = { outcome: "accepted" as const };

    const upgraded = hostRestartUpgradeV11ToV12.upgradeResponse(v11Response);

    expect(upgraded).toEqual({ outcome: "accepted" });
    expect(hostRestartResponseSchema.parse(upgraded)).toEqual(upgraded);
  });
});

describe("host.restart@1.2 busyBreakdown", () => {
  it("round-trips a populated breakdown on the busy arm", () => {
    const payload = {
      outcome: "busy" as const,
      verdict: {
        busySessionCount: 3,
        blockers: { workingAgents: true, runningTerminals: true },
        busyBreakdown: {
          workingAgents: 2,
          activeTerminalAgents: 1,
          busyTerminals: 0,
        },
      },
    };
    expect(hostRestartResponseSchema.parse(payload)).toEqual(payload);
  });
});

describe("host.restart registry membership", () => {
  it("installs @1.0, @1.1, and @1.2 on the unary registry at major 1", () => {
    const entry = hostRpcRegistry["host.restart"];
    expect(entry).toBeDefined();
    expect(entry[1].latestMinor).toBe(2);
    expect(entry[1].versions[0].contract).toBe(hostRestartV10);
    expect(entry[1].versions[1].contract).toBe(hostRestartV11);
    expect(entry[1].versions[2].contract).toBe(hostRestartV12);
    expect(entry[1].versions[2].upgradeFromPreviousVersion).toBe(
      hostRestartUpgradeV11ToV12,
    );
  });
});
