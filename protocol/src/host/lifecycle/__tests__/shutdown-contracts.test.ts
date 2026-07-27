import { describe, expect, it } from "vitest";
import {
  claimShutdownRequestSchema,
  releaseShutdownRequestSchema,
  SHUTDOWN_CLAIM_MAX_TTL_MS,
} from "../schemas";
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
});
