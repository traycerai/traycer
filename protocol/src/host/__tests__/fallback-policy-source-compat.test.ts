import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  createDefaultFallbackPolicy,
  providersFallbackPolicyGetResponseSchemaV10,
  providersFallbackPolicyGetResponseSchemaV20,
} from "@traycer/protocol/host/fallback-policy";

/**
 * `providers.fallbackPolicy.get`'s 2.1 `source` field (A13), through the REAL
 * registry's upgrade/downgrade paths rather than a hand-built contract:
 * a 2.0 host's response upgrades to 2.1 with `source: "own"`; a 2.0 response
 * still parses on the frozen V20 schema with every field 2.0 shipped; and the
 * 2.1 -> 1.1 downgrade still answers the 1.1 line's own shape.
 */

const POLICY = createDefaultFallbackPolicy();

describe("providers.fallbackPolicy.get: the 2.1 source field", () => {
  it('the 2.0 -> 2.1 upgrade fills source: "own"', () => {
    const v20Response = providersFallbackPolicyGetResponseSchemaV20.parse({
      policy: POLICY,
      storedPolicyUnreadable: false,
      inFlightCount: 2,
    });

    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.fallbackPolicy.get"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      v20Response,
    );

    expect(upgraded).toEqual({ ...v20Response, source: "own" });
  });

  it("a 2.0 response parses on the frozen V20 schema with every field 2.0 shipped intact", () => {
    const raw = {
      policy: POLICY,
      storedPolicyUnreadable: true,
      inFlightCount: 3,
    };

    const parsed = providersFallbackPolicyGetResponseSchemaV20.parse(raw);

    expect(parsed).toEqual(raw);
  });

  it("the 2.1 -> 1.1 downgrade still answers what the 1.1 line expects", () => {
    const v21Response = {
      policy: POLICY,
      storedPolicyUnreadable: false,
      inFlightCount: 0,
      source: "team" as const,
    };

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.fallbackPolicy.get"],
      2,
      1,
      v21Response,
    );

    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value).not.toHaveProperty("source");
    const parsed = providersFallbackPolicyGetResponseSchemaV10.safeParse(
      downgraded.value,
    );
    expect(parsed.success).toBe(true);
  });
});
