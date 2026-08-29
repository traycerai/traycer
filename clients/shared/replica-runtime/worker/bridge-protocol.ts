/**
 * The main-thread <-> runtime-worker message contract.
 *
 * Two shapes of traffic, and the split is an architectural fact rather than a
 * convenience:
 *
 *   - EVENTS travel in both directions and are fire-and-forget. Everything the
 *     worker produces for the UI is an event (projections, patches, logs),
 *     because a projection is a broadcast to whoever is listening and has no
 *     reply.
 *   - CALLS travel in ONE direction only: the main thread asks, the worker
 *     answers. Nothing the worker needs is answerable only by the main thread -
 *     the environment it needs (clock, timers, bearer) is pushed to it, not
 *     pulled from it. Encoding that asymmetry in the types is what keeps a
 *     worker->main request from being added casually later: a worker that
 *     blocks on the main thread has re-created the very stall the relocation
 *     exists to remove.
 *
 * Payloads are structured-clone values only. Nothing here may carry a live
 * `Y.Doc`, an `Awareness`, a function, or a class instance - a `DataCloneError`
 * from `postMessage` surfaces at the boundary with no indication of which field
 * caused it.
 */
import type { RuntimeLogFields } from "../runtime-environment";

/**
 * Bumped when a frame's shape changes incompatibly.
 *
 * Both sides ship in one bundle graph, so a mismatch is not a fleet problem -
 * it is a stale chunk surviving a dev HMR reload, which otherwise presents as
 * a worker that connects and then quietly ignores half its traffic. The
 * handshake turns that into one loud error at startup.
 */
export const RUNTIME_BRIDGE_PROTOCOL_VERSION = 1;

/**
 * What the worker was told about the surface it is serving.
 *
 * Deliberately scalar. The worker does not receive a host client, a store, or
 * anything else that would have to be reconstructed on the other side; it
 * receives the identifiers it needs to build its own, which is what makes the
 * composition root movable at all.
 */
export interface RuntimeWorkerBootstrap {
  readonly protocolVersion: number;
  /**
   * Identifies this renderer window in log lines the worker emits.
   *
   * Per-window, because the worker is per-window: a user with three windows
   * open on one epic has three workers, three durable stores, and three sets
   * of log lines that are otherwise indistinguishable.
   */
  readonly windowLabel: string;
}

/**
 * The bearer as the worker sees it.
 *
 * A discriminated union rather than `token: string | null`, so "signed out" is
 * a state a sender has to name. The synchronous `getBearerToken()` the
 * transport calls cannot cross a thread boundary, so the worker holds a
 * replica of the token and the main thread keeps it current; a nullable field
 * would let a caller push `null` meaning "unchanged" and leave the worker
 * dialing with a token nobody intended.
 */
export type BearerPush =
  | {
      readonly state: "present";
      readonly token: string;
      readonly userId: string;
    }
  | { readonly state: "absent" };

export interface RuntimeWorkerLogEntry {
  readonly level: "debug" | "warn" | "error";
  readonly message: string;
  readonly fields: RuntimeLogFields;
  /**
   * The caught value, already reduced to a string on the worker side.
   *
   * `RuntimeLogger.error` takes `unknown`, which is what a `catch` binding is,
   * and an arbitrary caught value is exactly the thing structured clone
   * refuses (a `DOMException`, a class instance, a value holding a function).
   * Reducing it before it crosses means a logging call can never be the reason
   * a message is lost. `null` for `debug` / `warn`, which have no error arm.
   */
  readonly error: string | null;
}

export type MainToWorkerEvent =
  | { readonly kind: "bootstrap"; readonly bootstrap: RuntimeWorkerBootstrap }
  | { readonly kind: "bearer"; readonly bearer: BearerPush }
  | { readonly kind: "shutdown" };

export type WorkerToMainEvent =
  | { readonly kind: "ready"; readonly protocolVersion: number }
  | { readonly kind: "log"; readonly entry: RuntimeWorkerLogEntry }
  | {
      /**
       * The worker failed in a way it cannot continue from.
       *
       * Distinct from a logged `error`: a fatal says the runtime behind this
       * bridge is gone, so the main thread must surface it rather than let the
       * UI wait forever on projections that will never arrive. Reduced to
       * strings for the same reason `RuntimeWorkerLogEntry.error` is.
       */
      readonly kind: "fatal";
      readonly message: string;
      readonly stack: string | null;
    };

