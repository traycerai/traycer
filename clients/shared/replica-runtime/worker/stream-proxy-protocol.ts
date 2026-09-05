/**
 * The frame-level stream proxy: what crosses so the worker can hold an
 * `IStreamClient` while the real socket stays on the main thread.
 *
 * The transport does NOT move, and two facts decided that. `buildHostStreamClient`
 * has a remote branch reaching `acquireRemoteSession`, a module-scoped
 * process-wide cache in which the RPC messenger, every durable stream client and
 * the app-wide client share exactly ONE `RemoteSession` per (hostId, userId) -
 * one Noise handshake, one relay socket, one re-auth loop. A worker importing
 * that module gets a second one, outside the process-wide wake sweep, and mobile
 * is remote-only. Second: the expensive decode is already ABOVE this seam.
 * `WsStreamClient` parses only the generic method-frame envelope and hands
 * `(envelope, binaryPayload)` onward, so the method-typed zod decode and the Yjs
 * apply are worker-side once the typed wrappers move - which is the point.
 *
 * Every member of `IStreamClient` / `IStreamSession` is therefore an EVENT or a
 * PUSH. There are no worker->main calls at all:
 *
 *   - every worker->main member returns `void` on the interface
 *     (`sendClientFrame`, `requestReconnect`, `close`);
 *   - the two that return a value (`subscribe`, `subscribeWithParamsProvider`)
 *     return an `IStreamSession` the worker CONSTRUCTS ITSELF, which is what the
 *     worker-assigned {@link StreamProxyOpen.streamId} buys - no reply is needed,
 *     so the synchronous return the interface promises is honoured without a
 *     round trip;
 *   - the schema-version reads are SYNCHRONOUS (`SchemaVersion | null`), and a
 *     call cannot answer a synchronous read, so they are pushed replicas.
 *
 * Payloads are structured-clone-safe by construction rather than by convention.
 * `StreamFrameEnvelope` is the parsed JSON of a text WS frame, so it round-trips
 * by definition; `SchemaVersion` is `{ major, minor }`; `StreamCloseReason`
 * carries `FatalErrorDetails`, which is strings and plain nested records. Only
 * the binary payload needs care, and it is TRANSFERRED - see
 * {@link StreamProxyFrame.binaryPayload}.
 */
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { epicSubscribeV13 } from "@traycer/protocol/host/epic/contracts";
import { epicStateSubscribeV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeV10 } from "@traycer/protocol/host/epic/status-subscribe";
import { artifactSubscribeV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ParamsOf } from "@traycer-clients/shared/host-transport/ws-stream-client";

/**
 * The methods this proxy serves - the four the epic runtime's wrappers open,
 * and no others.
 *
 * A CLOSED union is what makes the proxy writable without a single assertion.
 * A general `IStreamClient` proxy would have to turn a wire `method: string`
 * back into `keyof Registry & string` and `params: unknown` into
 * `ParamsOf<Registry, Method>`, and there is no cast-free construction for that
 * over a versioned registry. Over four known members there is: one table entry
 * per method, each checked against that method's own schema.
 *
 * `satisfies` rather than a type annotation, and the difference is the whole
 * point: an annotation would widen the keys to the registry's entire method set
 * and the union would stop being closed. This way the literal keys survive AND
 * a typo is a compile error, because the registry is what they are checked
 * against.
 */
export const EPIC_WORKER_STREAM_METHODS = {
  /** The legacy `@1` arm. */
  "epic.subscribe": true,
  /** The three lanes. */
  "epic.state.subscribe": true,
  "epic.status.subscribe": true,
  "artifact.subscribe": true,
} satisfies Partial<Record<keyof HostStreamRpcRegistry & string, true>>;

export type EpicWorkerStreamMethod = keyof typeof EPIC_WORKER_STREAM_METHODS;

export const EPIC_WORKER_STREAM_METHOD_LIST: readonly EpicWorkerStreamMethod[] =
  Object.keys(EPIC_WORKER_STREAM_METHODS).filter(
    (key): key is EpicWorkerStreamMethod =>
      Object.hasOwn(EPIC_WORKER_STREAM_METHODS, key),
  );

/**
 * The open-request schema each method's params are narrowed with, main-side.
 *
 * Names each contract DIRECTLY rather than indexing the registry, because there
 * is no latest-line accessor for a stream registry - `versioned-stream-rpc.ts`
 * exports only `defineStreamRpcContract`, `defineVersionedStreamRpcRegistry`
 * and `validateVersionedStreamRpcRegistry`, and `getLatestContract` is typed for
 * the separately-branded unary registry. The existing down-translation reaches
 * its line by hand WITH a cast (`ws-stream-client.ts:2653`); naming the exported
 * contract avoids both the cast and a new protocol export.
 *
 * `parse()` returns that schema's `_output`. `ParamsOf<Registry, M>` is
 * `ExtractOpenRequest`, which `infer`s across every line and version and is
 * therefore a UNION of all of them - so the latest line's output is one member
 * of it and assigns with nothing asserted.
 *
 * THE DRIFT THIS OPENS, and why a pin guards it: these names are written by
 * hand. When a method grows a new line the worker, built from the registry,
 * emits latest-line params while this table still parses with the old schema -
 * a strict schema rejects the open, a loose one silently strips the new field,
 * and NEITHER is a compile error, because `ParamsOf`'s union still contains the
 * old output. `epic.subscribe` is already at `@1.3` with four installed
 * versions, so this is a live hazard, not a hypothetical. The identity pin in
 * the proxy's suite compares each entry against the registry's highest
 * line/version and reddens when one is added.
 */
