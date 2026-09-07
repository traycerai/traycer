/**
 * The main-thread <-> runtime-worker message contract.
 * Two shapes of traffic, and the split is an architectural fact rather than a convenience: - Events travel in both directions and are fire-and-forget.
 */
import type {
  StreamProxyFrame,
  StreamProxyManifest,
  StreamProxyOpen,
  StreamProxyParams,
  StreamProxySessionVersion,
  StreamProxyStatus,
  StreamProxyStreamRef,
} from "./stream-proxy-protocol";
import type { CommandResolution, CommandSendFailure } from "../command-overlay";
import type { SendOutcome } from "../adapter";
import type { RuntimeLogFields } from "../runtime-environment";
import type { ProtectedBytes } from "../memory-accountant";
import {
  earlyMetaEpicSchema,
  type EarlyMetaEpic,
} from "@traycer/protocol/host/epic/snapshot-meta";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  ChatRecordDelta,
  TuiAgentRecordDelta,
} from "../../host-transport/chat-records-stream-client";

/**
 * Bumped when a frame's shape changes incompatibly.
 * Both sides ship in one bundle graph, so a mismatch is not a fleet problem - it is a stale chunk surviving a dev HMR reload, which otherwise presents as a worker that connects and then quietly ignores half its traffic.
 */
export const RUNTIME_BRIDGE_PROTOCOL_VERSION = 13;

/**
 * The runtime facts main's books read between settlements.
 * Three of {@link EpicRuntimeAccountingSource}'s four members are pure reads, and after relocation they are read Synchronously by an accountant on main while their answers live in the worker.
 */
export interface RuntimeAccountingSnapshot {
  readonly materializedRoomIds: readonly string[];
  readonly rootBytes: number;
  /**
   * The tier's Last Known protected breakdown, and the reason this member exists rather than being defaulted to empty on main.
   * The breakdown is the only thing that distinguishes them, and reporting an empty one would tell the accountant a plane is unprotected at the exact moment it is entirely pinned.
   */
  readonly protectedBytesByKind: readonly ProtectedBytes[];
  readonly projectionCounts: unknown;
}

export type RuntimeAccountingSettlement =
  | { readonly kind: "root"; readonly bytes: number }
  | {
      readonly kind: "cold-room";
      readonly artifactRoomId: string;
      readonly bytes: number;
    }
  | { readonly kind: "command-overlay"; readonly bytes: number }
  | {
      readonly kind: "hot-doc";
      readonly artifactRoomId: string;
      readonly bytes: number;
    }
  | {
      readonly kind: "hot-doc-provisional";
      readonly artifactRoomId: string;
      readonly bytes: number;
    }
  | { readonly kind: "hot-doc-release"; readonly artifactRoomId: string };

  /**
   * What the worker was told about the surface it is serving.
   * `userId` remains absent and remains without a reader.
   */
export interface RuntimeWorkerBootstrap {
  readonly protocolVersion: number;
  /**
   * The epic this worker serves, for its whole life.
   * The reader is the composition root: it cannot construct a runtime without an epic id, and the id cannot arrive later because the composition is what every subsequent frame is answered by.
   */
  readonly epicId: string;
  /**
   * The host this session is bound to, for its whole life.
   * That is the reader, and it is why the field is not optional.
   */
  readonly hostId: string;
  /** Identifies this renderer window in log lines the worker emits. */
  readonly windowLabel: string;
}

export interface RuntimeWorkerLogEntry {
  readonly level: "debug" | "warn" | "error";
  readonly message: string;
  readonly fields: RuntimeLogFields;
  /**
   * The caught value, already reduced to a string on the worker side.
   * `RuntimeLogger.error` takes `unknown`, which is what a `catch` binding is, and an arbitrary caught value is exactly the thing structured clone refuses (a `DOMException`, a class instance, a value holding a function).
   */
  readonly error: string | null;
}