/**
 * Every call the main thread may issue, paired with its answer.
 *
 * One map rather than two parallel unions so a request and its response cannot
 * drift: `call("attachment/read", ...)` is typed by construction, and adding a
 * member without its response arm does not compile.
 */
export interface RuntimeWorkerCallMap {
  /**
   * What bearer does the worker currently hold?
   *
   * The push is one-way and fire-and-forget, which means "the main thread sent
   * it" and "the worker is dialing with it" are different facts. This is the
   * second one, and it is the only way to observe it from outside - the
   * transport reads the holder synchronously, deep inside a dial.
   *
   * Answers the identity, never the token: a bearer that crosses back to the
   * main thread has been copied for no reason, and a diagnostic is the last
   * place a credential should be reachable from.
   */
  readonly "bearer/probe": {
    readonly request: Record<string, never>;
    readonly response: BearerProbe;
  };
  /**
   * Content-addressed attachment bytes out of the worker-held root replica.
   *
   * The response carries bytes, so it is the call that exercises the transfer
   * path. `bytes: null` means the worker cannot answer for this hash - either
   * it holds no replica yet, or the hash is not in the one it holds. The
   * caller cannot tell those apart and must not: both mean "not available from
   * here", and the surviving read paths already treat that as a skip.
   */
  readonly "attachment/read": {
    readonly request: { readonly hash: string };
    readonly response: { readonly bytes: Uint8Array | null };
  };
}

export type BearerProbe =
  | { readonly state: "present"; readonly userId: string }
  | { readonly state: "absent" };

export type RuntimeWorkerCallKind = keyof RuntimeWorkerCallMap;

export type RuntimeWorkerCallRequest<K extends RuntimeWorkerCallKind> =
  RuntimeWorkerCallMap[K]["request"];

export type RuntimeWorkerCallResponse<K extends RuntimeWorkerCallKind> =
  RuntimeWorkerCallMap[K]["response"];

/**
 * A call as it travels, indexed by kind.
 *
 * Named rather than inlined into the union below, because the name is what
 * makes the union CONSTRUCTIBLE from generic code. A function generic in
 * `K extends RuntimeWorkerCallKind` cannot build `{ kind: K, request: … }` and
 * have TypeScript relate it to a bare distributed union - the literal's type
 * mentions the type parameter, the union does not, and there is no rule that
 * connects them (TS2322). Indexing this map at `K` gives a type that IS
 * related, because `Map[K]` is assignable to `Map[AllKinds]` by construction.
 */
export type RuntimeWorkerCallByKind = {
  readonly [K in RuntimeWorkerCallKind]: {
    readonly kind: K;
    readonly request: RuntimeWorkerCallRequest<K>;
  };
};

/**
 * A call as it travels: the kind and its request, in one clonable value.
 *
 * Distributed over the map's keys so `kind` and `request` stay correlated
 * inside the union - a frame naming `"attachment/read"` cannot carry the
 * bearer probe's request.
 */
export type RuntimeWorkerCall = RuntimeWorkerCallByKind[RuntimeWorkerCallKind];

/**
 * Per-kind envelope constructors.
 *
 * One line per call rather than one generic builder, and the repetition is the
 * safety. Inside each arrow `K` is a concrete literal, so TypeScript checks the
 * object against that call's own member of {@link RuntimeWorkerCallByKind} -
 * meaning a constructor that paired `"attachment/read"` with the probe's
 * request would not compile. The generic alternative can only be made to
 * compile with an assertion, and an assertion here is the worst possible
 * place for one: the envelope's discriminant is the single point where a
 * request is bound to its kind, so a cast would let a wrong-kind request
 * through exactly the check that exists to stop it.
 */
const CALL_BUILDERS: {
  readonly [K in RuntimeWorkerCallKind]: (
    request: RuntimeWorkerCallRequest<K>,
  ) => RuntimeWorkerCallByKind[K];
} = {
  "bearer/probe": (request) => ({ kind: "bearer/probe", request }),
  "attachment/read": (request) => ({ kind: "attachment/read", request }),
};

/** Builds the envelope for one call, with its kind and request correlated. */
export function buildRuntimeWorkerCall<K extends RuntimeWorkerCallKind>(
  kind: K,
  request: RuntimeWorkerCallRequest<K>,
): RuntimeWorkerCall {
  return CALL_BUILDERS[kind](request);
}

/**
 * A call's outcome.
 *
 * `Error` does not survive structured clone with its prototype, so a rejection
 * crosses as its name and message and is rebuilt on the other side. Losing the
 * subclass is deliberate: the worker's error types are its own, and a main
 * thread branching on them would be reaching across the boundary this module
 * exists to draw.
 */
