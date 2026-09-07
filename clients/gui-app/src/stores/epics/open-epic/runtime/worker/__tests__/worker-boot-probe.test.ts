import "@vitest/web-worker";
import { describe, expect, it } from "vitest";
// The CONSTANT, never a literal.
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

/** Every frame up to and including the first of `kind`. */
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
 * A frame's kind, plus a `fatal`'s message. Without the message a composition failure reads as
 * "saw fatal" and the diagnosis costs a round trip.
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
      // `ready` answers a bootstrap; it is not a boot announcement.
      worker.postMessage(bootstrapFrame(RUNTIME_BRIDGE_PROTOCOL_VERSION));
      const received = await frames;

      // Asserted as the whole frame rather than by reaching into it: the shape is the contract the main
      // side parses, and a test that plucked `protocolVersion` out would still pass if the envelope
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
    // The ordering IS the contract.
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
    // Two claims, and the second is the one worth having: a worker that disagrees on the version must
    // not build a runtime.
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