export type MainToWorkerEvent =
  | { readonly kind: "bootstrap"; readonly bootstrap: RuntimeWorkerBootstrap }
  | { readonly kind: "stream/frame"; readonly frame: StreamProxyFrame }
  | {
      /**
       * The per-session negotiated version, pushed Before the status transition it belongs to.
       * A push and not a call because the worker's read (`getNegotiatedSchemaVersion`) is synchronous.
       */
      readonly kind: "stream/session-version";
      readonly version: StreamProxySessionVersion;
    }
  | { readonly kind: "stream/status"; readonly status: StreamProxyStatus }
  | {
      /**
       * Client-wide versions, per-method support, and the doc arm - one event because all three are read off the same negotiated manifest and move on the same edge.
       */
      readonly kind: "stream/manifest";
      readonly manifest: StreamProxyManifest;
    }
  | {
      /**
       * The signed-in user, as the auth store sees it right now.
       * Its Own event, not a field on `stream/manifest`, and the rule is one event per Producer: the manifest's producer is the transport, this one's is `useAuthStore`.
       */
      readonly kind: "current-user";
      readonly userId: string | null;
    }
  | {
      /**
       * A local presence frame for one artifact body, on its way to the arm.
       * An Event, not a call: presence is fire-and-forget and self-corrects on the next frame, so a dropped one costs a stale cursor rather than data.
       */
      readonly kind: "body/awareness-out";
      readonly docKey: string;
      readonly frame: Uint8Array;
      /** The `clientID` of the main-side `Awareness` this frame speaks for. */
      readonly localClientId: number;
    }
  | {
      /**
       * One fire-and-forget command for the relocated runtime.
       * See {@link RuntimeCommandMap} for why this is one kind rather than fifteen, and for the FIFO-ordering invariant that makes it safe.
       */
      readonly kind: "runtime/command";
      readonly command: RuntimeCommand;
    }
  | {
      /**
       * Free `overBytes` from the hot-doc tier, which lives in the worker.
       * The one Inbound half of the accounting seam, and the only one of `EpicRuntimeAccountingSource`'s four members that is not a pure read: it performs the eviction.
       */
      readonly kind: "accounting/demote";
      readonly overBytes: number;
    }
  | { readonly kind: "shutdown" };

export type WorkerToMainEvent =
  | { readonly kind: "ready"; readonly protocolVersion: number }
  | { readonly kind: "log"; readonly entry: RuntimeWorkerLogEntry }
  | {
      /** A published projection slice. */
      readonly kind: "projection";
      readonly revision: number;
      readonly value: unknown;
    }
  | {
  /**
   * Open one subscription. The `streamId` is the worker's, which is what
   * lets `subscribe` return a session synchronously with no reply.
   */
      readonly kind: "stream/open";
      readonly open: StreamProxyOpen;
    }
  | { readonly kind: "stream/params"; readonly params: StreamProxyParams }
  | { readonly kind: "stream/send"; readonly frame: StreamProxyFrame }
  | { readonly kind: "stream/reconnect"; readonly stream: StreamProxyStreamRef }
  | { readonly kind: "stream/close"; readonly stream: StreamProxyStreamRef }
  | {
      /**
       * The worker failed in a way it cannot continue from.
       * Distinct from a logged `error`: a fatal says the runtime behind this bridge is gone, so the main thread must surface it rather than let the UI wait forever on projections that will never arrive.
       */
      readonly kind: "fatal";
      readonly message: string;
      readonly stack: string | null;
    }
  | {
      /**
       * A collaborator's edit, for the live body doc Main holds.
       * Pushed only for a docKey main is known to hold.
       */
      readonly kind: "body/doc-in";
      readonly docKey: string;
      readonly update: Uint8Array;
    }
  | {
      /** A remote presence frame for one body, for main's `Awareness`. */
      readonly kind: "body/awareness-in";
      readonly docKey: string;
      readonly frame: Uint8Array;
    }
  | {
      /** The runtime's books came up, or went away. */
      readonly kind: "accounting/books";
      readonly registered: boolean;
      readonly snapshot: RuntimeAccountingSnapshot | null;
    }
  | {
      /** One settled byte fact, plus the reads main's accountant needs. */
      readonly kind: "accounting/settle";
      readonly settlement: RuntimeAccountingSettlement;
      readonly snapshot: RuntimeAccountingSnapshot;
    };

    /**
     * The fire-and-forget commands the main thread issues to the relocated runtime.
     * One inbound event kind carries all of them, the same collapse `mutation/apply` makes for calls: +1 top-level kind instead of +15.
     */
export type ConfirmedChatMutation =
  | { readonly kind: "upsert"; readonly record: ChatRecordSummaryV11 }
  | {
      readonly kind: "remove";
      readonly ownerUserId: string;
      readonly originHostId: string;
      readonly chatId: string;
    };

export interface RuntimeCommandMap {
  "apply-chat-records": {
    readonly records: readonly ChatRecordSummaryV11[];
    readonly issuedAtSeq: number | null;
  };
  "apply-chat-record-delta": { readonly delta: ChatRecordDelta };
  "apply-confirmed-chat-mutation": { readonly mutation: ConfirmedChatMutation };
  "apply-tui-agent-records": {
    readonly records: readonly TuiAgentRecordSummaryV12[];
    readonly issuedAtSeq: number | null;
  };
  "apply-tui-agent-record-delta": { readonly delta: TuiAgentRecordDelta };
  "mark-chat-records-authoritative": Record<string, never>;
  "mark-chat-records-not-authoritative": Record<string, never>;
  /**
   * `pending` is `unknown` for the same reason `projectionCounts` and the manifest's `docArm` are: `PendingChatCreation` belongs to gui-app, and a copy of it here would rot against the original.
   */
  "begin-pending-chat-creation": { readonly pending: unknown };
  "clear-pending-chat-creation": { readonly chatId: string };
  "republish-records-for-current-user": Record<string, never>;
  "reproject-for-viewer-change": Record<string, never>;
  "discard-unsynced-edits": Record<string, never>;
  "request-fresh-snapshot": Record<string, never>;
  "retry-migration": Record<string, never>;
  "retry-write-command": { readonly commandId: string };
  "discard-write-command": { readonly commandId: string };
  /**
   * End the Transport while the replica lives on - the retained-dirty / window-repoint path.
   * Idempotent at the far end, which is the worker's own latch rather than bookkeeping added for this.
   */
  "detach-transport": Record<string, never>;
}

