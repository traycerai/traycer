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
import { stubMainCallHandlers } from "../test-support/stub-main-call-handlers";
import { stubRuntimeWorkerCallHandlers } from "../test-support/stub-runtime-worker-call-handlers";
import { NO_TRANSFER, takeBytesForTransfer } from "../transferable-bytes";
import { isMainToWorkerFrame, isWorkerToMainFrame } from "../bridge-protocol";
import type { BearerProbe, WorkerToMainEvent } from "../bridge-protocol";
import type { RevalidateOutcome } from "@traycer-clients/shared/auth/bearer-revalidator";
import { createFakeBridgePair } from "../test-support/fake-bridge-pair";

const ABSENT: BearerProbe = { state: "absent" };

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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

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
            result: { outcome: "ok", value: ABSENT },
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
    const main = createMainBridgeEndpoint(
      syncResponder,
      stubMainCallHandlers({}),
    );

    await expect(main.call("bearer/probe", {}, NO_TRANSFER)).resolves.toEqual(
      ABSENT,
    );
  });

  it("rejects with the remote error's name and message", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "bearer/probe": () => {
          const failure = new Error("holder exploded");
          failure.name = "HolderError";
          return Promise.reject(failure);
        },
      }),
    );
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

    const rejection = await main
      .call("bearer/probe", {}, NO_TRANSFER)
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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

    const pending = main.call("bearer/probe", {}, NO_TRANSFER);
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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

    pair.worker.post(
      {
        frame: "result",
        callId: 9_999,
        result: { outcome: "ok", value: ABSENT },
      },
      NO_TRANSFER,
    );
    await expect(pair.flush()).resolves.toBeUndefined();

    // The endpoint is still usable afterwards - a stray frame must not poison
    // the correlation table.
    const pending = main.call("bearer/probe", {}, NO_TRANSFER);
    await pair.flush();
    await expect(pending).resolves.toEqual(ABSENT);
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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

    await main.call("bearer/probe", {}, NO_TRANSFER);

    expect(pair.fromWorker.at(-1)?.transferCount).toBe(0);
  });
});

describe("the body calls, with nothing behind them", () => {
  it("REFUSES a demote rather than reporting bytes nobody stored", async () => {
    const pair = createFakeBridgePair("sync");
    createWorkerBridgeEndpoint(pair.worker, stubRuntimeWorkerCallHandlers({}));
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

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
        "bearer/probe": () => new Promise(() => undefined),
      }),
    );
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

    const pending = main.call("bearer/probe", {}, NO_TRANSFER);
    main.dispose();

    await expect(pending).rejects.toBeInstanceOf(BridgeDisposedError);
    // Idempotent, and a call issued afterwards fails fast rather than queueing
    // against a pipe nobody is reading.
    main.dispose();
    await expect(
      main.call("bearer/probe", {}, NO_TRANSFER),
    ).rejects.toBeInstanceOf(BridgeDisposedError);
  });

  it("drops a late reply for a settled call without throwing", async () => {
    const pair = createFakeBridgePair("queued");
    const answers: Array<(reply: BridgeReply<BearerProbe>) => void> = [];
    createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "bearer/probe": () =>
          new Promise((resolve) => {
            answers.push(resolve);
          }),
      }),
    );
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

    const pending = main.call("bearer/probe", {}, NO_TRANSFER);
    await pair.flush();
    main.dispose();
    await expect(pending).rejects.toBeInstanceOf(BridgeDisposedError);

    // The worker answers after the main side has gone. A throw here surfaces as
    // an unhandled error with nobody to catch it.
    answers[0]?.({ value: ABSENT, transfer: NO_TRANSFER });
    await expect(pair.flush()).resolves.toBeUndefined();
  });

  it("ignores a frame that is not ours", () => {
    const pair = createFakeBridgePair("sync");
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

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
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));

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

/**
 * The OTHER direction, driven through both real endpoints.
 *
 * Everything above proves the main->worker half. These pins exist because the
 * two halves now share one correlation table and one call-issuing helper, and a
 * shared implementation is exactly the thing that looks covered when only one
 * of its two users is exercised: a `main-call` frame the guard did not
 * recognise, or a `main-result` the endpoint never routed, would leave all of
 * the above green while every worker->main call hung forever.
 */
