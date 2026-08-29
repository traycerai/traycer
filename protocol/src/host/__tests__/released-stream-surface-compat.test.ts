import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { releasedStreamMethodNames } from "./__fixtures__/released-stream-method-names";

/**
 * Stream method-name guard for the `/stream` surface.
 *
 * `/stream` compatibility is checked PER METHOD at subscribe time, not once
 * over a method-name union the way unary `/rpc` does it. Each subscription
 * runs `checkStreamMethodCompatibility` for exactly the method being
 * subscribed, and a client subscribing to a method the host lacks caches the
 * "unsupported" result and degrades that one feature instead of failing the
 * connection. So the invariant here is asymmetric:
 *
 *   - REMOVING a baselined method name is breaking. A peer still running the
 *     baselined release may still subscribe to it, and dropping it turns that
 *     subscription into a permanent per-method downgrade with no path back.
 *
 *   - ADDING a method name is additive and safe. A released peer that has
 *     never heard of the new method simply never subscribes to it.
 *
 * Hence the baselined names must be a SUBSET of today's registry, not an
 * exact-equal set. Exact equality would make every unrelated stream method
 * added anywhere in the codebase fail this browser-owned baseline, which is a
 * maintenance trap rather than a safety property.
 *
 * Regenerate the baseline with
 * `protocol/scripts/snapshot-released-stream-method-names.ts` only for a
 * coordinated release that deliberately drops support for the baselined host -
 * the diff is the record of that decision.
 */
describe("released stream method-name set is not dropped", () => {
  it("still advertises every baselined stream method name (additions allowed)", () => {
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

/**
 * The subset guard above deliberately allows new stream method names, so it
 * cannot catch the specific mistake the browser surface cares about: the GUI
 * feature-detects browser support by method presence in the host's openAck
 * manifest, so a parallel `browser.*` stream name would be picked up as a new
 * capability rather than a versioned evolution of an existing one. Browser work
 * must evolve `browser.sessions` / `browser.screencast` additively inside
 * major 1 instead.
 */
describe("browser stream namespace is frozen", () => {
  it("exposes exactly browser.sessions and browser.screencast", () => {
    const browserMethods = Object.keys(hostStreamRpcRegistry)
      .filter((method) => method.startsWith("browser."))
      .sort();
    expect(browserMethods).toEqual(["browser.screencast", "browser.sessions"]);
  });
});
