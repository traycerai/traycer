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
 *   - CALLS travel BOTH ways, but not symmetrically in scale. The main thread
 *     asks the worker for anything the replica knows. The worker asks the main
 *     thread for exactly TWO things, and the count is the contract.
 *
 *     The original rule here said "nothing the worker needs is answerable only
 *     by the main thread". That was false, and the transport is where it broke:
 *     `StreamAuthRevalidator` revalidates through the SAME single-flight unary
 *     RPC uses (13 consumers share the instance), and the host-credential mint
 *     is an app-wide single-flight per hostId whose whole purpose is that
 *     concurrent mints cannot supersede one another and leave the host holding
 *     nothing. Those two must stay app-wide, so they are CALLED rather than
 *     copied - a second instance in each worker is the bug they exist to
 *     prevent.
 *
 *     Everything else the worker needs is a value, a push, or an event:
 *     `target`/`userId` ride the bootstrap, the bearer and the dialable
 *     endpoint are pushed on change, and recovery evidence travels outward as
 *     an event. A THIRD worker->main call must not appear without a paragraph
 *     like this one justifying it, and `MAIN_CALL_KINDS` pins the count.
 *
 * Payloads are structured-clone values only. Nothing here may carry a live
 * `Y.Doc`, an `Awareness`, a function, or a class instance - a `DataCloneError`
 * from `postMessage` surfaces at the boundary with no indication of which field
 * caused it.
 */
import type { RevalidateOutcome } from "@traycer-clients/shared/auth/bearer-revalidator";
import type {
  HostCredentialMintOutcome,
  HostCredentialMintRequest,
} from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SendOutcome } from "../adapter";
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
  /** The host this session's transport dials. Fixed for the worker's life. */
  readonly hostId: string;
  /** The signed-in user the session is bound to. Also fixed for life. */
  readonly userId: string;
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
  | {
      /**
       * The dialable endpoint for this worker's host, as the directory sees it
       * right now.
       *
       * A PUSH rather than a call, because `HostEndpointProvider` is read
       * synchronously inside a dial: the worker holds the last value and
       * answers from it. The main thread subscribes the directory and pushes
       * on a genuine endpoint MOVE; the transport's own filtering for what
       * counts as a move travels with the transport unchanged.
       *
       * `null` means "not dialable right now" - a host with no websocket URL,
       * or a confirmed transport refusal - which is exactly what
       * `dialableHostEndpoint` already answers, and what the transport already
       * treats as "do not dial".
       */
      readonly kind: "endpoint";
      readonly endpoint: HostTransportEndpoint | null;
    }
  | { readonly kind: "shutdown" };