export type RuntimeCommandKind = keyof RuntimeCommandMap;
export type RuntimeCommandPayload<K extends RuntimeCommandKind> =
  RuntimeCommandMap[K];

export type RuntimeCommand = {
  [K in RuntimeCommandKind]: {
    readonly kind: K;
    readonly payload: RuntimeCommandPayload<K>;
  };
}[RuntimeCommandKind];

const RUNTIME_COMMAND_COVERAGE: {
  readonly [K in RuntimeCommandKind]: true;
} = {
  "apply-chat-records": true,
  "apply-chat-record-delta": true,
  "apply-confirmed-chat-mutation": true,
  "apply-tui-agent-records": true,
  "apply-tui-agent-record-delta": true,
  "mark-chat-records-authoritative": true,
  "mark-chat-records-not-authoritative": true,
  "begin-pending-chat-creation": true,
  "clear-pending-chat-creation": true,
  "republish-records-for-current-user": true,
  "reproject-for-viewer-change": true,
  "discard-unsynced-edits": true,
  "request-fresh-snapshot": true,
  "retry-migration": true,
  "retry-write-command": true,
  "discard-write-command": true,
  "detach-transport": true,
};

export const RUNTIME_COMMAND_KINDS: readonly RuntimeCommandKind[] = Object.keys(
  RUNTIME_COMMAND_COVERAGE,
).filter((key): key is RuntimeCommandKind =>
  Object.hasOwn(RUNTIME_COMMAND_COVERAGE, key),
);

/**
 * The metadata mutations the main thread asks the worker to perform.
 * That is the whole point of declaring request and response together instead of as two unions that happen to have matching arms.
 */
export interface EpicMutationMap {
  "rename-artifact": {
    request: { readonly artifactId: string; readonly title: string };
    /** Whether the doc actually changed. Drives the caller's follow-on write. */
    response: { readonly changed: boolean };
  };
  "delete-artifact": {
    request: { readonly artifactId: string };
    response: { readonly changed: boolean };
  };
  "reparent-artifact": {
    request: {
      readonly artifactId: string;
      readonly newParentId: string | null;
    };
    response: { readonly changed: boolean };
  };
  "begin-rename": {
    request: { readonly nodeId: string; readonly title: string };
    /** `null` when nothing was stamped - the caller skips its retire. */
    response: { readonly requestId: string | null };
  };
  "begin-epic-title": {
    request: { readonly title: string };
    response: { readonly requestId: string | null };
  };
  "begin-reparent": {
    request: {
      readonly nodeId: string;
      readonly newParentId: string | null;
    };
    response: { readonly requestId: string | null };
  };
  "retire-pending": {
    request: {
      readonly requestId: string;
      readonly outcome: "landed" | "failed";
    };
    response: { readonly retired: boolean };
  };
  "is-latest-rename-stamp": {
    request: { readonly nodeId: string; readonly requestId: string };
    response: { readonly latest: boolean };
  };
}

export type EpicMutationKind = keyof EpicMutationMap;
export type EpicMutationRequest<K extends EpicMutationKind> =
  EpicMutationMap[K]["request"];
export type EpicMutationResponse<K extends EpicMutationKind> =
  EpicMutationMap[K]["response"];

export type EpicMutation = {
  [K in EpicMutationKind]: {
    readonly kind: K;
    readonly request: EpicMutationRequest<K>;
  };
}[EpicMutationKind];

/**
 * One answer, carrying its kind back.
 * The kind rides the response so a Caller can narrow with a literal check rather than an assertion: `result.kind === "begin-rename"` gives it `{ requestId: string | null }` and nothing wider.
 */
export type EpicMutationResult = {
  [K in EpicMutationKind]: {
    readonly kind: K;
    readonly value: EpicMutationResponse<K>;
  };
}[EpicMutationKind];

/**
 * The "nothing happened" answer for any mutation kind.
 * One source, because four places need it and they must agree: the host before a core is installed, the core after it stops serving, the in-process port that serves body calls only, and the stub handlers.
 */
export function inertMutationResult(
  mutation: EpicMutation,
): EpicMutationResult {
  switch (mutation.kind) {
    case "rename-artifact":
    case "delete-artifact":
    case "reparent-artifact":
      return { kind: mutation.kind, value: { changed: false } };
    case "begin-rename":
    case "begin-epic-title":
    case "begin-reparent":
      return { kind: mutation.kind, value: { requestId: null } };
    case "retire-pending":
      return { kind: mutation.kind, value: { retired: false } };
    case "is-latest-rename-stamp":
      return { kind: mutation.kind, value: { latest: false } };
  }
}

