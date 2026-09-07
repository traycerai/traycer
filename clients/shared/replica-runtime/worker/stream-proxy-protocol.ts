/**
 * The frame-level stream proxy: what crosses so the worker can hold an `IStreamClient` while the real socket stays on the main thread.
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
 * The methods this proxy serves - the four the epic runtime's wrappers open, and no others.
 * A closed union is what makes the proxy writable without a single assertion.
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
   * `epic.subscribe` is already at `@1.3` with four installed versions, so this is a live hazard, not a hypothetical.
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

export const STREAM_PROXY_UNKNOWN_METHOD_CODE = "PROXY_METHOD_NOT_CARRIED";

/**
 * Opens one subscription.
 * The `streamId` is assigned by the worker, and that is load-bearing rather than a detail.
 */
export interface StreamProxyOpen {
  readonly streamId: number;
  readonly method: string;
  /**
   * The params for the first wire subscribe.
   * Carried even when {@link withParamsProvider} is set, which removes an ordering hazard rather than duplicating state: main's provider closure is seeded from this value, so it always has something to return.
   */
  readonly params: unknown;
  /**
   * `true` for `subscribeWithParamsProvider`, so main re-reads its held value before every wire subscribe including a reconnect re-declare.
   * The provider itself cannot cross - `WsStreamClient` invokes it synchronously inside subscribe (`ws-stream-client.ts:1930`), so main cannot ask the worker and wait.
   */
  readonly withParamsProvider: boolean;
}

export interface StreamProxyParams {
  readonly streamId: number;
  readonly params: unknown;
}

/**
 * One frame, in whichever direction it is travelling.
 * `binaryPayload` is transferred, never copied - it is the Yjs update on the hot path and copying it is the cost this relocation exists to avoid.
 */
export interface StreamProxyFrame {
  readonly streamId: number;
  readonly envelope: StreamFrameEnvelope;
  readonly binaryPayload: Uint8Array | null;
}

/**
 * A status transition on one session.
 * Both edges were checked at source rather than assumed.
 */
export interface StreamProxyStatus {
  readonly streamId: number;
  readonly status: StreamConnectionStatus;
  readonly reason: StreamCloseReason | null;
}

export interface StreamProxySessionVersion {
  readonly streamId: number;
  readonly version: SchemaVersion | null;
}

/**
 * The client-wide per-method versions and support verdicts, plus the doc arm.
 * One event rather than three, because all three are read off the same negotiated manifest and all three change together on the same edge - a reconnect that reaches a new host incarnation.
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
 * Narrows a received frame, on both receive paths.
 * One parser rather than one per direction, because the check that matters is identical and a second copy is the one that gets written with `instanceof`.
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
    // A `DataView` and an `Int16Array` both pass `ArrayBuffer.isView`; only the tag separates them, and handing either to a typed consumer expecting Yjs bytes produces a decode failure far from here.
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

export interface StreamProxyStreamRef {
  readonly streamId: number;
}
