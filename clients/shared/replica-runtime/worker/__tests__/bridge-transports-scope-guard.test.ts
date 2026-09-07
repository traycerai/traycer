/** The worker-scope guard, both directions. */
import { describe, expect, it, vi } from "vitest";

import { resolveWorkerScopeTransport } from "../bridge-transports";

function createWorkerScopeDouble(): object {
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    // Present but throwing is what a module worker's scope really does; the
    // guard reads its type and never calls it.
    importScripts: (): never => {
      throw new TypeError("importScripts is not available in module workers");
    },
  };
}

/**
 * A window as this guard sees one.
 * `document` is the marker; the three message-target members are the ones that used to be the whole check, so a double without them would pass for the wrong reason.
 */
function createWindowDouble(): object {
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    document: { title: "" },
  };
}

describe("resolveWorkerScopeTransport", () => {
  it("resolves a dedicated worker scope", () => {
    const scope = createWorkerScopeDouble();

    const transport = resolveWorkerScopeTransport(scope);

    // Resolving is not enough on its own - a transport that never reaches the
    // scope would satisfy a truthiness check.
    transport.post("frame", []);
    expect(scope).toHaveProperty("postMessage");
    const posted = Reflect.get(scope, "postMessage");
    expect(posted).toHaveBeenCalledWith("frame", []);
  });

  it("throws on a window, naming the module and the thread", () => {
    expect(() => resolveWorkerScopeTransport(createWindowDouble())).toThrow(
      /epic-runtime-worker-entry/,
    );
    expect(() => resolveWorkerScopeTransport(createWindowDouble())).toThrow(
      /main thread/,
    );
  });

  it("throws on a window even though it satisfies the message-target shape", () => {
    const windowDouble = createWindowDouble();

    // The exact statement of the defect: this object answers yes to every
    // question the old guard asked, and it is not a worker scope.
    expect(typeof Reflect.get(windowDouble, "postMessage")).toBe("function");
    expect(typeof Reflect.get(windowDouble, "addEventListener")).toBe(
      "function",
    );
    expect(typeof Reflect.get(windowDouble, "removeEventListener")).toBe(
      "function",
    );
    expect(() => resolveWorkerScopeTransport(windowDouble)).toThrow();
  });

  it("throws on a scope that cannot exchange messages at all", () => {
    expect(() =>
      resolveWorkerScopeTransport({ importScripts: vi.fn() }),
    ).toThrow(/cannot send or receive messages/);
  });

  it("reads `document` through the prototype chain", () => {
    // Deliberately not a faithful model of any real scope: it carries `importScripts` so that the `document` marker is the only thing left that can reject it.
    // Without that member the guard rejects on the missing marker instead, and this test passes under an own-property read of `document` too - which is what it is here to rule out.
    const inheritedDocument: object = Object.create({
      document: { title: "" },
    });
    Object.assign(inheritedDocument, {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      importScripts: vi.fn(),
    });

    expect(
      Object.prototype.hasOwnProperty.call(inheritedDocument, "document"),
    ).toBe(false);
    expect(Reflect.get(inheritedDocument, "document")).toBeDefined();
    expect(() => resolveWorkerScopeTransport(inheritedDocument)).toThrow(
      /main thread/,
    );
  });
});
