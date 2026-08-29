/**
 * The bridge, driven end to end through both REAL endpoints.
 *
 * Nothing here mocks an endpoint or a frame. `createFakeBridgePair` supplies
 * the pipe and only the pipe - it structured-clones every frame with the
 * sender's transfer list, so what these tests exercise is the production
 * correlation, the production validators and the production failure paths
 * against a real serialization boundary.
 *
 * A suite that stubbed `createMainBridgeEndpoint` would relocate every
 * invariant below into the stub.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BridgeCallError,
  BridgeDisposedError,
  BridgeResponseMismatchError,
  createMainBridgeEndpoint,
  createWorkerBridgeEndpoint,
  type BridgeTransport,
  type BridgeReply,
  type RuntimeWorkerCallHandlers,
} from "../bridge-endpoint";
import { stubRuntimeWorkerCallHandlers } from "../test-support/stub-runtime-worker-call-handlers";
import { NO_TRANSFER, takeBytesForTransfer } from "../transferable-bytes";
import { isMainToWorkerFrame } from "../bridge-protocol";
import type {
  RuntimeWorkerCallResponse,
  WorkerToMainEvent,
} from "../bridge-protocol";

type BodyDemoteAnswer = RuntimeWorkerCallResponse<"body/demote">;
import { createFakeBridgePair } from "../test-support/fake-bridge-pair";

const REFUSED: BodyDemoteAnswer = { accepted: false, settledBytes: 0 };
const DEMOTE_REQUEST = {
  docKey: "doc-1",
  generation: 1,
  update: Uint8Array.from([1]),
};

describe("bridge call correlation", () => {
  it("settles each call with its own answer when replies arrive out of order", async () => {
    const pair = createFakeBridgePair("sync");
    const gates: Array<
      (reply: BridgeReply<{ bytes: Uint8Array | null }>) => void
    > = [];
    createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "attachment/read": () =>
          new Promise((resolve) => {
            gates.push(resolve);
          }),
      }),
    );
    const main = createMainBridgeEndpoint(pair.main);

    const first = main.call("attachment/read", { hash: "a" }, NO_TRANSFER);
    const second = main.call("attachment/read", { hash: "b" }, NO_TRANSFER);
    expect(gates).toHaveLength(2);

    // Answer the SECOND call first. A bridge that paired replies with calls
    // positionally, or held one slot, would hand "b" to the first awaiter.
    gates[1]?.({
      value: { bytes: Uint8Array.from([2]) },
      transfer: NO_TRANSFER,
    });
    gates[0]?.({
      value: { bytes: Uint8Array.from([1]) },
      transfer: NO_TRANSFER,
    });

    expect([...((await first).bytes ?? [])]).toEqual([1]);
    expect([...((await second).bytes ?? [])]).toEqual([2]);
  });

  it("does not lose a reply a transport delivers inside the call itself", async () => {
    // The registration-before-post ordering, driven by the only thing that can
    // reach it: a transport that answers DURING `post`.
    //
    // Pairing this endpoint with `createWorkerBridgeEndpoint` cannot test it -
    // that endpoint dispatches through an async `serve`, so its reply is always
    // at least a microtask late and the ordering is unobservable. `call` is
    // public over an arbitrary `BridgeTransport` though, and a same-tick
    // responder is a legal one; against it, a pending table written after the
    // post finds no entry, drops the reply as stale, and the promise never
    // settles at all.
    const listeners = new Set<(message: unknown) => void>();
    const syncResponder: BridgeTransport = {
      post(message): void {
        if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
        for (const listener of [...listeners]) {
          listener({
            frame: "result",
            callId: message.callId,
            result: { outcome: "ok", value: REFUSED },
          });
        }
      },
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const main = createMainBridgeEndpoint(syncResponder);

    await expect(
      main.call("body/demote", DEMOTE_REQUEST, NO_TRANSFER),
    ).resolves.toEqual(REFUSED);
  });

  it("rejects with the remote error's name and message", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "body/demote": () => {
          const failure = new Error("holder exploded");
          failure.name = "HolderError";
          return Promise.reject(failure);
        },
      }),
    );
    const main = createMainBridgeEndpoint(pair.main);

    const rejection = await main
      .call("body/demote", DEMOTE_REQUEST, NO_TRANSFER)
      .catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(BridgeCallError);
    expect(rejection).toMatchObject({
      remoteName: "HolderError",
      message: "holder exploded",
    });
  });

  it("rejects rather than hands back a reply shaped like another call's", async () => {
    // Answered off the pipe rather than through a handler: the handler map is
    // typed, so a lying handler would need an assertion to write, and the
    // thing under test is what the MAIN endpoint does with a foreign payload -
    // which is what a stale worker chunk actually sends.
    const pair = createFakeBridgePair("queued");
    const main = createMainBridgeEndpoint(pair.main);

    const pending = main.call("body/demote", DEMOTE_REQUEST, NO_TRANSFER);
    const sent = pair.fromMain.at(-1)?.delivered;
    const callId =
      isMainToWorkerFrame(sent) && sent.frame === "call" ? sent.callId : -1;
    expect(callId).toBeGreaterThan(0);

    // The expectation is attached BEFORE the flush that causes the rejection.
    // Attaching it afterwards leaves the promise unhandled across a macrotask
    // boundary, which Node reports as an unhandled rejection and then, once the
    // handler arrives, as a `PromiseRejectionHandledWarning` - a red run for a
    // test that is passing.
    const rejected = expect(pending).rejects.toBeInstanceOf(
      BridgeResponseMismatchError,
    );
    pair.worker.post(
      {
        frame: "result",
        callId,
        result: { outcome: "ok", value: { state: "confused" } },
      },
      NO_TRANSFER,
    );
    await pair.flush();
    await rejected;
  });

  it("drops a result for a call id it never issued", async () => {
    const pair = createFakeBridgePair("queued");
    createWorkerBridgeEndpoint(pair.worker, stubRuntimeWorkerCallHandlers({}));
    const main = createMainBridgeEndpoint(pair.main);

    pair.worker.post(
      {
        frame: "result",
        callId: 9_999,
        result: { outcome: "ok", value: REFUSED },
      },
      NO_TRANSFER,
    );
    await expect(pair.flush()).resolves.toBeUndefined();

    // The endpoint is still usable afterwards - a stray frame must not poison
    // the correlation table.
    const pending = main.call("body/demote", DEMOTE_REQUEST, NO_TRANSFER);
    await pair.flush();
    await expect(pending).resolves.toEqual(REFUSED);
  });
});

describe("bridge byte transfer", () => {
  it("carries a handler's transfer list to the pipe and delivers the bytes", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "attachment/read": () => {
          const prepared = takeBytesForTransfer(Uint8Array.from([7, 7, 7]));
          return Promise.resolve({
            value: { bytes: prepared.bytes },
            transfer: prepared.transfer,
          });
        },
      }),
    );
    const main = createMainBridgeEndpoint(pair.main);

    const answer = await main.call(
      "attachment/read",
      { hash: "h" },
      NO_TRANSFER,
    );

    expect([...(answer.bytes ?? [])]).toEqual([7, 7, 7]);
    // The list reached the post rather than being dropped somewhere in the
    // endpoint - a transfer that silently degrades to a copy is invisible in
    // the payload and is the whole cost this boundary exists to avoid.
    const reply = pair.fromWorker.at(-1);
    expect(reply?.transferCount).toBe(1);
    expect(reply?.transferredByteLengths).toEqual([3]);
  });

  it("posts no transfer list for a byte-free frame", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(pair.worker, stubRuntimeWorkerCallHandlers({}));
    const main = createMainBridgeEndpoint(pair.main);

    await main.call("body/demote", DEMOTE_REQUEST, NO_TRANSFER);

    expect(pair.fromWorker.at(-1)?.transferCount).toBe(0);
  });
});

describe("the body calls, with nothing behind them", () => {
  it("REFUSES a demote rather than reporting bytes nobody stored", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(pair.worker, stubRuntimeWorkerCallHandlers({}));
    const main = createMainBridgeEndpoint(pair.main);

    // `accepted: false` is what keeps the main thread's live doc alive. An
    // unowned `true` here tells it to drop a document whose bytes were never
    // written, which is the one failure the acknowledged demote exists to
    // rule out.
    await expect(
      main.call(
        "body/demote",
        { docKey: "doc-1", generation: 1, update: Uint8Array.from([1]) },
        NO_TRANSFER,
      ),
    ).resolves.toEqual({ accepted: false, settledBytes: 0 });
  });

  it("answers a materialize with no body as a null doc key", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(pair.worker, stubRuntimeWorkerCallHandlers({}));
    const main = createMainBridgeEndpoint(pair.main);

    await expect(
      main.call("body/materialize", { artifactId: "artifact-1" }, NO_TRANSFER),
    ).resolves.toEqual({
      docKey: null,
      update: null,
      seedMode: "full",
      hostStateVector: null,
    });
  });
});

describe("bridge lifecycle", () => {
  it("rejects every in-flight call on dispose instead of leaving it hanging", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "body/demote": () => new Promise(() => undefined),
      }),
    );
    const main = createMainBridgeEndpoint(pair.main);

    const pending = main.call("body/demote", DEMOTE_REQUEST, NO_TRANSFER);
    main.dispose();

    await expect(pending).rejects.toBeInstanceOf(BridgeDisposedError);
    // Idempotent, and a call issued afterwards fails fast rather than queueing
    // against a pipe nobody is reading.
    main.dispose();
    await expect(
      main.call("body/demote", DEMOTE_REQUEST, NO_TRANSFER),
    ).rejects.toBeInstanceOf(BridgeDisposedError);
  });

  it("drops a late reply for a settled call without throwing", async () => {
    const pair = createFakeBridgePair("queued");
    const answers: Array<(reply: BridgeReply<BodyDemoteAnswer>) => void> = [];
    createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "body/demote": () =>
          new Promise((resolve) => {
            answers.push(resolve);
          }),
      }),
    );
    const main = createMainBridgeEndpoint(pair.main);

    const pending = main.call("body/demote", DEMOTE_REQUEST, NO_TRANSFER);
    await pair.flush();
    main.dispose();
    await expect(pending).rejects.toBeInstanceOf(BridgeDisposedError);

    // The worker answers after the main side has gone. A throw here surfaces as
    // an unhandled error with nobody to catch it.
    answers[0]?.({ value: REFUSED, transfer: NO_TRANSFER });
    await expect(pair.flush()).resolves.toBeUndefined();
  });

  it("ignores a frame that is not ours", () => {
    const pair = createFakeBridgePair("sync");
    const main = createMainBridgeEndpoint(pair.main);
    const seen = vi.fn();
    main.onEvent(seen);

    // Something else posting on the same port - the shape check is what stops
    // it from being read as a frame.
    pair.worker.post({ hello: "world" }, NO_TRANSFER);
    pair.worker.post(null, NO_TRANSFER);

    expect(seen).not.toHaveBeenCalled();
  });

  it("delivers events both ways and stops on unsubscribe", () => {
    const pair = createFakeBridgePair("sync");
    const worker = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({}),
    );
    const main = createMainBridgeEndpoint(pair.main);

    const fromWorker: WorkerToMainEvent[] = [];
    const unsubscribe = main.onEvent((event) => fromWorker.push(event));
    const inWorker = vi.fn();
    worker.onEvent(inWorker);

    worker.emit({ kind: "ready", protocolVersion: 1 }, NO_TRANSFER);
    main.emit({ kind: "shutdown" }, NO_TRANSFER);
    expect(fromWorker).toEqual([{ kind: "ready", protocolVersion: 1 }]);
    expect(inWorker).toHaveBeenCalledWith({ kind: "shutdown" });

    unsubscribe();
    worker.emit({ kind: "ready", protocolVersion: 1 }, NO_TRANSFER);
    expect(fromWorker).toHaveLength(1);
  });

  it("survives a listener that unsubscribes during dispatch", () => {
    const pair = createFakeBridgePair("sync");
    const worker = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({}),
    );
    const main = createMainBridgeEndpoint(pair.main);

    const second = vi.fn();
    const unsubscribeFirst = main.onEvent(() => {
      unsubscribeFirst();
    });
    main.onEvent(second);

    expect(() => {
      worker.emit({ kind: "ready", protocolVersion: 1 }, NO_TRANSFER);
    }).not.toThrow();
    // The set was mutated mid-dispatch; the other listener still ran.
    expect(second).toHaveBeenCalledTimes(1);
  });
});