export type WorkerToMainEvent =
  | { readonly kind: "ready"; readonly protocolVersion: number }
  | { readonly kind: "log"; readonly entry: RuntimeWorkerLogEntry }
  | {
      /**
       * A published projection slice.
       *
       * `value` is `unknown` at this layer, and deliberately so: the shape it
       * carries is the STORE's published slice, which this module has no
       * business knowing and which would drift the moment the store's owner
       * added a field. The composition root supplies the narrowing, exactly as
       * it does for a call response, and the spawner owns the one reducer
       * that applies them in order (`createRuntimeProjectionOrdering`).
       *
       * `revision` is the sink's own (`ProjectionSink.revision()`), so the two
       * sides share one ordering. It is strictly increasing per worker, and
       * the main side DROPS a revision it has already applied: a re-delivered
       * publication that rolled the UI back to an older slice would be
       * indistinguishable from a legitimate update, because the sink publishes
       * WHOLE values rather than patches.
       */
      readonly kind: "projection";
      readonly revision: number;
      readonly value: unknown;
    }
  | {
      /**
       * This worker's transport reached a host it had previously lost.
       *
       * Fire-and-forget evidence for the selection authority, which lives on
       * the main thread. An EVENT and not a call because nothing is answered
       * and nothing waits: the worker does not care what the authority does
       * with it. Payload-free - the host is fixed at bootstrap, exactly as the
       * main-thread `notifyRecoveredForNamedHost` captured it at open time.
       */
      readonly kind: "host-recovered";
    }
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
  /**
   * Materialize an artifact body: the worker hands back the cold bytes, the
   * main thread builds the live `Y.Doc` from them.
   *
   * The split is the hard constraint made concrete. Tiptap binds a
   * `Y.XmlFragment` synchronously by reference, so the live doc must be a
   * main-thread object; the ENCODED history is what the worker keeps, and it
   * is the expensive part.
   *
   * `docKey` is the identity the lease is held under - the room id on the `@1`
   * arm, the artifact id on the lane arm - and it comes from the worker
   * because only the worker knows which arm is serving. `update: null` means
   * the body is not available (no such artifact, or not served yet), which is
   * the `unavailable` lease grant.
   */
  readonly "body/materialize": {
    readonly request: { readonly artifactId: string };
    readonly response: {
      readonly docKey: string | null;
      readonly update: Uint8Array | null;
      readonly seedMode: ArtifactBodySeedMode;
      /**
       * The host watermark the bytes were encoded against, base64, or `null`
       * for the named not-established state. Never a defaulted `""` - T12
       * ruled that a null watermark is a state with its own meaning.
       */
      readonly hostStateVector: string | null;
    };
  };
  /**
   * Hand a body's encoded state back to the worker and ask it to keep it.
   *
   * Answered only once the worker has settled the bytes; the main thread holds
   * the live doc until then. `accepted: false` means the worker declined this
   * generation - it has already accepted a newer one, or the lease was
   * re-acquired - and the main thread must NOT drop the doc.
   */
  readonly "body/demote": {
    readonly request: {
      readonly docKey: string;
      readonly generation: number;
      readonly update: Uint8Array;
    };
    readonly response: {
      readonly accepted: boolean;
      readonly settledBytes: number;
    };
  };
  /**
   * A local edit leaving the main-thread `Y.Doc` for the body lane.
   *
   * The outbound half of the split: the live doc is main-thread because Tiptap
   * binds it by reference, so an edit made in the editor has to CROSS to reach
   * the lane that sends it.
   *
   * `SendOutcome` is the lane's own verdict, mirrored exactly rather than
   * re-invented - three arms, no fourth. `queued` is not a failure and must not
   * be retried (a retry is a duplicate update, not an idempotent one); only
   * `dropped` is loss, and it is the only arm a caller surfaces.
   *
   * A CALL rather than an event because the outcome belongs to the update that
   * produced it. Nothing awaits it on the hot path - the editor does not block
   * on the lane - but the correlation is what lets a `dropped` name which edit
   * went nowhere.
   */
  readonly "body/update": {
    readonly request: {
      readonly docKey: string;
      readonly update: Uint8Array;
    };
    readonly response: { readonly outcome: SendOutcome };
  };
}

/**
 * How a materialized body's bytes relate to what the client already had.
 *
 * Mirrors T5's tier signature rather than re-inventing it: `"full"` with a
 * CHANGED doc guid REPLACES (splicing two histories under one artifact id is
 * the failure that rule exists for), `"full"` with an unchanged guid installs,
 * and `"delta-against-offer"` merges into the offer's replica.
 */
export type ArtifactBodySeedMode = "full" | "delta-against-offer";

/**
 * The calls the WORKER may issue to the main thread. Exactly two, forever
 * unless the header's paragraph is extended.
 *
 * Both are app-wide single-flights that must not be copied per worker, and
 * both are on the recovery path rather than the hot path - a dial that lost
 * its credential, and a host that needs one minted. Neither is reached while
 * frames are flowing, which is what keeps this from re-creating the stall the
 * relocation removes.
 *
 * The response types are the CONTRACT's own (`RevalidateOutcome`,
 * `HostCredentialMintOutcome`), imported rather than restated: a copy here
 * would drift from the thing that actually produces them.
 */