const EPIC_MUTATION_KIND_COVERAGE: {
  readonly [K in EpicMutationKind]: true;
} = {
  "rename-artifact": true,
  "delete-artifact": true,
  "reparent-artifact": true,
  "begin-rename": true,
  "begin-epic-title": true,
  "begin-reparent": true,
  "retire-pending": true,
  "is-latest-rename-stamp": true,
};

export const EPIC_MUTATION_KINDS: readonly EpicMutationKind[] = Object.keys(
  EPIC_MUTATION_KIND_COVERAGE,
).filter((key): key is EpicMutationKind =>
  Object.hasOwn(EPIC_MUTATION_KIND_COVERAGE, key),
);

const MAIN_TO_WORKER_EVENT_COVERAGE: {
  readonly [K in MainToWorkerEvent["kind"]]: true;
} = {
  bootstrap: true,
  "current-user": true,
  "stream/frame": true,
  "stream/session-version": true,
  "stream/status": true,
  "stream/manifest": true,
  "accounting/demote": true,
  "runtime/command": true,
  "body/awareness-out": true,
  shutdown: true,
};

const WORKER_TO_MAIN_EVENT_COVERAGE: {
  readonly [K in WorkerToMainEvent["kind"]]: true;
} = {
  ready: true,
  log: true,
  projection: true,
  "stream/open": true,
  "stream/params": true,
  "stream/send": true,
  "stream/reconnect": true,
  "stream/close": true,
  fatal: true,
  "accounting/books": true,
  "accounting/settle": true,
  "body/doc-in": true,
  "body/awareness-in": true,
};

export const MAIN_TO_WORKER_EVENT_KINDS: readonly MainToWorkerEvent["kind"][] =
  Object.keys(MAIN_TO_WORKER_EVENT_COVERAGE).filter(
    (key): key is MainToWorkerEvent["kind"] =>
      Object.hasOwn(MAIN_TO_WORKER_EVENT_COVERAGE, key),
  );

export const WORKER_TO_MAIN_EVENT_KINDS: readonly WorkerToMainEvent["kind"][] =
  Object.keys(WORKER_TO_MAIN_EVENT_COVERAGE).filter(
    (key): key is WorkerToMainEvent["kind"] =>
      Object.hasOwn(WORKER_TO_MAIN_EVENT_COVERAGE, key),
  );

  /**
   * The stream-proxy family of worker->main events, as One type.
   * These five are the only members `stream-proxy-host` serves, and the only ones `worker-stream-client` produces.
   */
export type StreamProxyWorkerEvent = Extract<
  WorkerToMainEvent,
  { kind: `stream/${string}` }
>;

export function isStreamProxyEvent(
  event: WorkerToMainEvent,
): event is StreamProxyWorkerEvent {
  return event.kind.startsWith("stream/");
}

/**
 * Every call the main thread may issue, paired with its answer.
 * One map rather than two parallel unions so a request and its response cannot drift: `call("attachment/read", ...)` is typed by construction, and adding a member without its response arm does not compile.
 */
export interface RuntimeWorkerCallMap {
  /**
   * Attachment bytes, Waiting for a hash that has not replicated yet.
   * Without cancellation this is the indefinite park that `attachment/read` was fixed to avoid - a call slot held for the life of the worker.
   */
  "attachment/await": {
    request: { readonly awaitId: number; readonly hash: string };
    /** `null` when cancelled or when the runtime tore down. */
    response: { readonly bytes: Uint8Array | null };
  };
  /**
   * Stop waiting.
   * `cancelled: false` for an id that was never pending or has already settled - that race is inherent (bytes can land while the cancel is in flight) and is a no-op, not a fault.
   */
  "attachment/cancel": {
    request: { readonly awaitId: number };
    response: { readonly cancelled: boolean };
  };

  /** The root replica's encoded state, for a transfer into another session. */
  "root/encode": {
    request: Record<string, never>;
    response: { readonly update: Uint8Array };
  };
  /** Take a root state in. */
  "root/apply": {
    request: {
      readonly update: Uint8Array;
      readonly asLocalEdit: boolean;
    };
    response: { readonly applied: boolean };
  };

  /**
   * Enqueue one epic write command on the runtime's queue.
   * Pushing an intent and minting an id on main would hand back an id for a command the queue may have refused, and the caller's `waitForWriteCommand` would then watch the projection for a record that never arrives.
   */
  "command/enqueue": {
    request: { readonly intent: unknown };
    /** The refusal is its Own arm, not a nullable id. */
    response:
      | { readonly outcome: "enqueued"; readonly commandId: string }
      | { readonly outcome: "refused" };
  };

