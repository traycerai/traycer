/**
 * The in-process `RuntimeWorkerPort`, and the three outcomes it must not blur.
 *
 * This port exists so the lease bridge can be wired and pinned while the
 * replica is still in-process; at the flip it is replaced by the spawned
 * worker's port and the bridge does not change. What these pins protect is the
 * SHAPE the bridge will keep depending on - not the in-process implementation,
 * which is temporary.
 */
import { describe, expect, it } from "vitest";
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import { NO_TRANSFER } from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import {
  createInProcessRuntimePort,
  type InProcessColdState,
  type InProcessRuntimeSource,
} from "../in-process-runtime-port";

/** One construction site, so a fifth call fails here once. */
function source(
  overrides: Partial<InProcessRuntimeSource>,
): InProcessRuntimeSource {
  const base: InProcessRuntimeSource = {
    bodyDocKey: (artifactId) => artifactId,
    encodeColdState: () => null,
    settleColdState: () => ({
      accepted: false,
      reason: "not-held" as const,
      settledBytes: 0,
    }),
    releaseBody: () => ({ released: true, reason: null }),
    sendBodyUpdate: (): SendOutcome => ({
      kind: "dropped",
      reason: "no lane in this fixture",
    }),
  };
  return { ...base, ...overrides };
}

const COLD: InProcessColdState = {
  update: Uint8Array.from([1, 2, 3, 4]),
  seedMode: "full",
  hostStateVector: "sv",
  docGuid: "guid-cold",
};

describe("body/materialize", () => {
  it("answers the NOT-HELD arm, never a zero-length update", async () => {
    // The defect this pin exists for: a consumer treating `null` cold state as
    // "empty bytes". A zero-length update applies cleanly and produces an EMPTY
    // document, so answering `{ docKey, update: new Uint8Array() }` would
    // replace a body with nothing and look like a successful materialize.
    const port = createInProcessRuntimePort(
      source({ encodeColdState: () => null }),
    );

    const answer = await port.call(
      "body/materialize",
      { artifactId: "artifact-1" },
      NO_TRANSFER,
    );

    expect(answer.docKey).toBeNull();
    expect(answer.update).toBeNull();
    // Specifically NOT a zero-length array.
    expect(answer.update).not.toEqual(new Uint8Array());
  });

  it("answers NOT-HELD when the artifact has no body doc on this arm", async () => {
    const port = createInProcessRuntimePort(
      source({ bodyDocKey: () => null, encodeColdState: () => COLD }),
    );

    const answer = await port.call(
      "body/materialize",
      { artifactId: "artifact-1" },
      NO_TRANSFER,
    );

    // No doc key means nothing to encode AGAINST - the cold state is never
    // consulted, so a tier holding some other body cannot leak into this
    // artifact's answer.
    expect(answer.docKey).toBeNull();
    expect(answer.update).toBeNull();
  });

  it("carries the encoded state through with its seed mode and watermark", async () => {
    const port = createInProcessRuntimePort(
      source({ encodeColdState: () => COLD }),
    );

    const answer = await port.call(
      "body/materialize",
      { artifactId: "artifact-1" },
      NO_TRANSFER,
    );

    expect(answer.docKey).toBe("artifact-1");
    expect(answer.update).toEqual(COLD.update);
    // `seedMode` and the watermark are the receiver's instructions for how to
    // apply these bytes; dropping either turns a full document into an
    // ambiguous one.
    expect(answer.seedMode).toBe("full");
    expect(answer.hostStateVector).toBe("sv");
    // The identity these bytes were cut at, carried on the GRANTED arm. It is
    // what the eventual demote is checked against, so a materialize that
    // forwards bytes without their guid hands back a settlement that can only
    // be refused.
    expect(answer.docGuid).toBe("guid-cold");
  });
});

describe("body/demote", () => {
  it("reports settledBytes from what was STORED, not from the input", async () => {
    // Deliberately different lengths. A demote's caller uses this number to
    // decide it may drop a live document, and the input's length says nothing
    // about what survived the merge - an update carrying only operations the
    // replica already had stores nothing new.
    const input = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const port = createInProcessRuntimePort(
      source({
        settleColdState: () => ({
          accepted: true,
          reason: null,
          settledBytes: 3,
        }),
      }),
    );

    const answer = await port.call(
      "body/demote",
      { docKey: "doc-1", generation: 1, docGuid: "guid-1", update: input },
      NO_TRANSFER,
    );

    expect(answer.accepted).toBe(true);
    expect(answer.settledBytes).toBe(3);
    expect(answer.settledBytes).not.toBe(input.byteLength);
  });

  it("passes a refusal through as accepted:false, never as a throw", async () => {
    const port = createInProcessRuntimePort(
      source({
        settleColdState: () => ({
          accepted: false,
          reason: "not-held" as const,
          settledBytes: 0,
        }),
      }),
    );

    // A throw at this seam either drops bytes nothing stored or strands a doc
    // forever; the caller keeps its live document on `accepted: false`.
    const answer = await port.call(
      "body/demote",
      {
        docKey: "doc-1",
        generation: 1,
        docGuid: "guid-1",
        update: new Uint8Array(),
      },
      NO_TRANSFER,
    );

    expect(answer.accepted).toBe(false);
    expect(answer.settledBytes).toBe(0);
  });
});

describe("the port's shape", () => {
  it("answers asynchronously even though the runtime is local", async () => {
    // Not ceremony. The contract is async and the worker's port will be, so a
    // same-tick answer here would let a caller depend on delivery the flip
    // cannot provide.
    const port = createInProcessRuntimePort(source({}));
    let settledSynchronously = true;
    const pending = port
      .call("attachment/read", { hash: "h" }, NO_TRANSFER)
      .then((answer) => {
        expect(settledSynchronously).toBe(false);
        return answer;
      });
    settledSynchronously = false;

    await expect(pending).resolves.toEqual({ bytes: null });
  });

  it("does not detach a caller's buffer for an in-process call", async () => {
    // The transfer list is accepted and IGNORED. Across a real `postMessage`
    // it means "I am giving up this memory"; in-process the caller's bytes and
    // the replica's are the SAME objects, so honouring it would detach buffers
    // the replica is still holding.
    const owned = new ArrayBuffer(8);
    const bytes = new Uint8Array(owned);
    const port = createInProcessRuntimePort(
      source({
        settleColdState: () => ({
          accepted: true,
          reason: null,
          settledBytes: 8,
        }),
      }),
    );

    await port.call(
      "body/demote",
      { docKey: "doc-1", generation: 1, docGuid: "guid-1", update: bytes },
      [owned],
    );

    expect(owned.byteLength).toBe(8);
    expect([...bytes]).toHaveLength(8);
  });
});
