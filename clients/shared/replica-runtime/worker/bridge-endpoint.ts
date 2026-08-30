/**
 * The two ends of the runtime bridge.
 *
 * `postMessage` gives us an untyped pipe with no relationship between a
 * message and its reply. These endpoints turn it into the two things the
 * runtime actually needs: a typed event stream in both directions, and a
 * request/response call from the main thread into the worker with real promise
 * semantics.
 *
 * Calls run ONE way. The worker asks the main thread for nothing - see
 * `bridge-protocol.ts`'s header for why that is derived rather than assumed,
 * and what would have to be true for a worker->main call to reappear.
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
  buildMainCall,
  buildRuntimeWorkerCall,
  CALL_RESPONSE_PARSERS,
  isMainToWorkerFrame,
  isWorkerToMainFrame,
  MAIN_CALL_RESPONSE_PARSERS,
  type BridgeCallResult,
  type MainCall,
  type MainCallKind,
  type MainCallRequest,
  type MainCallResponse,
  type MainToWorkerEvent,
  type MainToWorkerFrame,
  type RuntimeWorkerCall,
  type RuntimeWorkerCallKind,
  type RuntimeWorkerCallRequest,
  type RuntimeWorkerCallResponse,
  type WorkerToMainEvent,
  type WorkerToMainFrame,
} from "./bridge-protocol";
import { NO_TRANSFER } from "./transferable-bytes";

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
 * The main thread's side of the worker->main call.
 *
 * Answers a plain response rather than a {@link BridgeReply}, and the asymmetry
 * with {@link RuntimeWorkerCallHandlers} is deliberate. Bytes travel ONE way on
 * this bridge - the replica lives in the worker, so it is the worker that hands
 * over buffers - and the main-thread answer is a small scalar record. Giving
 * these handlers a transfer list would make every one of them write
 * `transfer: NO_TRANSFER` to say something that is true by construction. A
 * second main call that genuinely carried bytes would change this signature, and
 * it would arrive with the justifying paragraph `MainCallMap` already demands.
 */
export type MainCallHandlers = {
  readonly [K in MainCallKind]: (
    request: MainCallRequest<K>,
  ) => Promise<MainCallResponse<K>>;
};

/** Either direction's call kind, for errors that can be raised by both. */
export type BridgeCallKind = RuntimeWorkerCallKind | MainCallKind;

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

/**
 * Raised when a reply does not match the shape its call declares.
 *
 * The kind is kept as a field rather than only being formatted into the
 * message, so a caller can branch on it without parsing prose.
 */
export class BridgeResponseMismatchError extends Error {
  readonly kind: BridgeCallKind;

  constructor(
    responder: "runtime worker" | "main thread",
    kind: BridgeCallKind,
  ) {
    super(`The ${responder} answered '${kind}' with a foreign payload`);
    this.name = "BridgeResponseMismatchError";
    this.kind = kind;
  }
}

/**
 * The ask half of the bridge, and the ONLY half a consumer of a spawned worker
 * is handed.
 *
 * Narrower than {@link MainBridgeEndpoint} on purpose. The event stream has
 * exactly one legitimate subscriber per worker - the spawner, which owns the
 * projection watermark - and an interface carrying `onEvent` is an open
 * invitation to a second one. Two watermarks over one whole-value stream drop
 * each other's deliveries as stale, which presents as a projection that
 * updates half the time. Making that unreachable beats documenting it.
 *
 * `call` only, because `call` is the only member any consumer uses: every
 * main-to-worker EVENT (bootstrap, the stream pushes, shutdown) is the
 * spawner's own.
 * Add a member here when a caller needs it, not in advance.
 */
export interface RuntimeWorkerPort {
  call<K extends RuntimeWorkerCallKind>(
    kind: K,
    request: RuntimeWorkerCallRequest<K>,
    transfer: readonly ArrayBuffer[],
  ): Promise<RuntimeWorkerCallResponse<K>>;
}

/**
 * The ask half of the OTHER direction, and the only half the relocated
 * composition root is handed.
 *
 * Narrower than {@link WorkerBridgeEndpoint} for the same reason
 * {@link RuntimeWorkerPort} is narrower than {@link MainBridgeEndpoint}: the
 * event stream has one owner, and the modules that need to ask the main thread
 * something (the transport's auth recovery, its credential mint) have no
 * business emitting a projection or subscribing to a bootstrap.
 */