export const OPEN_PARAMS_PARSERS: {
  readonly [M in EpicWorkerStreamMethod]: (
    value: unknown,
  ) => ParamsOf<HostStreamRpcRegistry, M>;
} = {
  "epic.subscribe": (value) => epicSubscribeV13.openRequestSchema.parse(value),
  "epic.state.subscribe": (value) =>
    epicStateSubscribeV10.openRequestSchema.parse(value),
  "epic.status.subscribe": (value) =>
    epicStatusSubscribeV10.openRequestSchema.parse(value),
  "artifact.subscribe": (value) =>
    artifactSubscribeV10.openRequestSchema.parse(value),
};

/** The contracts the parsers name, exposed so the drift pin can compare them. */
export const OPEN_PARAMS_SCHEMA_SOURCES: {
  readonly [M in EpicWorkerStreamMethod]: {
    readonly openRequestSchema: unknown;
  };
} = {
  "epic.subscribe": epicSubscribeV13,
  "epic.state.subscribe": epicStateSubscribeV10,
  "epic.status.subscribe": epicStatusSubscribeV10,
  "artifact.subscribe": artifactSubscribeV10,
};

/**
 * The close a subscribe outside the union produces.
 *
 * Its OWN code, never `INCOMPATIBLE`: that one is read by
 * `isMethodIncompatibleClose` as a capability verdict about the connected host,
 * and reporting it here would pin a permanent "this host is too old" on a host
 * that is perfectly capable of a method the PROXY simply does not carry.
 */
export const STREAM_PROXY_UNKNOWN_METHOD_CODE = "PROXY_METHOD_NOT_CARRIED";

/**
 * Opens one subscription.
 *
 * The `streamId` is assigned by the WORKER, and that is load-bearing rather than
 * a detail. `IStreamClient.subscribe` returns an `IStreamSession`
 * SYNCHRONOUSLY; if main assigned the id, the worker would have to await one
 * before handing back a session, and there is no `await` at that call site.
 */
export interface StreamProxyOpen {
  readonly streamId: number;
  readonly method: string;
  /**
   * The params for the first wire subscribe.
   *
   * Carried even when {@link withParamsProvider} is set, which removes an
   * ordering hazard rather than duplicating state: main's provider closure is
   * SEEDED from this value, so it always has something to return. Pushing the
   * first params separately would leave a window in which main subscribes with
   * nothing.
   */
  readonly params: unknown;
  /**
   * `true` for `subscribeWithParamsProvider`, so main re-reads its held value
   * before every wire subscribe including a reconnect re-declare.
   *
   * Three of the four wrappers use the provider form and one
   * (`epic.status.subscribe`) does not, so both `IStreamClient` members are
   * load-bearing; a proxy implementing only the provider form would look
   * complete against three of four factories.
   *
   * The provider itself cannot cross - `WsStreamClient` invokes it
   * SYNCHRONOUSLY inside subscribe (`ws-stream-client.ts:1930`), so main cannot
   * ask the worker and wait. The worker pushes instead
   * ({@link StreamProxyParams}), re-reading on every status transition it
   * observes, which is when a re-declare is imminent.
   *
   * ACCEPTED COST, and it is real: a reconnect that re-declares between a
   * worker-side state change and the push reporting it uses the previous
   * params. For an epic offering its root state that means offering a slightly
   * older state vector, which the CRDT converges from. Staleness, not loss -
   * but not nothing, and it must not be described as nothing.
   */
  readonly withParamsProvider: boolean;
}

/** A fresh reading of a worker-side params provider. */
export interface StreamProxyParams {
  readonly streamId: number;
  readonly params: unknown;
}

/**
 * One frame, in whichever direction it is travelling.
 *
 * `binaryPayload` is TRANSFERRED, never copied - it is the Yjs update on the hot
 * path and copying it is the cost this relocation exists to avoid. The sender
 * hands it over through `takeBytesForTransfer`, which copies only when the view
 * does not own its whole buffer: transferring a partial view's buffer would
 * detach sibling views on the sending side and hand the receiver neighbouring
 * bytes it has no right to.
 *
 * The receiver must test it with `ArrayBuffer.isView` + `toStringTag`, NEVER
 * `instanceof`. A structured clone deserializes into the RECEIVING realm, and
 * under jsdom that realm is Node's while the module's binding is jsdom's - so
 * `instanceof` rejects a perfectly good payload. That is a validator whose
 * verdict depends on which realm minted the object, and it has already cost
 * this ticket one debugging round.
 */
export interface StreamProxyFrame {
  readonly streamId: number;
  readonly envelope: StreamFrameEnvelope;
  readonly binaryPayload: Uint8Array | null;
}

