import { describe, expect, it } from "vitest";
import { hostRestartUpgradeV10ToV11 } from "@traycer/protocol/host/restart/contracts";
import { hostRestartResponseSchema } from "@traycer/protocol/host/restart/schemas";

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
    expect(hostRestartResponseSchema.parse(upgraded)).toEqual(upgraded);
  });

  it("passes an accepted response through unchanged", () => {
    const v10Response = { outcome: "accepted" as const };

    const upgraded = hostRestartUpgradeV10ToV11.upgradeResponse(v10Response);

    expect(upgraded).toEqual({ outcome: "accepted" });
    expect(hostRestartResponseSchema.parse(upgraded)).toEqual(upgraded);
  });
});
