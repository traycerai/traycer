import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { releasedMethodNames } from "./__fixtures__/released-method-names";

/**
 * Released method-name guard for the unary `/rpc` handshake.
 *
 * The per-method handshake (`compatibility-checker`) is fail-closed on the
 * METHOD-NAME SET: a method name present on only one peer is a fatal
 * `Incompatible methods` error that makes EVERY RPC fail against a peer on the
 * other version. That is exactly how `1.0.1-rc.1` broke against the shipped
 * `host-v1.0.0` - `worktree.readScriptsAtRef` was added as a NEW method name.
 *
 * So the method-name set is frozen to the last release a peer in the field may
 * still be running (`__fixtures__/released-method-names.ts`, a snapshot of
 * `host-v1.0.0`; regenerate with
 * `protocol/scripts/snapshot-released-method-names.ts`). A new capability must
 * ride a new `{ major, minor }` of an EXISTING method, never a new method name.
 *
 * Scope: this guards only the handshake-fatal class (name-set mismatch). It does
 * NOT freeze per-method schemas - shipped schemas evolve additively in this
 * codebase (a new harness/provider adds an enum value, etc.), which the handshake
 * tolerates within a version. A genuinely breaking schema change must instead
 * ride a version bump (as `host.getRateLimitUsage` now does for `accountContext`).
 *
 * When this fails, either fold the capability into an existing method and version
 * it, or - for a coordinated release that drops support for the baselined host -
 * regenerate the baseline (the diff is the record of that decision).
 */
describe("released method-name set (host-v1.0.0) is frozen", () => {
  it("advertises exactly the baselined method names", () => {
    const current = Object.keys(hostRpcRegistry).sort();
    expect(current).toEqual([...releasedMethodNames].sort());
  });
});