export interface MainThreadPort {
  call<K extends MainCallKind>(
    kind: K,
    request: MainCallRequest<K>,
  ): Promise<MainCallResponse<K>>;
}

export interface MainBridgeEndpoint extends RuntimeWorkerPort {
  emit(event: MainToWorkerEvent, transfer: readonly ArrayBuffer[]): void;
  onEvent(listener: (event: WorkerToMainEvent) => void): () => void;
  /** Idempotent. Rejects every in-flight call and stops listening. */
  dispose(): void;
}

export interface WorkerBridgeEndpoint extends MainThreadPort {
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
interface PendingCall<TResponse> {
  settle(result: BridgeCallResult<TResponse>): void;
  abort(cause: Error): void;
}

/**
 * The correlation table.
 *
 * A reply for an id that is no longer pending must be DROPPED - there is no
 * promise left to settle, and throwing inside a message listener is an
 * unhandled error with no owner - and a disposal must ABORT rather than leave
 * promises hanging.
 *
 * Factored out rather than inlined because the ordering that makes a
 * synchronous reply land (register, THEN post) and the disposal that aborts
 * rather than hangs are the two things a hand-written copy gets wrong.
 */
interface PendingCallTable<TResponse> {
  nextId(): number;
  register(callId: number, entry: PendingCall<TResponse>): void;
  settle(callId: number, result: BridgeCallResult<TResponse>): void;
  abortAll(cause: Error): void;
}

function createPendingCallTable<TResponse>(): PendingCallTable<TResponse> {
  const pending = new Map<number, PendingCall<TResponse>>();
  let nextCallId = 1;
  return {
    nextId(): number {
      const callId = nextCallId;
      nextCallId += 1;
      return callId;
    },
    register(callId, entry): void {
      pending.set(callId, entry);
    },
    settle(callId, result): void {
      const entry = pending.get(callId);
      // A result for a call that already settled - a disposal raced the reply,
      // or a stale chunk is answering.
      if (entry === undefined) return;
      pending.delete(callId);
      entry.settle(result);
    },
    abortAll(cause): void {
      const outstanding = [...pending.values()];
      pending.clear();
      for (const entry of outstanding) entry.abort(cause);
    },
  };
}

/**
 * Issues one call and returns its promise, for either direction.
 *
 * `TUnion` is what the table carries (a call id cannot carry its own response
 * type); `TResponse` is what THIS caller asked for, restored by `parse`. The
 * register-before-post ordering lives here, once, and it is load-bearing rather
 * than stylistic: a synchronous transport - the in-process pair the suites
 * drive, and a same-tick `MessagePort` delivery - can deliver the reply inside
 * `post`, and a table written afterwards would find no entry and drop it as
 * stale.
 */
function issueCall<TUnion, TResponse>(args: {
  readonly table: PendingCallTable<TUnion>;
  readonly parse: (value: unknown) => TResponse | null;
  readonly mismatch: () => Error;
  readonly post: (callId: number) => void;
}): Promise<TResponse> {
  const callId = args.table.nextId();
  return new Promise<TResponse>((resolve, reject) => {
    args.table.register(callId, {
      settle(result): void {
        if (result.outcome === "error") {
          reject(new BridgeCallError(result.name, result.message));
          return;
        }
        const parsed = args.parse(result.value);
        if (parsed === null) {
          reject(args.mismatch());
          return;
        }
        resolve(parsed);
      },
      abort(cause): void {
        reject(cause);
      },
    });
    args.post(callId);
  });
}

export function createMainBridgeEndpoint(
  transport: BridgeTransport,
  handlers: MainCallHandlers,
): MainBridgeEndpoint {
  const listeners = new Set<(event: WorkerToMainEvent) => void>();
  const table =
    createPendingCallTable<RuntimeWorkerCallResponse<RuntimeWorkerCallKind>>();
  let disposed = false;

  function post(frame: MainToWorkerFrame, transfer: readonly ArrayBuffer[]) {
    if (disposed) return;
    transport.post(frame, transfer);
  }

  const unsubscribe = transport.subscribe((message) => {
    if (!isWorkerToMainFrame(message)) return;
    if (message.frame === "event") {
      // Iterate a copy, so a listener that unsubscribes (or subscribes) during
      // dispatch cannot mutate the set being walked.
      for (const listener of [...listeners]) listener(message.event);
      return;
    }
    if (message.frame === "main-call") {
      const { callId } = message;
      void serveMainCall(handlers, message.call).then((result) => {
        post({ frame: "main-result", callId, result }, NO_TRANSFER);
      });
      return;
    }
    table.settle(message.callId, message.result);
  });

  return {
    emit(event, transfer): void {
      post({ frame: "event", event }, transfer);
    },
    call<K extends RuntimeWorkerCallKind>(
      kind: K,
      request: RuntimeWorkerCallRequest<K>,
      transfer: readonly ArrayBuffer[],
    ): Promise<RuntimeWorkerCallResponse<K>> {
      if (disposed) return Promise.reject(new BridgeDisposedError());
      const parse = CALL_RESPONSE_PARSERS[kind];
      return issueCall({
        table,
        parse,
        mismatch: () => new BridgeResponseMismatchError("runtime worker", kind),
        post: (callId) => {
          post(
            {
              frame: "call",
              callId,
              call: buildRuntimeWorkerCall(kind, request),
            },
            transfer,
          );
        },
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
      // Reject rather than leave hanging. A worker torn down with a read
      // outstanding is the case where the UI otherwise sits on a spinner with
      // nothing in any log to say why.
      table.abortAll(new BridgeDisposedError());
    },
  };
}

export function createWorkerBridgeEndpoint(
  transport: BridgeTransport,
  handlers: RuntimeWorkerCallHandlers,
): WorkerBridgeEndpoint {
  const listeners = new Set<(event: MainToWorkerEvent) => void>();
  const table = createPendingCallTable<MainCallResponse<MainCallKind>>();
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
    if (message.frame === "main-result") {
      table.settle(message.callId, message.result);
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
    call<K extends MainCallKind>(
      kind: K,
      request: MainCallRequest<K>,
    ): Promise<MainCallResponse<K>> {
      if (disposed) return Promise.reject(new BridgeDisposedError());
      const parse = MAIN_CALL_RESPONSE_PARSERS[kind];
      return issueCall({
        table,
        parse,
        mismatch: () => new BridgeResponseMismatchError("main thread", kind),
        post: (callId) => {
          post(
            { frame: "main-call", callId, call: buildMainCall(kind, request) },
            NO_TRANSFER,
          );
        },
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
      // A worker torn down mid-command would otherwise leave its queue awaiting
      // a verdict forever, inside a thread about to be terminated.
      table.abortAll(new BridgeDisposedError());
    },
  };
}

/**
 * Runs the worker->main call against the main-side handler, and never rejects -
 * for the same reason {@link serve} does not: a rejection here is a lost call,
 * and the worker's promise would hang with nothing to settle it, inside a
 * command queue that is waiting on the verdict.
 */
async function serveMainCall(
  handlers: MainCallHandlers,
  call: MainCall,
): Promise<BridgeCallResult<MainCallResponse<MainCallKind>>> {
  try {
    // Indexed, not switched, and ONLY because `MainCallMap` has exactly one
    // member. A `switch` with a `default: assertNever(call)` does not compile
    // here: `MainCall` over a single key is not a UNION, so TypeScript has no
    // member to exhaust and leaves `call` fully typed in the default arm
    // instead of narrowing it to `never`. Writing that switch is what produced
    // this file's only compile red.
    //
    // Indexing is also the forcing function a grep rule would only ask for. A
    // SECOND member makes `call.kind` a union, `handlers[call.kind]` a union of
    // function types, and the call below requires the INTERSECTION of their
    // parameters - which no request satisfies. So adding one fails to compile
    // on this exact line, and whoever adds it writes the per-member dispatch
    // then, when the union it needs actually exists.
    const value = await handlers[call.kind](call.request);
    return { outcome: "ok", value };
  } catch (cause: unknown) {
    return {
      outcome: "error",
      name: cause instanceof Error ? cause.name : "Error",
      message: describe(cause),
    };
  }
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
      case "attachment/read": {
        const reply = await handlers["attachment/read"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "body/materialize": {
        const reply = await handlers["body/materialize"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "body/demote": {
        const reply = await handlers["body/demote"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "body/update": {
        const reply = await handlers["body/update"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "root/encode": {
        const reply = await handlers["root/encode"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "root/apply": {
        const reply = await handlers["root/apply"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "command/enqueue": {
        const reply = await handlers["command/enqueue"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "mutation/apply": {
        // A handler that THROWS is expected here and is not an anomaly:
        // `reparent-artifact` rejects an illegal move by throwing, and the
        // catch below turns that into `{ outcome: "error", name, message }` so
        // the caller can still tell one rejection from another by `name`.
        const reply = await handlers["mutation/apply"](call.request);
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