  /**
   * One metadata mutation, applied by the replica.
   * A single member carrying {@link EpicMutation} rather than eight members, so the call vocabulary does not grow by eight for one relocation.
   */
  "mutation/apply": {
    request: EpicMutation;
    response: EpicMutationResult;
  };

  /**
   * Content-addressed attachment bytes out of the worker-held root replica.
   * `bytes: null` means the worker cannot answer for this hash - either it holds no replica yet, or the hash is not in the one it holds.
   */
  readonly "attachment/read": {
    readonly request: { readonly hash: string };
    readonly response: { readonly bytes: Uint8Array | null };
  };
  /**
   * Materialize an artifact body: the worker hands back the cold bytes, the main thread builds the live `Y.Doc` from them.
   * Tiptap binds a `Y.XmlFragment` synchronously by reference, so the live doc must be a main-thread object; the Encoded history is what the worker keeps, and it is the expensive part.
   */
  readonly "body/materialize": {
    readonly request: { readonly artifactId: string };
    readonly response: {
      readonly docKey: string | null;
      readonly update: Uint8Array | null;
      /**
       * The document identity these bytes were cut at, or `null` on the not-held arm - which has no document to identify.
       */
      readonly docGuid: string | null;
      readonly seedMode: ArtifactBodySeedMode;
      /**
       * The host watermark the bytes were encoded against, base64, or `null` for the named not-established state.
       * Never a defaulted `""` - T12 ruled that a null watermark is a state with its own meaning.
       */
      readonly hostStateVector: string | null;
      /**
       * The room's currently-known Remote peers, for main's fresh `Awareness`.
       * Rides the Response rather than arriving as a `body/awareness-in` push, and that is an ordering fact rather than a preference.
       */
      readonly awarenessFrames: readonly Uint8Array[];
    };
  };
  /** Hand a body's encoded state back to the worker; answered only once the worker has settled the bytes. */
  /** Let go of a Forward-Only body. Counterpart to `body/demote`, deliberately a different shape rather than a flag on it. */
  readonly "body/release": {
    readonly request: { readonly docKey: string };
    readonly response: {
      readonly released: boolean;
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    };
  };
  readonly "body/demote": {
    readonly request: {
      readonly docKey: string;
      readonly generation: number;
      /** The identity the caller materialized at - see `body/materialize`. */
      readonly docGuid: string;
      readonly update: Uint8Array;
    };
    readonly response: {
      readonly accepted: boolean;
      readonly settledBytes: number;
      /**
       * Why a demote was refused.
       * A demote refused for identity where you expected pinned is a real bug, and without this it is indistinguishable at the seam.
       */
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    };
  };
  /**
   * A local edit leaving the main-thread `Y.Doc` for the body lane.
   * `SendOutcome` is the lane's own verdict, mirrored exactly rather than re-invented - three arms, no fourth.
   */
  readonly "body/update": {
    readonly request: {
      readonly docKey: string;
      readonly update: Uint8Array;
    };
    readonly response: { readonly outcome: SendOutcome };
  };
}

export type ArtifactBodySeedMode = "full" | "delta-against-offer";

/**
 * The calls the Worker may issue to the main thread.
 * Main Owns The Error in both, for one reason: an `Error` does not survive structured clone.
 */
export interface MainCallMap {
  /**
   * Send one epic write command through the main thread's unary requester.
   * An `Error` does not survive structured clone, so the worker must never see one: main runs the real send, catches, applies `classifyEpicWriteCommandFailure`, and returns the classifier's own union.
   */
  readonly "main/write-command": {
    readonly request: {
      readonly commandId: string;
      /** The intent, already reduced to its clonable wire form by the caller. */
      readonly intent: unknown;
    };
    readonly response: WriteCommandOutcome;
  };
  /**
   * The two unary reads that complete the epic Lane surface - `epic.getWorkspaceContext@1.0` and `epic.retryMigration@1.0` - issued on the main thread's requester.
   * Both are on `hostRpcRegistry`, not the stream registry: they are unaries, so they ride the main-thread messenger, and the messenger reaches the same process-wide `RemoteSession` cache as the socket.
   */
  readonly "main/lane-unary": {
    readonly request: LaneUnaryRequest;
    readonly response: LaneUnaryOutcome;
  };
}

/**
 * Which lane unary to issue.
 * No `epicId`: the Session owns it, exactly as it does for `main/write-command`, so main's handler supplies it rather than trusting a value that crossed a boundary.
 */
export type LaneUnaryRequest =
  | { readonly kind: "workspace-context" }
  | { readonly kind: "retry-migration" };

  /**
   * What main answers a lane unary with.
   * `ok: false` carries a `reason` String rather than a classified union, and the asymmetry with `WriteCommandOutcome` is deliberate rather than an omission.
   */
export type LaneUnaryOutcome =
  | {
      readonly ok: true;
      readonly kind: "workspace-context";
      readonly context: EarlyMetaEpic;
    }
  | { readonly ok: true; readonly kind: "retry-migration" }
  | { readonly ok: false; readonly reason: string };

  /**
   * What main answers a write command with.
   * `failure` is `CommandSendFailure` - the Contract's own type, imported rather than restated.
   */
