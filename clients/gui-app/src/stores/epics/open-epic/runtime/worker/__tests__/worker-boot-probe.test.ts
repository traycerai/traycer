/**
 * The runtime host booting inside a real worker realm.
 *
 * Every other suite in this directory drives the host over a fake bridge pair
 * on one thread. This one loads the worker module graph with `new Worker(...)`
 * and reads what comes back off a real `postMessage`, which is the only way to
 * observe three things no same-thread test can:
 *
 * - the graph is IMPORTABLE in a worker realm at all - no module in it reaches
 *   for a DOM global at import time, and since the flip that graph is the whole
 *   composition root rather than just the bridge;
 * - `ready` survives the structured clone, carrying the protocol version the
 *   main side negotiates against;
 * - the composition runs BEFORE `ready`, which is what makes `ready` mean "I
 *   can serve" rather than "I have loaded".
 *
 * It boots `test-support/boot-probe-worker-entry.ts` rather than the shipped
 * entry, and that module's header says why: the shim's `self` is window-shaped,
 * so the shipped entry's scope guard refuses it - correctly. The guard is
 * pinned separately in both directions.
 */
import "@vitest/web-worker";
import { describe, expect, it } from "vitest";
// The CONSTANT, never a literal. This handshake broke silently at the v11
// bump and stayed broken because nothing ran it: a hardcoded version turns a
// negotiation pin into a countdown to the next bump.
import { RUNTIME_BRIDGE_PROTOCOL_VERSION } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";

const BOOT_TIMEOUT_MS = 10_000;

interface WorkerFrame {
  readonly frame: string;
  readonly event: { readonly kind: string };
}

function isWorkerFrame(value: unknown): value is WorkerFrame {
  if (typeof value !== "object" || value === null) return false;
  const event: unknown = Reflect.get(value, "event");
  if (typeof event !== "object" || event === null) return false;
  return typeof Reflect.get(event, "kind") === "string";
}

/**
 * Every frame up to and including the first of `kind`.
 *
 * Collecting rather than taking the first is the point, and it is a lesson
 * this file learned the hard way: the composition emits before `ready` does,
 * so a first-frame assertion pins whichever side effect happens to come first
 * and reds every time one is added. What matters is which frames arrived and
 * in what ORDER - so the failure message names what was seen.
 */
function framesUntil(worker: Worker, kind: string): Promise<WorkerFrame[]> {
  return new Promise<WorkerFrame[]>((resolve, reject) => {
    const seen: WorkerFrame[] = [];
    const timer = setTimeout(() => {
      reject(
        new Error(
          `no ${kind} frame within ${String(BOOT_TIMEOUT_MS)}ms; saw ${
            seen.length === 0
              ? "nothing"
              : seen.map((frame) => describeFrame(frame)).join(", ")
          }`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!isWorkerFrame(data)) return;
      seen.push(data);
      if (data.event.kind !== kind) return;
      clearTimeout(timer);
      resolve(seen);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      clearTimeout(timer);
      reject(new Error(`worker failed to load: ${event.message}`));
    });
  });
}

/**
 * A frame's kind, plus a `fatal`'s message.
 *
 * Without the message a composition failure reads as "saw fatal" and the
 * diagnosis costs a round trip. The fatal IS the diagnosis - it carries what
 * threw inside the worker, where no stack reaches the suite.
 */
function describeFrame(frame: WorkerFrame): string {
  if (frame.event.kind !== "fatal") return frame.event.kind;
  const message: unknown = Reflect.get(frame.event, "message");
  return `fatal(${typeof message === "string" ? message : "?"})`;
}

function bootProbeWorker(): Worker {
  return new Worker(
    new URL("../test-support/boot-probe-worker-entry.ts", import.meta.url),
    { type: "module" },
  );
}

function bootstrapFrame(protocolVersion: number): unknown {
  return {
    frame: "event",
    event: {
      kind: "bootstrap",
      bootstrap: {
        protocolVersion,
        epicId: "boot-probe-epic",
        hostId: "boot-probe-host",
        windowLabel: "boot-probe",
      },
    },
  };
}

describe("the runtime worker host in a worker realm", () => {
  it("answers the bootstrap handshake with ready over a real postMessage", async () => {
    const worker = bootProbeWorker();

    try {
      const frames = framesUntil(worker, "ready");
      // `ready` answers a bootstrap; it is not a boot announcement. Sending
      // the handshake is what makes this a test of the version negotiation
      // rather than of module loading, and a worker that loads but disagrees
      // on the version answers `fatal` here instead.
      worker.postMessage(bootstrapFrame(RUNTIME_BRIDGE_PROTOCOL_VERSION));
      const received = await frames;

      // Asserted as the whole frame rather than by reaching into it: the shape
      // is the contract the main side parses, and a test that plucked
      // `protocolVersion` out would still pass if the envelope changed.
      expect(received.at(-1)).toEqual({
        frame: "event",
        event: {
          kind: "ready",
          protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION,
        },
      });
    } finally {
      worker.terminate();
    }
  });

  it("registers the runtime's books before it answers ready", async () => {
    // The ordering IS the contract. `ready` is what makes main start sending
    // calls, so a core installed after it leaves a window where the worker
    // answers "not held" to reads the runtime could have served - and a books
    // registration after it leaves the accountant blind to a runtime that is
    // already allocating.
    const worker = bootProbeWorker();

    try {
      const frames = framesUntil(worker, "ready");
      worker.postMessage(bootstrapFrame(RUNTIME_BRIDGE_PROTOCOL_VERSION));
      const kinds = (await frames).map((frame) => frame.event.kind);

      expect(kinds).toContain("accounting/books");
      expect(kinds.indexOf("accounting/books")).toBeLessThan(
        kinds.indexOf("ready"),
      );
    } finally {
      worker.terminate();
    }
  });

  it("answers a version-skewed bootstrap with fatal, and composes nothing", async () => {
    // Two claims, and the second is the one worth having: a worker that
    // disagrees on the version must not build a runtime. If it did, it would
    // register books and open streams for a session main is about to reject,
    // and the books would then hold a runtime nothing can reach.
    const worker = bootProbeWorker();

    try {
      const frames = framesUntil(worker, "fatal");
      worker.postMessage(bootstrapFrame(9));
      const received = await frames;

      expect(received.at(-1)).toMatchObject({
        frame: "event",
        event: { kind: "fatal" },
      });
      expect(JSON.stringify(received.at(-1))).toContain("protocol mismatch");
      expect(received.map((frame) => frame.event.kind)).not.toContain(
        "accounting/books",
      );
    } finally {
      worker.terminate();
    }
  });
});