describe("worker->main calls", () => {
  it("settles each call with its own answer when replies arrive out of order", async () => {
    const pair = createFakeBridgePair("queued");
    const gates: Array<(outcome: RevalidateOutcome) => void> = [];
    createMainBridgeEndpoint(
      pair.main,
      stubMainCallHandlers({
        "main/auth-revalidate": () =>
          new Promise((resolve) => {
            gates.push((outcome) => resolve({ outcome }));
          }),
      }),
    );
    const worker = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({}),
    );

    const first = worker.call("main/auth-revalidate", {});
    const second = worker.call("main/auth-revalidate", {});
    await pair.flush();
    expect(gates).toHaveLength(2);

    // Answered in reverse. A table that paired replies positionally would hand
    // the second answer to the first awaiter - and on this path that means a
    // reconnect acting on another socket's verdict.
    gates[1]?.("rejected");
    gates[0]?.("rotated");
    await pair.flush();

    await expect(first).resolves.toEqual({ outcome: "rotated" });
    await expect(second).resolves.toEqual({ outcome: "rejected" });
    worker.dispose();
  });

  it("keeps the two directions' call ids apart", async () => {
    // Both tables start at 1, so the FIRST call each way carries `callId: 1`.
    // They cannot collide because each side routes by frame tag before it ever
    // reads an id - but "cannot" is the sort of claim that stops being true
    // when someone consolidates the two counters, so it is pinned.
    const pair = createFakeBridgePair("queued");
    const releaseWorkerSide: Array<(probe: BearerProbe) => void> = [];
    // ONE worker endpoint, serving and asking. Two of them on the same
    // transport is not a smaller version of this - both would subscribe, both
    // would answer every inbound call, and the first reply would win.
    const worker = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({
        "bearer/probe": () =>
          new Promise((resolve) => {
            releaseWorkerSide.push((value) =>
              resolve({ value, transfer: NO_TRANSFER }),
            );
          }),
      }),
    );
    const main = createMainBridgeEndpoint(
      pair.main,
      stubMainCallHandlers({
        "main/auth-revalidate": () => Promise.resolve({ outcome: "rotated" }),
      }),
    );

    const inbound = main.call("bearer/probe", {}, NO_TRANSFER);
    const outbound = worker.call("main/auth-revalidate", {});
    await pair.flush();

    // The worker->main call settles while the main->worker call with the SAME
    // id is still outstanding.
    await expect(outbound).resolves.toEqual({ outcome: "rotated" });
    releaseWorkerSide[0]?.({ state: "present", userId: "user-1" });
    await pair.flush();
    await expect(inbound).resolves.toEqual({
      state: "present",
      userId: "user-1",
    });
    worker.dispose();
    main.dispose();
  });

  it("rejects an in-flight call when the worker endpoint is disposed", async () => {
    const pair = createFakeBridgePair("queued");
    createMainBridgeEndpoint(
      pair.main,
      stubMainCallHandlers({
        "main/mint-credential": () => new Promise(() => undefined),
      }),
    );
    const worker = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({}),
    );

    const pending = worker.call("main/mint-credential", {
      mint: { hostId: "host-1", reason: "absent" },
    });
    await pair.flush();
    worker.dispose();

    // A worker torn down mid-mint would otherwise leave its transport awaiting
    // a credential forever, inside a thread that is about to be terminated -
    // and with no `unhandledrejection` handler over there, nothing would say so.
    await expect(pending).rejects.toBeInstanceOf(BridgeDisposedError);
  });

  it("rejects a new call made after disposal", async () => {
    const pair = createFakeBridgePair("queued");
    createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
    const worker = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({}),
    );

    worker.dispose();

    await expect(
      worker.call("main/auth-revalidate", {}),
    ).rejects.toBeInstanceOf(BridgeDisposedError);
  });

  it("names the main thread when it answers with a foreign payload", async () => {
    // Driven at the FRAME rather than through a handler, and not to dodge the
    // type: a handler forced to return a bad shape needs an assertion, and an
    // assertion in the fixture is a claim about the very thing under test. What
    // actually reaches this parser is a frame off a pipe - a stale chunk, a
    // skewed build - so a fixture that posts one is the honest reproduction.
    const listeners = new Set<(message: unknown) => void>();
    const foreignResponder: BridgeTransport = {
      post(message): void {
        if (!isWorkerToMainFrame(message) || message.frame !== "main-call") {
          return;
        }
        for (const listener of [...listeners]) {
          listener({
            frame: "main-result",
            callId: message.callId,
            // `unchanged` reads like a real outcome and is not one. A transport
            // handed it falls through every branch it has.
            result: { outcome: "ok", value: { outcome: "unchanged" } },
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
    const worker = createWorkerBridgeEndpoint(
      foreignResponder,
      stubRuntimeWorkerCallHandlers({}),
    );

    const pending = worker.call("main/auth-revalidate", {});

    await expect(pending).rejects.toBeInstanceOf(BridgeResponseMismatchError);
    await expect(pending).rejects.toThrow("The main thread answered");
    worker.dispose();
  });

  it("does not lose a reply a transport delivers inside the call itself", async () => {
    // The worker direction's copy of the registration-before-post pin. Both
    // directions now issue through one helper, so this is what proves the
    // helper is the thing being used here rather than a second inlined copy.
    const listeners = new Set<(message: unknown) => void>();
    const syncResponder: BridgeTransport = {
      post(message): void {
        if (!isWorkerToMainFrame(message) || message.frame !== "main-call") {
          return;
        }
        for (const listener of [...listeners]) {
          listener({
            frame: "main-result",
            callId: message.callId,
            result: { outcome: "ok", value: { outcome: "network-error" } },
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
    const worker = createWorkerBridgeEndpoint(
      syncResponder,
      stubRuntimeWorkerCallHandlers({}),
    );

    await expect(worker.call("main/auth-revalidate", {})).resolves.toEqual({
      outcome: "network-error",
    });
  });
});