export type WriteCommandOutcome =
  | { readonly ok: true; readonly hostId: string }
  | { readonly ok: false; readonly failure: CommandSendFailure };

export type MainCallKind = keyof MainCallMap;

export type MainCallRequest<K extends MainCallKind> = MainCallMap[K]["request"];
export type MainCallResponse<K extends MainCallKind> =
  MainCallMap[K]["response"];

export const MAIN_CALL_KIND_COVERAGE: {
  readonly [K in MainCallKind]: true;
} = { "main/write-command": true, "main/lane-unary": true };

/**
 * The worker->main call kinds, Derived from the record so there is one place a member can be added - and that place fails to compile when incomplete.
 */
export const MAIN_CALL_KINDS: readonly MainCallKind[] = Object.keys(
  MAIN_CALL_KIND_COVERAGE,
).filter((key): key is MainCallKind =>
  Object.hasOwn(MAIN_CALL_KIND_COVERAGE, key),
);

export type MainCall = {
  [K in MainCallKind]: {
    readonly kind: K;
    readonly request: MainCallRequest<K>;
  };
}[MainCallKind];

const MAIN_CALL_BUILDERS: {
  readonly [K in MainCallKind]: (request: MainCallRequest<K>) => MainCall;
} = {
  "main/write-command": (request) => ({ kind: "main/write-command", request }),
  "main/lane-unary": (request) => ({ kind: "main/lane-unary", request }),
};

export function buildMainCall<K extends MainCallKind>(
  kind: K,
  request: MainCallRequest<K>,
): MainCall {
  return MAIN_CALL_BUILDERS[kind](request);
}

/**
 * Response parsers for the worker->main direction, for the same reason the other direction has them: the pending table is keyed by call id and cannot carry each entry's response type.
 */
export const MAIN_CALL_RESPONSE_PARSERS: {
  readonly [K in MainCallKind]: (value: unknown) => MainCallResponse<K> | null;
} = {
  "main/write-command": (value) => {
    if (!isRecord(value)) return null;
    if (value.ok === true) {
      return typeof value.hostId === "string"
        ? { ok: true, hostId: value.hostId }
        : null;
    }
    if (value.ok !== false) return null;
    const failure = parseCommandSendFailure(value.failure);
    return failure === null ? null : { ok: false, failure };
  },
  "main/lane-unary": (value) => {
    if (!isRecord(value)) return null;
    if (value.ok === false) {
      return typeof value.reason === "string"
        ? { ok: false, reason: value.reason }
        : null;
    }
    if (value.ok !== true) return null;
    if (value.kind === "retry-migration") return { ok: true, kind: value.kind };
    if (value.kind !== "workspace-context") return null;
    // The Protocol's own schema, not a hand-rolled walk of it.
    const parsed = earlyMetaEpicSchema.safeParse(value.context);
    return parsed.success
      ? { ok: true, kind: "workspace-context", context: parsed.data }
      : null;
  },
};

/** Narrows the classifier's verdict without asserting. */
function parseCommandSendFailure(value: unknown): CommandSendFailure | null {
  if (!isRecord(value)) return null;
  if (value.kind === "queued") {
    // `null` is a legal value and a missing field is not.
    const retryAfterMs: unknown = value.retryAfterMs;
    return typeof value.reason === "string" &&
      typeof value.boundedRetry === "boolean" &&
      (retryAfterMs === null || typeof retryAfterMs === "number")
      ? {
          kind: "queued",
          reason: value.reason,
          boundedRetry: value.boundedRetry,
          retryAfterMs,
        }
      : null;
  }
  if (value.kind === "unknown-outcome") {
    return typeof value.reason === "string"
      ? { kind: "unknown-outcome", reason: value.reason }
      : null;
  }
  if (value.kind !== "rejected") return null;
  const resolution = parseCommandResolution(value.resolution);
  return resolution === null ? null : { kind: "rejected", resolution };
}

/**
 * Narrows a command resolution, arm by arm.
 * Three arms, all plain data - checked at source rather than assumed, because `rejected` is the one that would have carried a live object across if the authority's answer had ever been wrapped.
 */
function parseCommandResolution(value: unknown): CommandResolution | null {
  if (!isRecord(value)) return null;
  if (value.kind === "committed") {
    const { hostId, entityVersion } = value;
    if (typeof hostId !== "string") return null;
    if (entityVersion !== null && typeof entityVersion !== "number")
      return null;
    return { kind: "committed", hostId, entityVersion };
  }
  if (value.kind === "rejected") {
    const { code, reason, retryable } = value;
    return typeof code === "string" &&
      typeof reason === "string" &&
      typeof retryable === "boolean"
      ? { kind: "rejected", code, reason, retryable }
      : null;
  }
  if (value.kind !== "superseded") return null;
  const { observedAtMs, via } = value;
  return typeof observedAtMs === "number" && typeof via === "string"
    ? { kind: "superseded", observedAtMs, via }
    : null;
}

