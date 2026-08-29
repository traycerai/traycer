/**
 * The composition root's two settled behaviours: what it answers once it has
 * stopped serving, and the order it tears down in.
 */
import { describe, expect, it } from "vitest";
import { createEpicRuntimeWorkerCore } from "../epic-runtime-core";
import type { EpicRuntimeCorePorts } from "../epic-runtime-core";

function createPorts(): EpicRuntimeCorePorts & { readonly closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    attachments: { read: async () => Uint8Array.from([1]) },
    bodies: {
      materialize: async (artifactId) => ({
        docKey: artifactId,
        update: Uint8Array.from([2]),
        seedMode: "full",
        hostStateVector: null,
      }),
      settle: async () => ({ accepted: true, settledBytes: 7 }),
    },
    transport: {
      close: () => {
        closed.push("transport");
      },
    },
    durableStore: {
      close: () => {
        closed.push("durableStore");
      },
    },
  };
}

describe("shutdown order", () => {
  it("closes the transport before the durable store, and only once", () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    core.dispose();
    core.dispose();

    // The store is the only thing here with state outliving the process, so a
    // frame arriving after it closed is how a write lands past its own close.
    expect(ports.closed).toEqual(["transport", "durableStore"]);
  });
});

describe("after dispose", () => {
  it("answers reads and materializations as unavailable instead of touching the replica", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);
    core.dispose();

    await expect(core.readAttachmentBytes("hash")).resolves.toBeNull();
    await expect(core.materializeBody("artifact-1")).resolves.toBeNull();
  });

  it("REFUSES a demote rather than accepting bytes it will not write", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);
    core.dispose();

    // Accepting here costs the edit: the main thread drops its live doc on an
    // accepted demote. Refusing costs one re-send after respawn.
    await expect(
      core.demoteBody({
        docKey: "artifact-1",
        generation: 2,
        update: Uint8Array.from([3]),
      }),
    ).resolves.toEqual({ accepted: false, settledBytes: 0 });
  });

  it("serves normally before dispose", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await expect(core.readAttachmentBytes("hash")).resolves.toEqual(
      Uint8Array.from([1]),
    );
    await expect(
      core.demoteBody({
        docKey: "artifact-1",
        generation: 1,
        update: Uint8Array.from([3]),
      }),
    ).resolves.toEqual({ accepted: true, settledBytes: 7 });
  });
});
