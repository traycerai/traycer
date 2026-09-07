import { describe, expect, it } from "vitest";

import { resolveWorkerScopeTransport } from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";

describe("the runtime worker entry on the main thread", () => {
  it("runs in a scope that satisfies the message-target shape", () => {
    // Without this the two tests that follow could be passing because jsdom's global is missing
    // something unrelated.
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
    // The module is three lines and the last one runs on import, so importing it IS running it.
    await expect(import("../epic-runtime-worker-entry")).rejects.toThrow(
      /epic-runtime-worker-entry was loaded on the main thread/,
    );
  });
});
