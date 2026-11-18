/**
 * The entry's documented promise, against a real window.
 *
 * `bridge-transports-scope-guard.test.ts` in `clients/shared` pins the guard
 * FUNCTION against shaped doubles. This pins the PROMISE: importing the actual
 * entry module on a thread that has a `document` fails, and fails with an
 * error a developer can act on.
 *
 * It is worth having both because the promise is the thing that was false. The
 * guard used to check the message-target shape alone - `postMessage`,
 * `addEventListener`, `removeEventListener` - and a `Window` has all three, so
 * this import used to SUCCEED and leave a runtime posting frames into the page
 * and answering nothing. jsdom's `globalThis` is the closest thing a suite in
 * this package has to the window the mistake happens on, which is why the
 * check runs against the ambient global rather than a double.
 */
import { describe, expect, it } from "vitest";

import { resolveWorkerScopeTransport } from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";

describe("the runtime worker entry on the main thread", () => {
  it("runs in a scope that satisfies the message-target shape", () => {
    // The premise of everything below: this really is the shape the old guard
    // accepted. Without this the two tests that follow could be passing
    // because jsdom's global is missing something unrelated.
    expect(typeof Reflect.get(globalThis, "postMessage")).toBe("function");
    expect(typeof Reflect.get(globalThis, "addEventListener")).toBe("function");
    expect(typeof Reflect.get(globalThis, "removeEventListener")).toBe(
      "function",
    );
    expect(Reflect.get(globalThis, "document")).toBeDefined();
  });

  it("throws from the guard when handed the real ambient global", () => {
    expect(() => resolveWorkerScopeTransport(globalThis)).toThrow(
      /epic-runtime-worker-entry was loaded on the main thread/,
    );
  });

  it("fails the import of the real entry module", async () => {
    // The module is three lines and the last one runs on import, so importing
    // it IS running it. A rejection whose message names the module and the
    // thread is the whole guarantee; matching on that text rather than on
    // "rejects" keeps an unrelated module-resolution failure from passing for
    // it.
    await expect(import("../epic-runtime-worker-entry")).rejects.toThrow(
      /epic-runtime-worker-entry was loaded on the main thread/,
    );
  });
});
