import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { releasedStreamMethodNames } from "./__fixtures__/released-stream-method-names";

/**
 * Released method-name guard for the `/stream` handshake - the streaming
 * counterpart of `released-surface-compat.test.ts` (unary `/rpc`).
 *
 * `checkStreamCompatibility` (`@traycer/protocol/framework/stream-compat`) is
 * fail-closed on the same method-NAME union the unary `check()` uses: a
 * method name present on only one peer is a fatal `Incompatible methods`
 * error that makes EVERY `/stream` subscription fail against a peer on the
 * other version - not just the mismatched method. Before this test, only the
 * unary side had a frozen baseline; a brand-new `/stream` method name could
 * have shipped without ever tripping a guard, even though it breaks the
 * `/stream` handshake exactly the way `worktree.readScriptsAtRef` broke the
 * unary one against `host-v1.0.0`.
 *
 * So the method-name set is frozen to the last release a peer in the field
 * may still be running (`__fixtures__/released-stream-method-names.ts`, a
 * snapshot of `host-v1.0.0`'s `/stream` registry; regenerate with
 * `protocol/scripts/snapshot-released-stream-method-names.ts`). A new
 * capability must ride a new `{ major, minor }` of an EXISTING stream
 * method, never a new method name - exactly the unary rule, applied here.
 *
 * Scope: this guards only the handshake-fatal class (name-set mismatch). It
 * does NOT freeze per-method schemas - shipped stream schemas evolve
 * additively (e.g. `terminal.subscribe` has moved to 1.2 and `chat.subscribe`
 * to 1.1 since this baseline, with zero new method names - no live break
 * today). A genuinely breaking schema change must instead ride a version
 * bump, mirrored by `two-sided-stream-release-invariant.test.ts`.
 *
 * When this fails, either fold the capability into an existing stream
 * method and version it, or - for a coordinated release that drops support
 * for the baselined host - regenerate the baseline (the diff is the record
 * of that decision).
 */
describe("released stream method-name set (host-v1.0.0) is frozen", () => {
  it("advertises exactly the baselined /stream method names", () => {
    const current = Object.keys(hostStreamRpcRegistry).sort();
    expect(current).toEqual([...releasedStreamMethodNames].sort());
  });
});