export type RuntimeWorkerCallKind = keyof RuntimeWorkerCallMap;

/**
 * The main->worker call vocabulary, as values.
 * The same job {@link MAIN_TO_WORKER_EVENT_KINDS} does for events, and it did not exist until a call was added without the version moving.
 */
const RUNTIME_WORKER_CALL_COVERAGE: {
  readonly [K in RuntimeWorkerCallKind]: true;
} = {
  "attachment/read": true,
  "body/materialize": true,
  "body/release": true,
  "body/demote": true,
  "body/update": true,
  "mutation/apply": true,
  "command/enqueue": true,
  "root/encode": true,
  "root/apply": true,
  "attachment/await": true,
  "attachment/cancel": true,
};

export const RUNTIME_WORKER_CALL_KINDS: readonly RuntimeWorkerCallKind[] =
  Object.keys(RUNTIME_WORKER_CALL_COVERAGE).filter(
    (key): key is RuntimeWorkerCallKind =>
      Object.hasOwn(RUNTIME_WORKER_CALL_COVERAGE, key),
  );

export type RuntimeWorkerCallRequest<K extends RuntimeWorkerCallKind> =
  RuntimeWorkerCallMap[K]["request"];

export type RuntimeWorkerCallResponse<K extends RuntimeWorkerCallKind> =
  RuntimeWorkerCallMap[K]["response"];

  /**
   * A call as it travels, indexed by kind.
   * Named rather than inlined into the union below, because the name is what makes the union Constructible from generic code.
   */
export type RuntimeWorkerCallByKind = {
  readonly [K in RuntimeWorkerCallKind]: {
    readonly kind: K;
    readonly request: RuntimeWorkerCallRequest<K>;
  };
};

/**
 * A call as it travels: the kind and its request, in one clonable value.
 * Distributed over the map's keys so `kind` and `request` stay correlated inside the union - a frame naming `"attachment/read"` cannot carry `body/demote`'s request.
 */
export type RuntimeWorkerCall = RuntimeWorkerCallByKind[RuntimeWorkerCallKind];

/**
 * Per-kind envelope constructors.
 * One line per call rather than one generic builder, and the repetition is the safety.
 */
const CALL_BUILDERS: {
  readonly [K in RuntimeWorkerCallKind]: (
    request: RuntimeWorkerCallRequest<K>,
  ) => RuntimeWorkerCallByKind[K];
} = {
  "attachment/read": (request) => ({ kind: "attachment/read", request }),
  "body/materialize": (request) => ({ kind: "body/materialize", request }),
  "body/release": (request) => ({ kind: "body/release", request }),
  "body/demote": (request) => ({ kind: "body/demote", request }),
  "body/update": (request) => ({ kind: "body/update", request }),
  "mutation/apply": (request) => ({ kind: "mutation/apply", request }),
  "command/enqueue": (request) => ({ kind: "command/enqueue", request }),
  "root/encode": (request) => ({ kind: "root/encode", request }),
  "root/apply": (request) => ({ kind: "root/apply", request }),
  "attachment/await": (request) => ({ kind: "attachment/await", request }),
  "attachment/cancel": (request) => ({
    kind: "attachment/cancel",
    request,
  }),
};

export function buildRuntimeWorkerCall<K extends RuntimeWorkerCallKind>(
  kind: K,
  request: RuntimeWorkerCallRequest<K>,
): RuntimeWorkerCall {
  return CALL_BUILDERS[kind](request);
}

/**
 * A call's outcome.
 * `Error` does not survive structured clone with its prototype, so a rejection crosses as its name and message and is rebuilt on the other side.
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
  /** The main thread answering the worker's one call. */
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
       * The worker Asking the main thread.
       * Its own frame tag rather than reusing `"call"`, so a reader of either union never has to work out which direction a `call` frame was travelling.
       */
      readonly frame: "main-call";
      readonly callId: number;
      readonly call: MainCall;
    };

    /**
     * Narrows a structured-clone payload to a frame this side understands.
     * A frame that fails the check is dropped rather than thrown on: a throw inside a `message` listener becomes an unhandled error with no route back to whoever is waiting.
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
 * These exist so the endpoint can hand a caller of `call("attachment/read", …)` a value of that call's response type without an assertion anywhere.
 */
