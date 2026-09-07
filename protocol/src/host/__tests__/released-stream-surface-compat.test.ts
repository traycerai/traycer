import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { releasedStreamMethodNames } from "./__fixtures__/released-stream-method-names";

/**
 * Stream method-name guard for the `/stream` surface.
 * A released peer that has never heard of the new method simply never subscribes to it.
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
 * The subset guard above deliberately allows new stream method names, so it cannot catch the specific mistake the browser surface cares about: the GUI feature-detects browser support by method presence in the host's.
 * Browser work must evolve `browser.sessions` / `browser.screencast` additively inside major 1 instead.
 */
describe("browser stream namespace is frozen", () => {
  it("exposes exactly browser.sessions and browser.screencast", () => {
    const browserMethods = Object.keys(hostStreamRpcRegistry)
      .filter((method) => method.startsWith("browser."))
      .sort();
    expect(browserMethods).toEqual(["browser.screencast", "browser.sessions"]);
  });
});
