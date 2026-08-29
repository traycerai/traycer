/**
 * The two ends of the runtime bridge.
 *
 * `postMessage` gives us an untyped pipe with no relationship between a
 * message and its reply. These endpoints turn it into the two things the
 * runtime actually needs: a typed event stream in both directions, and a
 * request/response call from the main thread into the worker with real promise
 * semantics.
 *
 * The endpoints own the correlation and the failure modes around it, because
 * those are the ones nobody writes correctly by hand on the second occasion: a
 * reply for a call that already settled, a handler that throws, a disposal with
 * calls still outstanding (the hung-promise case - the UI waits forever on a
 * worker that is gone, with nothing logged), a reply carrying another call's
 * payload, and a foreign frame on the same port.
 *
 * Deliberately NOT a general-purpose RPC layer. It carries this protocol only,
 * it has no timeouts (the caller owns its deadline, because only the caller
 * knows whether its work is abandonable), and it has no retry (a call into a
 * worker that answered nothing is not idempotent by assumption).
 */
import {
  buildRuntimeWorkerCall,
  CALL_RESPONSE_PARSERS,
  isMainToWorkerFrame,
  isWorkerToMainFrame,
  type BridgeCallResult,
  type MainToWorkerEvent,
  type MainToWorkerFrame,
  type RuntimeWorkerCall,
  type RuntimeWorkerCallKind,
  type RuntimeWorkerCallRequest,
  type RuntimeWorkerCallResponse,
  type WorkerToMainEvent,
  type WorkerToMainFrame,
} from "./bridge-protocol";

/**
 * The pipe, reduced to what a `Worker`, a `MessagePort` and a worker's own
 * global scope can all provide.
 *
 * A structural seam rather than the DOM types on purpose. The three real
 * targets do not share a `postMessage` signature under one `lib` setting - a
 * dedicated worker's scope takes `(message, transfer)` while `Window` takes
 * `(message, targetOrigin, transfer)`, and a package compiled with `DOM` sees
 * the second one for `self`. Adapting at the edge, once, is what keeps every
 * module below this line free of that clash - and it is what lets a test drive
 * a real endpoint pair over a fake port instead of mocking the endpoint away.
 */
export interface BridgeTransport {
  post(message: unknown, transfer: readonly ArrayBuffer[]): void;
  /** Returns the unsubscribe. Multiple subscribers are supported. */
  subscribe(listener: (message: unknown) => void): () => void;
}

/** A worker-side answer, with the buffers it hands over. */
export interface BridgeReply<TValue> {
  readonly value: TValue;
  readonly transfer: readonly ArrayBuffer[];
}

/**
 * One handler per call, so a call added to the protocol without an
 * implementation does not compile.
 *
 * The alternative - a single handler over the request union - types the
 * request and the response independently, which is how a handler comes to
 * answer the right shape for the wrong call.
 */
export type RuntimeWorkerCallHandlers = {
  readonly [K in RuntimeWorkerCallKind]: (
    request: RuntimeWorkerCallRequest<K>,
  ) => Promise<BridgeReply<RuntimeWorkerCallResponse<K>>>;
};

/**
 * A rejection that crossed the boundary.
 *
 * Carries the original error's `name` so a caller can still tell one failure
 * class from another without the worker's error classes existing on this side.
 */
export class BridgeCallError extends Error {
  readonly remoteName: string;

  constructor(remoteName: string, message: string) {
    super(message);
    this.name = "BridgeCallError";
    this.remoteName = remoteName;
  }
}

/** Raised on every call still outstanding when an endpoint is disposed. */
export class BridgeDisposedError extends Error {
  constructor() {
    super("The runtime worker bridge was disposed with calls in flight");
    this.name = "BridgeDisposedError";
  }
}

/** Raised when a reply does not match the shape its call declares. */
export class BridgeResponseMismatchError extends Error {
  constructor(kind: RuntimeWorkerCallKind) {
    super(`The runtime worker answered '${kind}' with a foreign payload`);
    this.name = "BridgeResponseMismatchError";
  }
}

export interface MainBridgeEndpoint {
  emit(event: MainToWorkerEvent, transfer: readonly ArrayBuffer[]): void;
  call<K extends RuntimeWorkerCallKind>(
    kind: K,
    request: RuntimeWorkerCallRequest<K>,
    transfer: readonly ArrayBuffer[],
  ): Promise<RuntimeWorkerCallResponse<K>>;
  onEvent(listener: (event: WorkerToMainEvent) => void): () => void;
  /** Idempotent. Rejects every in-flight call and stops listening. */
  dispose(): void;
}

export interface WorkerBridgeEndpoint {
  emit(event: WorkerToMainEvent, transfer: readonly ArrayBuffer[]): void;
  onEvent(listener: (event: MainToWorkerEvent) => void): () => void;
  /** Idempotent. Stops listening; in-flight handlers are left to settle. */
  dispose(): void;
}

/**
 * A pending call, reduced to what the table needs to hold. The response type
 * lives in these closures, captured where `call`'s type parameter was still in
 * scope, which is what lets the table be keyed by call id without erasing it.
 *
 * Two entry points rather than one, because the two ways a call ends are not
 * the same fact. `settle` carries an answer the WORKER produced - including a
 * failure it reported. `abort` ends a call that the worker never answered at
 * all, and the caller has to be able to tell those apart: "the runtime told me
 * this read failed" and "the runtime went away mid-read" lead to different
 * decisions, and routing the second through the first hands the caller a
 * `BridgeCallError` describing a worker that said nothing.
 */
