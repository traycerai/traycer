import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "./__fixtures__/released-method-names";

/**
 * Released method-name guard for the unary `/rpc` handshake.
 * Scope: this guards only the handshake-fatal class (name-set mismatch).
 */
describe("released method-name set (host-v1.0.0) is frozen", () => {
  it("keeps every released method in the registry", () => {
    // Post-#272 the registry may grow ADDITIVE optional methods beyond the floor; those ride the optional manifest channel and are not handshake-fatal.
    // The frozen floor itself must remain fully present, and `RELEASED_FLOOR_METHOD_NAMES` (the canonical floor export other modules key off of) must stay in sync with this guarded fixture.
    expect([...RELEASED_FLOOR_METHOD_NAMES].sort()).toEqual(
      [...releasedMethodNames].sort(),
    );
    expect(Object.keys(hostRpcRegistry)).toEqual(
      expect.arrayContaining([...releasedMethodNames]),
    );
  });

  it("requires each optional method to state its missing-peer behavior", () => {
    for (const [method, registry] of Object.entries(hostRpcRegistry)) {
      if (RELEASED_FLOOR_METHOD_NAMES.includes(method)) continue;
      expect(Object.hasOwn(registry, "degrade")).toBe(true);
    }
  });
});
