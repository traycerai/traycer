import { describe, expect, it } from "vitest";
import {
  claimShutdownRequestSchema,
  releaseShutdownRequestSchema,
  SHUTDOWN_CLAIM_MAX_TTL_MS,
} from "../schemas";
import {
  lifecycleClaimShutdownUpgradeV10ToV11,
  lifecycleClaimShutdownV10,
  lifecycleClaimShutdownV11,
} from "../contracts";
import { hostRpcRegistry } from "../../registry";

describe("shutdown lifecycle contracts", () => {
  it("rejects an unschedulable shutdown claim TTL at the protocol boundary", () => {
    expect(
      claimShutdownRequestSchema.safeParse({
        transitionId: "transition-1",
        ttl: SHUTDOWN_CLAIM_MAX_TTL_MS,
      }).success,
    ).toBe(true);
    expect(
      claimShutdownRequestSchema.safeParse({
        transitionId: "transition-1",
        ttl: 2 ** 40,
      }).success,
    ).toBe(false);
  });

  it("registers releaseShutdown as an optional, bearer-token recovery arm", () => {
    expect(
      releaseShutdownRequestSchema.parse({ token: "claim-token" }),
    ).toEqual({
      token: "claim-token",
    });
    expect(hostRpcRegistry["lifecycle.releaseShutdown"]).toMatchObject({
      degrade: { kind: "unsupported" },
    });
  });

  describe("claimShutdown@1.1 restart-intent negotiation", () => {
    it("upgrades a @1.0 request to intent 'shutdown' by VALUE, and leaves the other fields untouched", () => {
      // Not merely "a value exists": defaulting to "restart" instead would
      // make every old CLI's `host stop` publish a tombstone and hold every
      // attached client in `restarting-expected` for a host that is never
      // coming back - the failure this upgrade path exists to prevent.
      const upgraded = lifecycleClaimShutdownUpgradeV10ToV11.upgradeRequest({
        transitionId: "transition-legacy",
        ttl: 30_000,
      });
      expect(upgraded).toEqual({
        transitionId: "transition-legacy",
        ttl: 30_000,
        intent: "shutdown",
      });
      expect(upgraded.intent).toBe("shutdown");
    });

    it("registers lifecycle.claimShutdown's canonical version as {major:1, minor:1} with 1.0 still installed under its own contract", () => {
      const entry = hostRpcRegistry["lifecycle.claimShutdown"];
      expect(entry[1].latestMinor).toBe(1);
      expect(entry[1].versions[0]?.contract).toBe(lifecycleClaimShutdownV10);
      expect(entry[1].versions[0]?.upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].versions[1]?.contract).toBe(lifecycleClaimShutdownV11);
      expect(entry[1].versions[1]?.upgradeFromPreviousVersion).toBe(
        lifecycleClaimShutdownUpgradeV10ToV11,
      );
    });
  });
});
