import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "./__fixtures__/released-method-names";

/**
 * Released method-name guard for the unary `/rpc` handshake.
 *
 * The released floor is fail-closed on the METHOD-NAME SET: a method name
 * present on only one peer is a fatal `Incompatible methods` error that makes
 * EVERY RPC fail against a peer on the other version. That is exactly how
 * `1.0.1-rc.1` broke against the shipped `host-v1.0.0` -
 * `worktree.readScriptsAtRef` was added as a NEW method name.
 *
 * The method-name set is frozen to the last release a peer in the field may
 * still be running (`__fixtures__/released-method-names.ts`, a floor-only
 * snapshot of `host-v1.0.0`; regenerate it with
 * `protocol/scripts/snapshot-released-method-names.ts`). New unary methods
 * live on the optional-capabilities channel, declare their behavior when an
 * old peer does not advertise them, and never enter this snapshot.
 *
 * ROLE: this test is a FAST LOCAL TRIPWIRE only. The authoritative gate is the
 * `protocol-compat` CI workflow, which dumps every released baseline's surface
 * from its immutable git tag (`protocol/scripts/compat/`) - a baseline no PR
 * can edit. Editing the fixture here does NOT change what CI verifies (that
 * edit-the-fixture path is exactly how `terminal.defaultCwd` shipped
 * handshake-incompatible in #227), and the fixture file itself is tripwired:
 * changing it requires the `protocol-compat-override` label.
 *
 * Scope: this guards only the handshake-fatal class (name-set mismatch). It does
 * NOT freeze per-method schemas - the CI gate covers those (same-version
 * wire-schema rules with reviewed exceptions in `compat-exceptions.json`).
 *
 * When this fails, restore the released floor rather than adding the method to
 * it. Then register the additive method with an explicit degradation strategy.
 */
describe("released method-name set (host-v1.0.0) is frozen", () => {
  it("keeps every released method in the registry", () => {
    // Post-#272 the registry may grow ADDITIVE optional methods beyond the
    // floor; those ride the optional manifest channel and are not
    // handshake-fatal. The frozen floor itself must remain fully present, and
    // `RELEASED_FLOOR_METHOD_NAMES` (the canonical floor export other modules
    // key off of) must stay in sync with this guarded fixture.
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
