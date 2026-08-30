/**
 * The composition root's two settled behaviours: what it answers once it has
 * stopped serving, and the order it tears down in.
 */
import { describe, expect, it } from "vitest";
import { inertMutationResult } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { RuntimeWorkerCallRequest } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { createEpicRuntimeWorkerCore } from "../epic-runtime-core";
import type { EpicRuntimeCorePorts } from "../epic-runtime-core";

/**
 * The ONE demote-params construction site in this file.
 *
 * It existed before, unannotated and scoped to a single `describe`, so the
 * contract's `docGuid` failed at ELEVEN call sites instead of once here - and
 * the two literals outside that block had to be swept by hand and were missed.
 * The annotation is what makes it a single point of failure: naming
 * `RuntimeWorkerCallRequest<"body/demote">` rather than restating its members
 * means the next field added to the contract reds this line and nothing else.
 *
 * `docGuid` is per-docKey because two docKeys are two documents; the core keys
 * idempotence on (docKey, generation) and never reads the guid, so no assertion
 * here depends on the value.
 */
const demote = (
  docKey: string,
  generation: number,
): RuntimeWorkerCallRequest<"body/demote"> => ({
  docKey,
  generation,
  docGuid: `guid-${docKey}`,
  update: Uint8Array.from([1]),
});

function createPorts(): EpicRuntimeCorePorts & {
  readonly closed: string[];
  /** Every `bodies.settle` that actually reached the port, in order. */
  readonly settles: string[];
} {
  const closed: string[] = [];
  const settles: string[] = [];
  return {
    closed,
    settles,
    attachments: {
      read: () => Promise.resolve(Uint8Array.from([1])),
      await: () => Promise.resolve(null),
      cancel: () => false,
      cancelAll: () => {},
    },
    detachAllBodyObservers: () => {},
    // The shared fail-closed answer, so this fixture does not become a fifth
    // hand-written switch over the mutation union.
    mutations: { apply: (mutation) => inertMutationResult(mutation) },
    commands: {
      apply: () => {},
      enqueueWrite: () => ({ outcome: "refused" as const }),
    },
    root: {
      encode: () => Promise.resolve(new Uint8Array()),
      apply: () => Promise.resolve(false),
    },
    bodies: {
      materialize: (artifactId) =>
        Promise.resolve({
          docKey: artifactId,
          docGuid: `guid-${artifactId}`,
          update: Uint8Array.from([2]),
          seedMode: "full",
          hostStateVector: null,
        }),
      settle: (input) => {
        settles.push(`${input.docKey}:${String(input.generation)}`);
        return Promise.resolve({ accepted: true, settledBytes: 7 });
      },
      sendUpdate: () => Promise.resolve({ kind: "sent" }),
      applyAwareness: () => {},
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
    await expect(core.demoteBody(demote("artifact-1", 2))).resolves.toEqual({
      accepted: false,
      settledBytes: 0,
    });
  });

  it("serves normally before dispose", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await expect(core.readAttachmentBytes("hash")).resolves.toEqual(
      Uint8Array.from([1]),
    );
    await expect(core.demoteBody(demote("artifact-1", 1))).resolves.toEqual({
      accepted: true,
      settledBytes: 7,
    });
  });
});

describe("the settled-demote map — idempotence per (docKey, generation)", () => {
  it("answers a RESEND from the stored answer without touching the port again", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    const first = await core.demoteBody(demote("doc-1", 2));
    // `resendUnacknowledgedDemotes` re-posts the SAME generation on purpose:
    // the main thread does not know whether the first post was seen. Releasing
    // demand on both copies would unsubscribe a body that is still open.
    const resend = await core.demoteBody(demote("doc-1", 2));

    expect(first).toEqual({ accepted: true, settledBytes: 7 });
    expect(resend).toEqual(first);
    expect(ports.settles).toEqual(["doc-1:2"]);
  });

  it("REFUSES a generation older than the one already settled, without reaching the port", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("doc-1", 3));
    const stale = await core.demoteBody(demote("doc-1", 2));

    // It belongs to a lifetime the main thread has already moved past. Its own
    // guard drops this answer, but the worker must not RELEASE on it.
    expect(stale).toEqual({ accepted: false, settledBytes: 0 });
    expect(ports.settles).toEqual(["doc-1:3"]);
  });

  it("runs a NEWER generation and replaces the entry", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("doc-1", 1));
    await core.demoteBody(demote("doc-1", 2));
    await core.demoteBody(demote("doc-1", 2));

    expect(ports.settles).toEqual(["doc-1:1", "doc-1:2"]);
  });

  it("keeps one entry per docKey, so two docs do not shadow each other", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("doc-1", 5));
    await core.demoteBody(demote("doc-2", 1));

    expect(ports.settles).toEqual(["doc-1:5", "doc-2:1"]);
  });

  it("clears the entry when the doc is materialized again — a new lifetime, a new sequence", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("artifact-1", 4));
    await core.materializeBody("artifact-1");
    // Generation 4 again, but for a doc that has been re-materialized since.
    // Without the clear this would answer from the previous lifetime and never
    // settle the new one.
    await core.demoteBody(demote("artifact-1", 4));

    expect(ports.settles).toEqual(["artifact-1:4", "artifact-1:4"]);
  });
});

describe("body/update", () => {
  it("forwards the lane's own outcome while serving", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await expect(
      core.updateBody({ docKey: "doc-1", update: Uint8Array.from([1]) }),
    ).resolves.toEqual({ outcome: { kind: "sent" } });
  });

  it("drops an update after dispose rather than claiming it was queued", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);
    core.dispose();

    const answer = await core.updateBody({
      docKey: "doc-1",
      update: Uint8Array.from([1]),
    });

    // `queued` would claim something here is holding it. Nothing is - the
    // main thread's live doc is, and the edit crosses on the next
    // materialize/demote cycle.
    expect(answer.outcome.kind).toBe("dropped");
  });
});