export const CALL_RESPONSE_PARSERS: {
  readonly [K in RuntimeWorkerCallKind]: (
    value: unknown,
  ) => RuntimeWorkerCallResponse<K> | null;
} = {
  "attachment/await": (value) => {
    if (!isRecord(value)) return null;
    if (value.bytes === null) return { bytes: null };
    return isUint8Array(value.bytes) ? { bytes: value.bytes } : null;
  },
  "attachment/cancel": (value) => {
    if (!isRecord(value)) return null;
    return typeof value.cancelled === "boolean"
      ? { cancelled: value.cancelled }
      : null;
  },
  "root/encode": (value) => {
    if (!isRecord(value)) return null;
    return isUint8Array(value.update) ? { update: value.update } : null;
  },
  "root/apply": (value) => {
    if (!isRecord(value)) return null;
    return typeof value.applied === "boolean"
      ? { applied: value.applied }
      : null;
  },
  "command/enqueue": (value) => {
    if (!isRecord(value)) return null;
    if (value.outcome === "refused") return { outcome: "refused" };
    if (value.outcome !== "enqueued") return null;
    return typeof value.commandId === "string"
      ? { outcome: "enqueued", commandId: value.commandId }
      : null;
  },
  "mutation/apply": (value) => {
    if (!isRecord(value)) return null;
    const { kind, value: answer } = value;
    if (typeof kind !== "string" || !isRecord(answer)) return null;
    // Validated per kind against the Same map the types come from, so a response whose shape does not match its kind is rejected rather than handed on as a widened record.
    if (
      kind === "rename-artifact" ||
      kind === "delete-artifact" ||
      kind === "reparent-artifact"
    ) {
      return typeof answer.changed === "boolean"
        ? { kind, value: { changed: answer.changed } }
        : null;
    }
    if (
      kind === "begin-rename" ||
      kind === "begin-epic-title" ||
      kind === "begin-reparent"
    ) {
      const requestId = answer.requestId;
      if (requestId !== null && typeof requestId !== "string") return null;
      return { kind, value: { requestId } };
    }
    if (kind === "retire-pending") {
      return typeof answer.retired === "boolean"
        ? { kind, value: { retired: answer.retired } }
        : null;
    }
    if (kind === "is-latest-rename-stamp") {
      return typeof answer.latest === "boolean"
        ? { kind, value: { latest: answer.latest } }
        : null;
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
    const {
      docKey,
      update,
      docGuid,
      seedMode,
      hostStateVector,
      awarenessFrames,
    } = value;
    if (docKey !== null && typeof docKey !== "string") return null;
    if (update !== null && !isUint8Array(update)) return null;
    if (docGuid !== null && typeof docGuid !== "string") return null;
    if (seedMode !== "full" && seedMode !== "delta-against-offer") return null;
    if (hostStateVector !== null && typeof hostStateVector !== "string") {
      return null;
    }
    // Narrowed element-wise: a frame array whose members are not bytes would
    // reach `applyAwarenessUpdate` and throw inside a decoder, far from here.
    if (!Array.isArray(awarenessFrames)) return null;
    const frames: Uint8Array[] = [];
    for (const frame of awarenessFrames) {
      if (!isUint8Array(frame)) return null;
      frames.push(frame);
    }
    return {
      docKey,
      update,
      docGuid,
      seedMode,
      hostStateVector,
      awarenessFrames: frames,
    };
  },
  "body/release": (value) => {
    if (!isRecord(value)) return null;
    const { released, reason } = value;
    if (typeof released !== "boolean") return null;
    // Same closed set as the demote's, narrowed the same way and for the same
    // reason: a verdict this side cannot read is not one to act on.
    if (
      reason !== null &&
      reason !== "not-held" &&
      reason !== "newer-generation" &&
      reason !== "pinned"
    ) {
      return null;
    }
    return { released, reason };
  },
  "body/demote": (value) => {
    if (!isRecord(value)) return null;
    const { accepted, settledBytes, reason } = value;
    if (typeof accepted !== "boolean") return null;
    if (typeof settledBytes !== "number") return null;
    // Narrowed, not passed through: the reason is a closed set, and a foreign string reaching a reader that switches on it would be a silent default rather than a refusal.
    // An unrecognised value is Refused here, because a demote answer whose verdict we cannot read is not one to act on.
    if (
      reason !== null &&
      reason !== "not-held" &&
      reason !== "newer-generation" &&
      reason !== "pinned"
    ) {
      return null;
    }
    return { accepted, settledBytes, reason };
  },
  "body/update": (value) => {
    if (!isRecord(value)) return null;
    const outcome = value.outcome;
    if (!isRecord(outcome)) return null;
    if (outcome.kind === "sent") return { outcome: { kind: "sent" } };
    if (outcome.kind !== "queued" && outcome.kind !== "dropped") return null;
    // The reason is load-bearing on both non-sent arms - it is what makes a `queued` legible and a `dropped` actionable - so a reasonless outcome is a foreign payload, not a defaulted one.
    return typeof outcome.reason === "string"
      ? { outcome: { kind: outcome.kind, reason: outcome.reason } }
      : null;
  },
};

/**
 * Realm-independent `Uint8Array` test.
 * `instanceof` is the obvious spelling and it is wrong here, because it asks "was this built by MY realm's constructor" rather than "is this a byte array".
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