/**
 * A status transition on one session.
 *
 * Delivered AFTER {@link StreamProxySessionVersion} for the same transition, so
 * a worker reacting to `open` already reads the version negotiated for it. That
 * ordering is achievable because the real session sets its version before it
 * transitions (`ws-stream-client.ts:1947` then `:1977`) and clears it on the
 * FIRST line of `resetForReconnect` (`:2430`), before the `reconnecting`
 * transition. Both edges were checked at source rather than assumed.
 */
export interface StreamProxyStatus {
  readonly streamId: number;
  readonly status: StreamConnectionStatus;
  readonly reason: StreamCloseReason | null;
}

/** The per-SESSION negotiated version, replicated for a synchronous read. */
export interface StreamProxySessionVersion {
  readonly streamId: number;
  readonly version: SchemaVersion | null;
}

/**
 * The client-wide per-METHOD versions and support verdicts, plus the doc arm.
 *
 * One event rather than three, because all three are read off the SAME
 * negotiated manifest and all three change together on the same edge - a
 * reconnect that reaches a new host incarnation. Splitting them would let a
 * worker observe a support verdict from one negotiation beside a doc arm from
 * another, which is the skew the single manifest exists to prevent.
 *
 * Re-pushed on the existing `subscribeMethodSupport` hook
 * (`ws-stream-client.ts:544`, notified at `:997`) and ordered before the status
 * transition that follows, for the same reason the per-session version is.
 *
 * This is what supersedes the earlier "`getDocArm` moves with the record planes"
 * ruling. That rested on the transport moving, so the negotiated manifest would
 * be worker-resident. It stays on main, so the manifest stays on main - and the
 * "two deciders" objection no longer applies, because there is one decider.
 */
export interface StreamProxyManifest {
  /** Per method in the closed union, plus the answer for anything else. */
  readonly methodVersions: ReadonlyArray<{
    readonly method: string;
    readonly version: SchemaVersion | null;
  }>;
  readonly methodSupport: ReadonlyArray<{
    readonly method: string;
    readonly support: "unknown" | "supported" | "unsupported";
  }>;
  /**
   * `readEpicDocRecordArms(...)` as main computes it. A snapshot, not a
   * predicate: the predicate's input is main-thread state now.
   */
  readonly docArm: unknown;
}

/**
 * Narrows a received frame, on BOTH receive paths.
 *
 * One parser rather than one per direction, because the check that matters is
 * identical and a second copy is the one that gets written with `instanceof`.
 *
 * `instanceof Uint8Array` is the obvious spelling and it is WRONG here: it asks
 * "was this built by MY realm's constructor", and a structured clone
 * deserializes into the RECEIVING realm - which under jsdom is Node's while the
 * module's binding is jsdom's. That validator's verdict depends on which realm
 * minted the object, and it has already cost this ticket one debugging round.
 * `ArrayBuffer.isView` reads an internal slot and `toStringTag` is the type's
 * own, so both cross realms intact - and together they still reject a
 * `DataView` or an `Int16Array`, which is the point of checking at all.
 *
 * Returns the REASON on rejection rather than a bare `null`: a frame dropped
 * silently on a hot path is indistinguishable from a host that went quiet, and
 * this is the boundary a stale chunk or a foreign `postMessage` arrives at.
 */
export type StreamProxyFrameParse =
  | { readonly ok: true; readonly frame: StreamProxyFrame }
  | { readonly ok: false; readonly reason: string };

export function parseStreamProxyFrame(value: unknown): StreamProxyFrameParse {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "frame is not an object" };
  }
  const candidate: Record<string, unknown> = { ...value };
  const { streamId, envelope, binaryPayload } = candidate;
  if (typeof streamId !== "number") {
    return { ok: false, reason: "streamId is not a number" };
  }
  if (typeof envelope !== "object" || envelope === null) {
    return { ok: false, reason: "envelope is not an object" };
  }
  const envelopeRecord: Record<string, unknown> = { ...envelope };
  if (typeof envelopeRecord.kind !== "string") {
    return { ok: false, reason: "envelope.kind is not a string" };
  }
  if (typeof envelopeRecord.hasBinaryPayload !== "boolean") {
    return { ok: false, reason: "envelope.hasBinaryPayload is not a boolean" };
  }
  if (binaryPayload !== null && !isTransferredBytes(binaryPayload)) {
    // A `DataView` and an `Int16Array` both pass `ArrayBuffer.isView`; only the
    // tag separates them, and handing either to a typed consumer expecting Yjs
    // bytes produces a decode failure far from here.
    return {
      ok: false,
      reason: "binaryPayload is neither null nor Uint8Array",
    };
  }
  return {
    ok: true,
    frame: {
      streamId,
      envelope: {
        ...envelopeRecord,
        kind: envelopeRecord.kind,
        hasBinaryPayload: envelopeRecord.hasBinaryPayload,
      },
      binaryPayload,
    },
  };
}

function isTransferredBytes(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

/** Identifies one session for the members that carry nothing else. */
export interface StreamProxyStreamRef {
  readonly streamId: number;
}
