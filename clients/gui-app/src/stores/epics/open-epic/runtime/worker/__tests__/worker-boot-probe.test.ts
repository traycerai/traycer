/**
 * The runtime host booting inside a real worker realm.
 *
 * Every other suite in this directory drives the host over a fake bridge pair
 * on one thread. This one loads the worker module graph with `new Worker(...)`
 * and reads the first frame back off a real `postMessage`, which is the only
 * way to observe two things no same-thread test can:
 *
 * - the graph is IMPORTABLE in a worker realm at all - no module in it reaches
 *   for a DOM global at import time;
 * - `ready` survives the structured clone, carrying the protocol version the
 *   main side negotiates against.
 *
 * It boots `test-support/boot-probe-worker-entry.ts` rather than the shipped
 * entry, and that module's header says why: the shim's `self` is window-shaped,
 * so the shipped entry's scope guard refuses it - correctly. The guard is
 * pinned separately in both directions.
 */
import "@vitest/web-worker";
import { describe, expect, it } from "vitest";

const BOOT_TIMEOUT_MS = 10_000;

function firstMessage(worker: Worker): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `no frame from the worker within ${String(BOOT_TIMEOUT_MS)}ms`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      clearTimeout(timer);
      reject(new Error(`worker failed to load: ${event.message}`));
    });
  });
}

describe("the runtime worker host in a worker realm", () => {
  it("answers the bootstrap handshake with ready over a real postMessage", async () => {
    const worker = new Worker(
      new URL("../test-support/boot-probe-worker-entry.ts", import.meta.url),
      { type: "module" },
    );

    try {
      const frame = firstMessage(worker);
      // `ready` answers a bootstrap; it is not a boot announcement. Sending
      // the handshake is what makes this a test of the version negotiation
      // rather than of module loading, and a worker that loads but disagrees
      // on the version answers `fatal` here instead.
      worker.postMessage({
        frame: "event",
        event: {
          kind: "bootstrap",
          bootstrap: { protocolVersion: 4, windowLabel: "boot-probe" },
        },
      });
      const received = await frame;

      // Asserted as the whole frame rather than by reaching into it: the shape
      // is the contract the main side parses, and a test that plucked
      // `protocolVersion` out would still pass if the envelope changed.
      expect(received).toEqual({
        frame: "event",
        event: { kind: "ready", protocolVersion: 4 },
      });
    } finally {
      worker.terminate();
    }
  });

  it("answers a version-skewed bootstrap with fatal, not ready", async () => {
    // Without this the test above cannot tell a negotiated `ready` from a
    // constant one: a host that emitted `ready` for any bootstrap at all would
    // satisfy it.
    const worker = new Worker(
      new URL("../test-support/boot-probe-worker-entry.ts", import.meta.url),
      { type: "module" },
    );

    try {
      const frame = firstMessage(worker);
      worker.postMessage({
        frame: "event",
        event: {
          kind: "bootstrap",
          bootstrap: { protocolVersion: 3, windowLabel: "boot-probe" },
        },
      });
      const received = await frame;

      expect(received).toMatchObject({
        frame: "event",
        event: { kind: "fatal" },
      });
      expect(JSON.stringify(received)).toContain("protocol mismatch");
    } finally {
      worker.terminate();
    }
  });
});