export interface MainCallMap {
  /**
   * Revalidate the credential after the host refused an open frame.
   *
   * Answered on the main thread by THE existing `StreamAuthRevalidator` - the
   * same single-flight unary RPC shares. A worker holding its own would mint
   * a refresh per open epic on one expiry.
   */
  readonly "main/auth-revalidate": {
    readonly request: Record<string, never>;
    readonly response: { readonly outcome: RevalidateOutcome };
  };
  /**
   * Mint a device credential for a connected host that reports it has none.
   *
   * Answered by THE existing app-wide flow, single-flighted per hostId. The
   * outcome carries tokens, which is why it crosses at all: the transport that
   * needs them is in the worker. It is the one payload on this bridge that is
   * credential-bearing, and it travels only in answer to a call the worker
   * made.
   */
  readonly "main/mint-credential": {
    readonly request: { readonly mint: HostCredentialMintRequest };
    readonly response: { readonly outcome: HostCredentialMintOutcome };
  };
}

export type MainCallKind = keyof MainCallMap;

export type MainCallRequest<K extends MainCallKind> = MainCallMap[K]["request"];
export type MainCallResponse<K extends MainCallKind> =
  MainCallMap[K]["response"];

/**
 * The worker->main call kinds, enumerated as a value.
 *
 * A runtime list beside the type so the COUNT is pinnable: the ruling is "two,
 * and a third needs its own justification", and a type alone cannot be
 * asserted on. A member added to {@link MainCallMap} without a line here fails
 * the exhaustiveness check below.
 */
export const MAIN_CALL_KINDS: readonly MainCallKind[] = [
  "main/auth-revalidate",
  "main/mint-credential",
];

/** Compile-time proof that {@link MAIN_CALL_KINDS} names every member. */
const MAIN_CALL_KIND_COVERAGE: { readonly [K in MainCallKind]: true } = {
  "main/auth-revalidate": true,
  "main/mint-credential": true,
};
void MAIN_CALL_KIND_COVERAGE;

export type MainCall = {
  [K in MainCallKind]: {
    readonly kind: K;
    readonly request: MainCallRequest<K>;
  };
}[MainCallKind];

const MAIN_CALL_BUILDERS: {
  readonly [K in MainCallKind]: (request: MainCallRequest<K>) => MainCall;
} = {
  "main/auth-revalidate": (request) => ({
    kind: "main/auth-revalidate",
    request,
  }),
  "main/mint-credential": (request) => ({
    kind: "main/mint-credential",
    request,
  }),
};

export function buildMainCall<K extends MainCallKind>(
  kind: K,
  request: MainCallRequest<K>,
): MainCall {
  return MAIN_CALL_BUILDERS[kind](request);
}

/**
 * Response parsers for the worker->main direction, for the same reason the
 * other direction has them: the pending table is keyed by call id and cannot
 * carry each entry's response type.
 */
export const MAIN_CALL_RESPONSE_PARSERS: {
  readonly [K in MainCallKind]: (value: unknown) => MainCallResponse<K> | null;
} = {
  "main/auth-revalidate": (value) => {
    if (!isRecord(value)) return null;
    const outcome = value.outcome;
    // The contract's three, spelled out. Writing them by hand is the point: a
    // member added upstream fails this parser rather than silently arriving as
    // an outcome the transport does not handle.
    return outcome === "rotated" ||
      outcome === "rejected" ||
      outcome === "network-error"
      ? { outcome }
      : null;
  },
  "main/mint-credential": (value) => {
    if (!isRecord(value)) return null;
    const parsed = parseMintOutcome(value.outcome);
    return parsed === null ? null : { outcome: parsed };
  },
};

