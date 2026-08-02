import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { releasedStreamMethodNames } from "./__fixtures__/released-stream-method-names";

/**
 * Released method-name guard for the `/stream` handshake - the streaming
 * counterpart of `released-surface-compat.test.ts` (unary `/rpc`), but with a
 * deliberately different invariant, because `/stream` compatibility is checked
 * PER METHOD at subscribe time, not once over a method-name union.
 *
 * The unary `/rpc` handshake runs a single fail-closed `check()` over the
 * method-NAME union of both peers, so a name present on only one side is
 * handshake-fatal for the WHOLE connection. `/stream` does not work that way:
 * at runtime each subscription calls
 * `checkStreamMethodCompatibility(registry, mine, theirs, role, method)` for
 * exactly the one method being subscribed (`ws-stream-client.ts` ~L688 and the
 * host's stream-connection-handler). A method name that exists on only one
 * peer therefore affects only subscriptions to THAT method - every other
 * stream subscription still succeeds. And when a client subscribes to a method
 * the host is missing, the client does not fail the connection: it caches the
 * "method unsupported" result and quietly degrades that one feature (the
 * capability cache in `ws-stream-client.ts`, pinned by its own tests).
 *
 * So the real, asymmetric invariant this test guards is:
 *
 *   - REMOVING a baselined method name is breaking. A peer still running the
 *     baselined release (`__fixtures__/released-stream-method-names.ts`, a
 *     snapshot of `host-v1.0.0`'s `/stream` registry) may still subscribe to
 *     it; dropping it turns that subscription into a permanent per-method
 *     downgrade with no path back. That is what we must never do silently.
 *
 *   - ADDING a new method name is safe and additive. A released peer that has
 *     never heard of the new method simply never subscribes to it; a newer
 *     peer that does gets a clean per-method check, and a host-missing method
 *     degrades quietly rather than breaking the handshake. This is why a new
 *     `/stream` method name (e.g. `resources.subscribe`, merged after this
 *     baseline) is allowed to appear without tripping the guard.
 *
 * Hence: assert the released names are a SUBSET of today's registry (no
 * removals), not an exact-equal set. Regenerate the baseline with
 * `protocol/scripts/snapshot-released-stream-method-names.ts` only for a
 * coordinated release that deliberately drops support for the baselined host -
 * the diff is the record of that decision.
 */
describe("released stream method-name set (host-v1.0.0) is not dropped", () => {
  it("still advertises every baselined /stream method name (additions allowed)", () => {
    const current = new Set(Object.keys(hostStreamRpcRegistry));
    const removed = releasedStreamMethodNames.filter(
      (method) => !current.has(method),
    );
    expect(
      removed,
      removed.length === 0
        ? undefined
        : `baselined /stream method names removed from hostStreamRpcRegistry: ${JSON.stringify(removed)}`,
    ).toEqual([]);
  });
});