export type BridgeCallResult<TResponse> =
  | { readonly outcome: "ok"; readonly value: TResponse }
  | {
      readonly outcome: "error";
      readonly name: string;
      readonly message: string;
    };

export type MainToWorkerFrame =
  | { readonly frame: "event"; readonly event: MainToWorkerEvent }
  | {
      readonly frame: "call";
      readonly callId: number;
      readonly call: RuntimeWorkerCall;
    };

export type WorkerToMainFrame =
  | { readonly frame: "event"; readonly event: WorkerToMainEvent }
  | {
      readonly frame: "result";
      readonly callId: number;
      readonly result: BridgeCallResult<
        RuntimeWorkerCallResponse<RuntimeWorkerCallKind>
      >;
    };

/**
 * Narrows a structured-clone payload to a frame this side understands.
 *
 * The discriminants are checked, the payload beneath them is trusted. Both
 * ends are built from this module in one bundle graph, so the failure this
 * guards is skew (a stale worker chunk, a foreign `postMessage` reaching the
 * same port), not a malformed payload - and for skew, the discriminant IS the
 * evidence. A frame that fails the check is dropped rather than thrown on: a
 * throw inside a `message` listener becomes an unhandled error with no route
 * back to whoever is waiting.
 */
export function isMainToWorkerFrame(
  value: unknown,
): value is MainToWorkerFrame {
  if (!isRecord(value)) return false;
  if (value.frame === "event") return isRecord(value.event);
  return (
    value.frame === "call" &&
    typeof value.callId === "number" &&
    isRecord(value.call) &&
    typeof value.call.kind === "string"
  );
}

export function isWorkerToMainFrame(
  value: unknown,
): value is WorkerToMainFrame {
  if (!isRecord(value)) return false;
  if (value.frame === "event") return isRecord(value.event);
  return (
    value.frame === "result" &&
    typeof value.callId === "number" &&
    isRecord(value.result)
  );
}

/**
 * Per-call response parsers, keyed by call kind.
 *
 * These exist so the endpoint can hand a caller of `call("attachment/read",
 * …)` a value of that call's response type without an assertion anywhere. The
 * pending-call table is keyed by call id and therefore cannot carry each
 * entry's response type; a parser indexed by the kind restores it, and does so
 * by CHECKING rather than by asserting.
 *
 * The check is not ceremony. A worker answering call 7 with call 8's payload
 * is exactly what a stale chunk or a mis-wired handler produces, and without
 * this the wrong-shaped value is handed to the caller as the right type and
 * fails somewhere with no trace back to the boundary. `null` means "not this
 * call's answer", which the endpoint reports as a rejection naming the kind.
 */
export const CALL_RESPONSE_PARSERS: {
  readonly [K in RuntimeWorkerCallKind]: (
    value: unknown,
  ) => RuntimeWorkerCallResponse<K> | null;
} = {
  "bearer/probe": (value) => {
    if (!isRecord(value)) return null;
    if (value.state === "absent") return { state: "absent" };
    if (value.state === "present" && typeof value.userId === "string") {
      return { state: "present", userId: value.userId };
    }
    return null;
  },
  "attachment/read": (value) => {
    if (!isRecord(value)) return null;
    if (value.bytes === null) return { bytes: null };
    return isUint8Array(value.bytes) ? { bytes: value.bytes } : null;
  },
};

/**
 * Realm-independent `Uint8Array` test.
 *
 * `instanceof` is the obvious spelling and it is wrong here, because it asks
 * "was this built by MY realm's constructor" rather than "is this a byte
 * array". Bytes reaching this parser were built by structured clone, and a
 * structured clone deserializes into the RECEIVING realm - which is this one
 * in a browser, but is not in every environment that runs this code. Under
 * jsdom the clone comes from Node's realm while the module's `Uint8Array`
 * binding is jsdom's, so `instanceof` answers false for a perfectly good
 * payload and the parser rejects a reply it should have accepted.
 *
 * That is not merely a testing inconvenience: it is a validator whose verdict
 * depends on which realm minted the object, and the first thing it did was
 * push a suite into asserting on frame metadata instead of on the bytes the
 * caller receives. `ArrayBuffer.isView` reads an internal slot and the
 * `toStringTag` is the type's own, so both cross realms intact - and together
 * they still reject a `DataView` or an `Int16Array`, which is the whole point
 * of checking.
 */
function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