/**
 * Narrows a mint outcome without asserting.
 *
 * Three arms, each rebuilt field by field. Verbose next to a cast, and the
 * verbosity is what makes it a check: the `provisioned` arm carries a token
 * and a refresh token, and a payload that merely *claimed* to be provisioned
 * while missing them would otherwise reach the transport as a credential it
 * cannot use.
 */
function parseMintOutcome(value: unknown): HostCredentialMintOutcome | null {
  if (!isRecord(value)) return null;
  if (value.kind === "unavailable") return { kind: "unavailable" };
  if (value.kind === "pending-elsewhere") {
    return typeof value.retryAfterMs === "number"
      ? { kind: "pending-elsewhere", retryAfterMs: value.retryAfterMs }
      : null;
  }
  if (value.kind !== "provisioned") return null;
  const { token, refreshToken, familyId, provisionedAt, expiresIn } = value;
  if (
    typeof token !== "string" ||
    typeof refreshToken !== "string" ||
    typeof familyId !== "string" ||
    typeof provisionedAt !== "string" ||
    typeof expiresIn !== "number"
  ) {
    return null;
  }
  return {
    kind: "provisioned",
    token,
    refreshToken,
    familyId,
    provisionedAt,
    expiresIn,
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
  "body/materialize": (request) => ({ kind: "body/materialize", request }),
  "body/demote": (request) => ({ kind: "body/demote", request }),
  "body/update": (request) => ({ kind: "body/update", request }),
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
    }
  | {
      /** The main thread ANSWERING a worker->main call. */
      readonly frame: "main-result";
      readonly callId: number;
      readonly result: BridgeCallResult<MainCallResponse<MainCallKind>>;
    };

export type WorkerToMainFrame =
  | { readonly frame: "event"; readonly event: WorkerToMainEvent }
  | {
      readonly frame: "result";
      readonly callId: number;
      readonly result: BridgeCallResult<
        RuntimeWorkerCallResponse<RuntimeWorkerCallKind>
      >;
    }
  | {
      /**
       * The worker ASKING the main thread. Exactly two kinds - see
       * {@link MainCallMap}. Its own frame tag rather than reusing `"call"`,
       * so a reader of either union never has to work out which direction a
       * `call` frame was travelling.
       */
      readonly frame: "main-call";
      readonly callId: number;
      readonly call: MainCall;
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
  if (value.frame === "main-result") {
    return typeof value.callId === "number" && isRecord(value.result);
  }
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
  if (value.frame === "main-call") {
    return (
      typeof value.callId === "number" &&
      isRecord(value.call) &&
      typeof value.call.kind === "string"
    );
  }
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
  "body/materialize": (value) => {
    if (!isRecord(value)) return null;
    const { docKey, update, seedMode, hostStateVector } = value;
    if (docKey !== null && typeof docKey !== "string") return null;
    if (update !== null && !isUint8Array(update)) return null;
    if (seedMode !== "full" && seedMode !== "delta-against-offer") return null;
    if (hostStateVector !== null && typeof hostStateVector !== "string") {
      return null;
    }
    return { docKey, update, seedMode, hostStateVector };
  },
  "body/demote": (value) => {
    if (!isRecord(value)) return null;
    const { accepted, settledBytes } = value;
    if (typeof accepted !== "boolean") return null;
    return typeof settledBytes === "number" ? { accepted, settledBytes } : null;
  },
  "body/update": (value) => {
    if (!isRecord(value)) return null;
    const outcome = value.outcome;
    if (!isRecord(outcome)) return null;
    if (outcome.kind === "sent") return { outcome: { kind: "sent" } };
    if (outcome.kind !== "queued" && outcome.kind !== "dropped") return null;
    // The reason is load-bearing on both non-sent arms - it is what makes a
    // `queued` legible and a `dropped` actionable - so a reasonless outcome is
    // a foreign payload, not a defaulted one.
    return typeof outcome.reason === "string"
      ? { outcome: { kind: outcome.kind, reason: outcome.reason } }
      : null;
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
