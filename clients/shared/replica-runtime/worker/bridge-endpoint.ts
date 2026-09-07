/**
 * The two ends of the runtime bridge.
 * The worker asks the main thread for nothing - see `bridge-protocol.ts`'s header for why that is derived rather than assumed, and what would have to be true for a worker->main call to reappear.
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
import { assertNever } from "../../host-lifecycle/evidence";

/**
 * The pipe, reduced to what a `Worker`, a `MessagePort` and a worker's own global scope can all provide.
 * A structural seam rather than the DOM types on purpose.
 */
export interface BridgeTransport {
  post(message: unknown, transfer: readonly ArrayBuffer[]): void;
  /** Returns the unsubscribe. Multiple subscribers are supported. */
  subscribe(listener: (message: unknown) => void): () => void;
}

export interface BridgeReply<TValue> {
  readonly value: TValue;
  readonly transfer: readonly ArrayBuffer[];
}

/** One handler per call, so a call added to the protocol without an implementation does not compile. */
export type RuntimeWorkerCallHandlers = {
  readonly [K in RuntimeWorkerCallKind]: (
    request: RuntimeWorkerCallRequest<K>,
  ) => Promise<BridgeReply<RuntimeWorkerCallResponse<K>>>;
};

/**
 * The main thread's side of the worker->main call.
 * Answers a plain response rather than a {@link BridgeReply}, and the asymmetry with {@link RuntimeWorkerCallHandlers} is deliberate.
 */
export type MainCallHandlers = {
  readonly [K in MainCallKind]: (
    request: MainCallRequest<K>,
  ) => Promise<MainCallResponse<K>>;
};

export type BridgeCallKind = RuntimeWorkerCallKind | MainCallKind;

/**
 * A rejection that crossed the boundary.
 * Carries the original error's `name` so a caller can still tell one failure class from another without the worker's error classes existing on this side.
 */
export class BridgeCallError extends Error {
  readonly remoteName: string;

  constructor(remoteName: string, message: string) {
    super(message);
    this.name = "BridgeCallError";
    this.remoteName = remoteName;
  }
}

export class BridgeDisposedError extends Error {
  constructor() {
    super("The runtime worker bridge was disposed with calls in flight");
    this.name = "BridgeDisposedError";
  }
}

/**
 * Raised when a reply does not match the shape its call declares.
 * The kind is kept as a field rather than only being formatted into the message, so a caller can branch on it without parsing prose.
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
 * The ask half of the bridge, and the only half a consumer of a spawned worker is handed.
 * Two watermarks over one whole-value stream drop each other's deliveries as stale, which presents as a projection that updates half the time.
 */
export interface RuntimeWorkerPort {
  call<K extends RuntimeWorkerCallKind>(
    kind: K,
    request: RuntimeWorkerCallRequest<K>,
    transfer: readonly ArrayBuffer[],
  ): Promise<RuntimeWorkerCallResponse<K>>;
}

/** The ask half of the other direction, and the only half the relocated composition root is handed. */
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
 * A pending call, reduced to what the table needs to hold.
 * The response type lives in these closures, captured where `call`'s type parameter was still in scope, which is what lets the table be keyed by call id without erasing it.
 */
interface PendingCall<TResponse> {
  settle(result: BridgeCallResult<TResponse>): void;
  abort(cause: Error): void;
}

/**
 * The correlation table.
 * Factored out rather than inlined because the ordering that makes a synchronous reply land (register, then post) and the disposal that aborts rather than hangs are the two things a hand-written copy gets wrong.
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
 * `TUnion` is what the table carries (a call id cannot carry its own response type); `TResponse` is what this caller asked for, restored by `parse`.
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
      // Reject rather than leave hanging.
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
 * Per-member dispatch, which this became the moment `MainCallMap` grew a second member - and the previous shape said so in advance.
 * It read `handlers[call.kind](call.request)`, indexed rather than switched, under a comment explaining that a single-key `MainCall` is not a union, so `default: assertNever(call)` could not compile.
 */
function invokeMainCall(
  handlers: MainCallHandlers,
  call: MainCall,
): Promise<MainCallResponse<MainCallKind>> {
  switch (call.kind) {
    case "main/write-command":
      return handlers[call.kind](call.request);
    case "main/lane-unary":
      return handlers[call.kind](call.request);
    default:
      return assertNever(call, "worker->main call kind");
  }
}

async function serveMainCall(
  handlers: MainCallHandlers,
  call: MainCall,
): Promise<BridgeCallResult<MainCallResponse<MainCallKind>>> {
  try {
    return { outcome: "ok", value: await invokeMainCall(handlers, call) };
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
 * Exhaustiveness is enforced by the `never` arm, so a call added to the protocol without a case here does not compile.
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
      case "body/release": {
        const reply = await handlers["body/release"](call.request);
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
      case "attachment/await": {
        const reply = await handlers["attachment/await"](call.request);
        return {
          result: { outcome: "ok", value: reply.value },
          transfer: reply.transfer,
        };
      }
      case "attachment/cancel": {
        const reply = await handlers["attachment/cancel"](call.request);
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