interface PendingCall {
  settle(
    result: BridgeCallResult<RuntimeWorkerCallResponse<RuntimeWorkerCallKind>>,
  ): void;
  abort(cause: Error): void;
}

export function createMainBridgeEndpoint(
  transport: BridgeTransport,
): MainBridgeEndpoint {
  const listeners = new Set<(event: WorkerToMainEvent) => void>();
  const pending = new Map<number, PendingCall>();
  let nextCallId = 1;
  let disposed = false;

  const unsubscribe = transport.subscribe((message) => {
    if (!isWorkerToMainFrame(message)) return;
    if (message.frame === "event") {
      // Iterate a copy, so a listener that unsubscribes (or subscribes) during
      // dispatch cannot mutate the set being walked.
      for (const listener of [...listeners]) listener(message.event);
      return;
    }
    const entry = pending.get(message.callId);
    // A result for a call that already settled - a disposal raced the reply,
    // or a stale worker chunk is answering. Dropping is the only sound move:
    // there is no promise left to settle, and throwing inside a message
    // listener surfaces as an unhandled error with no owner.
    if (entry === undefined) return;
    pending.delete(message.callId);
    entry.settle(message.result);
  });

  return {
    emit(event, transfer): void {
      if (disposed) return;
      const frame: MainToWorkerFrame = { frame: "event", event };
      transport.post(frame, transfer);
    },
    call<K extends RuntimeWorkerCallKind>(
      kind: K,
      request: RuntimeWorkerCallRequest<K>,
      transfer: readonly ArrayBuffer[],
    ): Promise<RuntimeWorkerCallResponse<K>> {
      if (disposed) return Promise.reject(new BridgeDisposedError());
      const callId = nextCallId;
      nextCallId += 1;
      const parse = CALL_RESPONSE_PARSERS[kind];
      return new Promise<RuntimeWorkerCallResponse<K>>((resolve, reject) => {
        pending.set(callId, {
          settle(result): void {
            if (result.outcome === "error") {
              reject(new BridgeCallError(result.name, result.message));
              return;
            }
            const parsed = parse(result.value);
            if (parsed === null) {
              reject(new BridgeResponseMismatchError(kind));
              return;
            }
            resolve(parsed);
          },
          abort(cause): void {
            reject(cause);
          },
        });
        // Registered BEFORE the post, and the ordering is load-bearing rather
        // than stylistic: a synchronous transport (the in-process pair the
        // suites drive, and a same-tick `MessagePort` delivery) can deliver the
        // reply inside this very call, and a table written afterwards would
        // find no entry and drop it as stale.
        const frame: MainToWorkerFrame = {
          frame: "call",
          callId,
          call: buildRuntimeWorkerCall(kind, request),
        };
        transport.post(frame, transfer);
      });
    },
    onEvent(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
      const outstanding = [...pending.values()];
      pending.clear();
      // Reject rather than leave hanging. A worker torn down with a read
      // outstanding is the case where the UI otherwise sits on a spinner with
      // nothing in any log to say why.
      for (const entry of outstanding) entry.abort(new BridgeDisposedError());
    },
  };
}

export function createWorkerBridgeEndpoint(
  transport: BridgeTransport,
  handlers: RuntimeWorkerCallHandlers,
): WorkerBridgeEndpoint {
  const listeners = new Set<(event: MainToWorkerEvent) => void>();
  let disposed = false;

  function post(
    frame: WorkerToMainFrame,
    transfer: readonly ArrayBuffer[],
  ): void {
    if (disposed) return;
    transport.post(frame, transfer);
  }

  const unsubscribe = transport.subscribe((message) => {
    if (!isMainToWorkerFrame(message)) return;
    if (message.frame === "event") {
      for (const listener of [...listeners]) listener(message.event);
      return;
    }
    const { callId } = message;
    void serve(handlers, message.call).then((reply) => {
      post({ frame: "result", callId, result: reply.result }, reply.transfer);
    });
  });

  return {
    emit(event, transfer): void {
      post({ frame: "event", event }, transfer);
    },
    onEvent(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}

interface ServedReply {
  readonly result: BridgeCallResult<
    RuntimeWorkerCallResponse<RuntimeWorkerCallKind>
  >;
  readonly transfer: readonly ArrayBuffer[];
}

/**
 * Runs one call against the handler map, and never rejects.
 *
 * A rejection here would be a lost call - the main thread's promise would hang
 * with nothing to settle it - so every throw becomes an `error` result the
 * caller can see.
 *
 * The `switch` is what correlates a request with its handler: indexing the map
 * by a union-typed key collapses the handlers into one signature whose
 * parameter is the INTERSECTION of every request shape, which no request
 * satisfies. Exhaustiveness is enforced by the `never` arm, so a call added to
 * the protocol without a case here does not compile.
 */
async function serve(
  handlers: RuntimeWorkerCallHandlers,
  call: RuntimeWorkerCall,
): Promise<ServedReply> {
  try {
    switch (call.kind) {
      case "bearer/probe": {
        const reply = await handlers["bearer/probe"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "attachment/read": {
        const reply = await handlers["attachment/read"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      default:
        return unservedCall(call);
    }
  } catch (cause: unknown) {
    return {
      result: {
        outcome: "error",
        name: cause instanceof Error ? cause.name : "Error",
        message: describe(cause),
      },
      transfer: [],
    };
  }
}

function unservedCall(call: never): ServedReply {
  return {
    result: {
      outcome: "error",
      name: "BridgeUnknownCallError",
      message: `The runtime worker has no handler for ${JSON.stringify(call)}`,
    },
    transfer: [],
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : "Unknown worker failure";
}
