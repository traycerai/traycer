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
 *   - CALLS travel ONE way: the main thread asks the worker for what the
 *     replica knows. The worker asks the main thread for NOTHING, and that is
 *     DERIVED rather than assumed - it was assumed once, and wrongly.
 *
 *     Two worker->main calls lived here (`main/auth-revalidate`,
 *     `main/mint-credential`) because the plan was to move the SOCKET into the
 *     worker, which would have needed the app-wide single-flights the socket
 *     depends on. That plan was withdrawn: `buildHostStreamClient`'s remote
 *     branch reaches a module-scoped process-wide `RemoteSession` cache, so a
 *     worker importing it opens a second Noise session and relay socket per
 *     (hostId, userId) - and mobile is remote-only. The transport stays on
 *     main and the worker holds an `IStreamClient` PROXY over this bridge
 *     instead; see `stream-proxy-protocol.ts`.
 *
 *     Every member of that proxy is an event or a push, because every
 *     worker->main member of `IStreamClient` / `IStreamSession` returns `void`
 *     and the two returning a session return one the worker builds itself. The
 *     count is therefore zero, and machinery for a direction with no members is
 *     deleted rather than kept behind a pin asserting nothing travels on it.
 *     A worker->main CALL must not reappear without a paragraph here naming the
 *     synchronous main-thread-only fact that forced it.
 *
 * Payloads are structured-clone values only. Nothing here may carry a live
 * `Y.Doc`, an `Awareness`, a function, or a class instance - a `DataCloneError`
 * from `postMessage` surfaces at the boundary with no indication of which field
 * caused it.
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
 *
 * Both sides ship in one bundle graph, so a mismatch is not a fleet problem -
 * it is a stale chunk surviving a dev HMR reload, which otherwise presents as
 * a worker that connects and then quietly ignores half its traffic. The
 * handshake turns that into one loud error at startup.
 *
 * **12** since `main/lane-unary` and the first production emitter of
 * `stream/manifest`. The two moved together because they are the lane arm's
 * two halves: the manifest is what lets a worker SELECT the lanes at all, and
 * the unary is what the lane arm needs once selected. A v11 worker never
 * receives a manifest, so it reads every method's support as `"unknown"`
 * forever and holds the fail-closed legacy arm for its whole life - an epic
 * that works, on the arm this cutover exists to retire, with no symptom. A v11
 * MAIN answers `unserved` to the call, so a v12 worker's workspace context
 * never arrives and its migration retry never reaches a host. Both are the
 * quiet-degradation failure this constant exists to make loud.
 *
 * **11** since the body plane's RETURN leg: `body/doc-in`,
 * `body/awareness-out`, `body/awareness-in` and `body/release`. A v10 worker
 * pushes no collaborator edits and no presence, so an epic looks alive and
 * edits one-way - the failure a version check exists to make loud - and it
 * has no handler for a forward-only release, so every `@1` body it ever
 * materializes is held for the life of the session on both sides.
 *
 * **10** since `attachment/await` / `attachment/cancel`: the WAITING half of
 * the attachment class, which `attachment/read` alone could not serve without
 * turning "still replicating" into "missing". One bump for the pair - they
 * land together, so a peer is either before both or after both.
 *
 * **9** since `root/encode` / `root/apply`: the root-state transfer the merge
 * sites depend on. A v8 worker answers `unserved`, so a session replacement
 * silently transfers nothing - the failure the `applied` boolean exists to
 * make impossible.
 *
 * **8** since `command/enqueue`: the write-command queue's enqueue crossed as a
 * call, because the queue mints the id and refuses from its own state. A v7
 * worker answers `unserved`, so every write is refused at the call site - loud
 * rather than silent, but every write.
 *
 * **7** since `runtime/command`: the fifteen fire-and-forget members the store
 * used to call directly on the runtime. A v6 worker hits its own `assertNever`
 * on the first one, which is loud - but only because the event union is
 * exhaustively switched; the version is what stops a v6 worker being adopted
 * at all.
 *
 * **6** since `mutation/apply`: the main thread asks the replica to perform
 * metadata mutations and to stamp its optimistic overlay. A v5 worker has no
 * handler for the call and answers `unserved`, so every rename, delete and
 * reparent silently does nothing while the UI shows its optimistic result -
 * the worst arm of this failure mode, because it looks like it worked.
 *
 * **5** since the accounting vocabulary: the worker reports its bytes rather
 * than reaching a process accountant it would have COPIED, so a v4 worker
 * pushes no settlements and a v4 main answers no demote request. Both sides
 * would run - and the books would silently hold nothing for that runtime,
 * which is the failure mode that has no symptom until a plane never evicts.
 *
 * **4** since the body payloads carry `docGuid`: a v3 worker materializes
 * without an identity and a v3 demote cannot be refused on one, so the two
 * sides disagree about when a body may be replaced.
 *
 * **3** was the composition root: `current-user` was added and the
 * worker->main call direction returned with one member. A v2 worker hits its
 * own `assertNever` on the first `current-user` push.
 *
 * **2** was the stream proxy. v1's vocabulary was gone, not extended:
 * the bearer and endpoint pushes, the bearer probe call and the `main-call` /
 * `main-result` frames were removed and the `stream/*` events added. A v1
 * worker and a v2 spawner share no traffic worth the name.
 *
 * This number did NOT move when that vocabulary was replaced, and the comment
 * above was already describing the exact failure it then permitted: both sides
 * read `1`, the handshake matched, the stale worker answered `ready` and was
 * adopted, and it ignored every stream frame it was sent - which is
 * indistinguishable from a runtime that is merely slow. A version constant
 * that does not move with its contract is not a check; it is a comment that
 * looks like one.
 */
export const RUNTIME_BRIDGE_PROTOCOL_VERSION = 12;

/**
 * The runtime facts main's books read between settlements.
 *
 * Three of {@link EpicRuntimeAccountingSource}'s four members are pure reads,
 * and after relocation they are read SYNCHRONOUSLY by an accountant on main
 * while their answers live in the worker. This snapshot is how that is possible
 * at all: every settlement carries the current values, so main's cache is never
 * more than one push stale, and the accountant's synchronous questions are
 * answered from it rather than from a call that cannot exist.
 *
 * `projectionCounts` is `unknown` here for the same reason `projection.value`
 * is: its shape belongs to the gui-app budget module, and a copy of that
 * contract in this file would rot against it. The composition root narrows it,
 * exactly as it does a projection slice.
 */
export interface RuntimeAccountingSnapshot {
  readonly materializedRoomIds: readonly string[];
  readonly rootBytes: number;
  /**
   * The tier's LAST KNOWN protected breakdown, and the reason this member
   * exists rather than being defaulted to empty on main.
   *
   * A deferred eviction answers `reclaimedBytes: 0`, which is also what "there
   * was nothing to free" answers. The breakdown is the only thing that
   * distinguishes them, and reporting an empty one would tell the accountant a
   * plane is unprotected at the exact moment it is entirely pinned.
   */
  readonly protectedBytesByKind: readonly ProtectedBytes[];
  readonly projectionCounts: unknown;
}

/**
 * One settlement, in the runtime's own vocabulary.
 *
 * A nested union rather than six top-level event kinds, so the mapping to
 * `EpicRuntimeAccountingPort`'s six reporting members stays one-to-one and a
 * member added there fails to compile here - while the event vocabulary itself
 * grows by two rather than by eight.
 */
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
 *
 * Deliberately scalar, and deliberately minimal. `hostId`/`userId` rode here
 * while the plan was to move the socket; with the transport on main nothing in
 * the worker read either, and a field nobody reads is the design-by-accident
 * this bridge keeps deleting. The rule that replaced them is the one `epicId`
 * and `hostId` below satisfy: a field returns WITH a reader, named at the
 * field.
 *
 * `hostId` is back under exactly that rule; its reader is named at the field.
 * `userId` remains absent and remains without a reader.
 */
export interface RuntimeWorkerBootstrap {
  readonly protocolVersion: number;
  /**
   * The epic this worker serves, for its whole life.
   *
   * Back, WITH a reader - which is the condition this doc comment set when
   * `hostId`/`userId` were removed. The reader is the composition root: it
   * cannot construct a runtime without an epic id, and the id cannot arrive
   * later because the composition is what every subsequent frame is answered
   * by. One worker serves one epic, so this is a constant of the worker rather
   * than a parameter of its traffic.
   */
  readonly epicId: string;
  /**
   * The host this session is bound to, for its whole life.
   *
   * Back, WITH a reader, under the condition this interface's doc set when
   * `hostId` was removed. **The reader is the write-command send gate**:
   * `epic-replica-runtime.ts`'s queue reads `writeCommandSender.currentHostId()`
   * and refuses with `EpicWriteCommandTransportUnavailableError` when it is
   * null, BEFORE calling `send`. While the worker had no host id it answered
   * null unconditionally, so every write command a worker-hosted runtime
   * enqueued stalled in `queued` forever - rename, delete, reparent, epic
   * title, all of them. That is the reader, and it is why the field is not
   * optional.
   *
   * It is also the attribution key: the queue records
   * `attemptedHostByCommandId` from this value, which is what a retry reads to
   * know where the previous attempt went.
   *
   * A BOOTSTRAP fact rather than a per-call parameter because it is a session
   * constant - a tab is bound to its `hostId` for life, and cross-host
   * continuation is clone-not-migrate, so a worker never serves two hosts.
   */
  readonly hostId: string;
  /**
   * Identifies this renderer window in log lines the worker emits.
   *
   * Per-window, because the worker is per-window: a user with three windows
   * open on one epic has three workers, three durable stores, and three sets
   * of log lines that are otherwise indistinguishable.
   */
  readonly windowLabel: string;
}

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
  | { readonly kind: "stream/frame"; readonly frame: StreamProxyFrame }
  | {
      /**
       * The per-session negotiated version, pushed BEFORE the status transition
       * it belongs to. A push and not a call because the worker's read
       * (`getNegotiatedSchemaVersion`) is synchronous.
       */
      readonly kind: "stream/session-version";
      readonly version: StreamProxySessionVersion;
    }
  | { readonly kind: "stream/status"; readonly status: StreamProxyStatus }
  | {
      /**
       * Client-wide versions, per-method support, and the doc arm - one event
       * because all three are read off the same negotiated manifest and move on
       * the same edge.
       */
      readonly kind: "stream/manifest";
      readonly manifest: StreamProxyManifest;
    }
  | {
      /**
       * The signed-in user, as the auth store sees it right now.
       *
       * Its OWN event, not a field on `stream/manifest`, and the rule is one
       * event per PRODUCER: the manifest's producer is the transport, this
       * one's is `useAuthStore`. Folding them together would make a
       * re-negotiation republish auth state and an identity change republish
       * method support - two unrelated edges each pretending to be the other.
       *
       * `null` is a real state (nobody signed in), read live because a session
       * constructed before the profile hydrates must pick the id up on its next
       * projection rather than freezing the absence.
       */
      readonly kind: "current-user";
      readonly userId: string | null;
    }
  | {
      /**
       * A local presence frame for one artifact body, on its way to the arm.
       *
       * An EVENT, not a call: presence is fire-and-forget and self-corrects on
       * the next frame, so a dropped one costs a stale cursor rather than
       * data. An unknown `docKey` is dropped silently at the far end for the
       * same reason - there is no answer a sender could act on.
       */
      readonly kind: "body/awareness-out";
      readonly docKey: string;
      readonly frame: Uint8Array;
      /**
       * The `clientID` of the main-side `Awareness` this frame speaks for.
       *
       * Carried explicitly rather than decoded from `frame` at the far end:
       * the receiving room has to EXCLUDE this identity from "is a remote peer
       * present", which is a materialisation pin, and a pin that depends on
       * parsing an opaque payload fails open - it would hold the room hot
       * forever. See `ArtifactRoomReplicaEntry.relayedLocalClientId`.
       */
      readonly localClientId: number;
    }
  | {
      /**
       * One fire-and-forget command for the relocated runtime.
       *
       * See {@link RuntimeCommandMap} for why this is one kind rather than
       * fifteen, and for the FIFO-ordering invariant that makes it safe.
       */
      readonly kind: "runtime/command";
      readonly command: RuntimeCommand;
    }
  | {
      /**
       * Free `overBytes` from the hot-doc tier, which lives in the worker.
       *
       * The one INBOUND half of the accounting seam, and the only one of
       * `EpicRuntimeAccountingSource`'s four members that is not a pure read:
       * it performs the eviction. The accountant calls it synchronously during
       * a reconcile, so main's proxy answers `reclaimedBytes: 0` with the last
       * known protected breakdown and dispatches this; what was actually
       * freed arrives as the settlements that follow, and the next reconcile
       * sees them. A deferral, not a refusal - the two are distinguished by
       * the breakdown, and the accountant counts them apart.
       */
      readonly kind: "accounting/demote";
      readonly overBytes: number;
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
       * Open one subscription. The `streamId` is the WORKER's, which is what
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
       *
       * Distinct from a logged `error`: a fatal says the runtime behind this
       * bridge is gone, so the main thread must surface it rather than let the
       * UI wait forever on projections that will never arrive. Reduced to
       * strings for the same reason `RuntimeWorkerLogEntry.error` is.
       */
      readonly kind: "fatal";
      readonly message: string;
      readonly stack: string | null;
    }
  | {
      /**
       * A collaborator's edit, for the live body doc MAIN holds.
       *
       * The return leg of the body plane, and the one whose absence made
       * collaborative editing one-way: the tier applies a remote update
       * worker-side, and without this nothing carries it to the doc the editor
       * is actually bound to.
       *
       * Pushed only for a docKey main is known to hold. Main stamps these with
       * the same module-private origin it stamps an install with, so its own
       * observer does not forward a collaborator's edit straight back out -
       * the echo loop's second entrance.
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
      /**
       * The runtime's books came up, or went away.
       *
       * Separate from the settlements because registration is what makes main
       * ATTACH this runtime to the process planes, and attaching on the first
       * settlement instead would leave a runtime that has settled nothing
       * invisible to the books - which is exactly a freshly opened epic.
       *
       * `snapshot` is `null` on deregistration: there is no runtime left to
       * describe, and carrying the last one's numbers would let a reconcile
       * racing the teardown read facts about a runtime that is gone.
       */
      readonly kind: "accounting/books";
      readonly registered: boolean;
      readonly snapshot: RuntimeAccountingSnapshot | null;
    }
  | {
      /**
       * One settled byte fact, plus the reads main's accountant needs.
       *
       * The snapshot rides EVERY settlement rather than being its own event on
       * a timer: the accountant's questions are synchronous, so the only way to
       * answer them from main is to have the answer already, and the cheapest
       * moment to refresh it is the one where the runtime already knows it has
       * changed.
       */
      readonly kind: "accounting/settle";
      readonly settlement: RuntimeAccountingSettlement;
      readonly snapshot: RuntimeAccountingSnapshot;
    };

/**
 * The fire-and-forget commands the main thread issues to the relocated runtime.
 *
 * ONE inbound event kind carries all of them, the same collapse `mutation/apply`
 * makes for calls: +1 top-level kind instead of +15. There is no response map
 * because there are no responses - every member of this vocabulary is a
 * runtime member that already returned `void`, and the projection stream is
 * the feedback plane. The handler table alone carries exhaustiveness: a kind
 * added here without a handler fails to compile.
 *
 * **These are fire-and-forget, but they are NOT unordered, and that is the
 * invariant to protect.** A record apply racing an edit would reorder a user's
 * view of their own data - the record plane and the doc plane both feed one
 * projector, and the projector's output is what the UI reads. What preserves
 * the order is that they all ride ONE `postMessage` channel, which is FIFO
 * per channel. A second channel added "for the hot path" would silently break
 * this, and nothing in the types would say so; if one is ever added, these
 * commands must stay together on whichever channel also carries the frames
 * they interleave with.
 *
 * **Membership is checked per member, at mint time, not by bucket.** Five
 * runtime members that LOOK like they belong here do not:
 * `start` (the worker's own composition root calls `runtime.start()` after
 * `installCore`), `dispose` (`shutdown`), `detachTransport` (the spawner's
 * `detach()`, which reports every session closed and lets the adapters run
 * their own close handling), and `applyLocalUpdate` / `sendAwareness`, which
 * have ZERO production callers on either side of the boundary - minting them
 * would be dead wire with a test-only reader.
 */
export interface RuntimeCommandMap {
  "apply-chat-records": {
    readonly records: readonly ChatRecordSummaryV11[];
    readonly issuedAtSeq: number | null;
  };
  "apply-chat-record-delta": { readonly delta: ChatRecordDelta };
  "apply-tui-agent-records": {
    readonly records: readonly TuiAgentRecordSummaryV12[];
    readonly issuedAtSeq: number | null;
  };
  "apply-tui-agent-record-delta": { readonly delta: TuiAgentRecordDelta };
  "mark-chat-records-authoritative": Record<string, never>;
  "mark-chat-records-not-authoritative": Record<string, never>;
  /**
   * `pending` is `unknown` for the same reason `projectionCounts` and the
   * manifest's `docArm` are: `PendingChatCreation` belongs to gui-app, and a
   * copy of it here would rot against the original. The composition root
   * narrows it.
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
   * End the TRANSPORT while the replica lives on - the retained-dirty /
   * window-repoint path.
   *
   * A COMMAND, and re-derived rather than assumed after `body/release` taught
   * that "no answer needed" is worth checking: the worker's member is void and
   * refusal-free (it guards on `disposed` / already-detached and returns
   * silently), and everything main must learn flows back through the
   * PROJECTION - `control.noteTransportDetached()` publishes the sync state
   * the UI renders. A response would be a second, weaker copy of a channel
   * that already exists.
   *
   * Ordering rides the pipe: commands apply in arrival order relative to
   * calls, so a later `root/encode` - the window-repoint read - observes the
   * detached, quiesced state. Idempotent at the far end, which is the worker's
   * own latch rather than bookkeeping added for this.
   */
  "detach-transport": Record<string, never>;
}

export type RuntimeCommandKind = keyof RuntimeCommandMap;
export type RuntimeCommandPayload<K extends RuntimeCommandKind> =
  RuntimeCommandMap[K];

/** One command, discriminated - what rides `runtime/command`. */
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
 *
 * ONE call kind (`mutation/apply`) carries all of them, for the same reason the
 * accounting settlements are one nested union rather than six events: the
 * top-level vocabulary stays small while the per-member typing stays exact.
 *
 * The exactness is not decoration. `EpicMutationResponse<K>` resolves through
 * this map, and the worker's handler table is
 * `{ [K in EpicMutationKind]: (request) => response }` - so a kind added here
 * WITHOUT its `response` half fails to compile at that table rather than
 * shipping with a widened or defaulted answer. That is the whole point of
 * declaring request and response together instead of as two unions that happen
 * to have matching arms.
 *
 * Why these eight and not the four doc writes alone: the optimistic overlay
 * (`begin-*`, `retire-pending`, `is-latest-rename-stamp`) is the projector's
 * FOLD INPUT - read at projection time, inside the worker - so it cannot move
 * to main without moving the projector with it. None of its members is read
 * during render, so crossing them is a call-shape change and nothing more.
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

/** One mutation, discriminated - what crosses as the call request. */
export type EpicMutation = {
  [K in EpicMutationKind]: {
    readonly kind: K;
    readonly request: EpicMutationRequest<K>;
  };
}[EpicMutationKind];

/**
 * One answer, carrying its kind back.
 *
 * The kind rides the response so a CALLER can narrow with a literal check
 * rather than an assertion: `result.kind === "begin-rename"` gives it
 * `{ requestId: string | null }` and nothing wider.
 */
export type EpicMutationResult = {
  [K in EpicMutationKind]: {
    readonly kind: K;
    readonly value: EpicMutationResponse<K>;
  };
}[EpicMutationKind];

/**
 * The "nothing happened" answer for any mutation kind.
 *
 * ONE source, because four places need it and they must agree: the host before
 * a core is installed, the core after it stops serving, the in-process port
 * that serves body calls only, and the stub handlers. Four hand-written
 * switches over the same union is four places for a new kind to be given a
 * DIFFERENT default, and the dangerous default is the optimistic one - a
 * `changed: true` from a replica that did nothing lets the caller's follow-on
 * view write run against a mutation that never happened.
 *
 * Every arm fails closed: nothing changed, nothing stamped, nothing retired,
 * no stamp is the latest.
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

/**
 * The event vocabulary, as values.
 *
 * Derived from mapped coverage records so a member added to either union fails
 * to compile here, exactly as `MainCallKind` was. Their PURPOSE is different
 * though: these exist so that changing the vocabulary reddens a test sitting
 * next to {@link RUNTIME_BRIDGE_PROTOCOL_VERSION}, because the version failing
 * to move with the vocabulary is a defect nothing else can see - both sides
 * read the same number, the handshake matches, and a stale worker is adopted
 * and then ignores half its traffic.
 */
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
 * The stream-proxy family of worker->main events, as ONE type.
 *
 * These five are the only members `stream-proxy-host` serves, and the only
 * ones `worker-stream-client` produces. Naming the family is what lets both
 * ends declare it instead of taking the whole union and sorting at runtime -
 * and taking the whole union is how the gap below opened.
 */
export type StreamProxyWorkerEvent = Extract<
  WorkerToMainEvent,
  { kind: `stream/${string}` }
>;

/**
 * Recognises the family, ONE definition for every consumer.
 *
 * It lives here rather than beside either end because both ends need it and a
 * second copy is the "two lists, one checked" shape: main peeling by prefix
 * while the host switched on five labels meant the two could disagree with
 * nothing to catch it.
 *
 * Why a prefix test rather than a membership check against a coverage record:
 * the family is defined BY the prefix at type level ({@link
 * StreamProxyWorkerEvent} is a template-literal `Extract`), so the runtime test
 * and the type-level one are the same rule stated twice in the same place. A
 * new `stream/*` member joins both at once - and now, unlike before, it also
 * fails to compile in the host's exhaustive switch until it is handled.
 */
export function isStreamProxyEvent(
  event: WorkerToMainEvent,
): event is StreamProxyWorkerEvent {
  return event.kind.startsWith("stream/");
}

/**
 * Every call the main thread may issue, paired with its answer.
 *
 * One map rather than two parallel unions so a request and its response cannot
 * drift: `call("attachment/read", ...)` is typed by construction, and adding a
 * member without its response arm does not compile.
 */
export interface RuntimeWorkerCallMap {
  /**
   * Attachment bytes, WAITING for a hash that has not replicated yet.
   *
   * The other half of the attachment class, and not a flag on
   * `attachment/read`: `lib/epic-replica-reads.ts`'s header says outright that
   * the two "look like one function with a flag and they are not - collapsing
   * them is a regression one way and a hang the other". Guarding the waiting
   * leg turns "still replicating" into "missing" for exactly the images the
   * design expects to be late; dropping the guard on the other parks the chat
   * chain forever.
   *
   * `awaitId` is the CALLER's, minted per read, because the wait has to be
   * cancellable and a call in flight has no other name. Without cancellation
   * this is the indefinite park that `attachment/read` was fixed to avoid - a
   * call slot held for the life of the worker.
   */
  "attachment/await": {
    request: { readonly awaitId: number; readonly hash: string };
    /** `null` when cancelled or when the runtime tore down. */
    response: { readonly bytes: Uint8Array | null };
  };
  /**
   * Stop waiting. The pending `attachment/await` settles `null`.
   *
   * Its own CALL rather than a `runtime/command` push, and the difference is
   * delivery: a dropped push leaves the worker holding a wait forever, which
   * is the exact leak this pair exists to prevent, while a call has an answer
   * that says it arrived. `cancelled: false` for an id that was never pending
   * or has already settled - that race is inherent (bytes can land while the
   * cancel is in flight) and is a no-op, not a fault.
   */
  "attachment/cancel": {
    request: { readonly awaitId: number };
    response: { readonly cancelled: boolean };
  };

  /**
   * The root replica's encoded state, for a transfer into another session.
   *
   * The two callers are the merge sites - the provider's replacement path and
   * the registry's transfer - and both read from one session and apply into
   * another. Post-relocation that is one worker's doc going to a different
   * one, so the bytes have to cross main to get there.
   */
  "root/encode": {
    request: Record<string, never>;
    response: { readonly update: Uint8Array };
  };
  /**
   * Take a root state in.
   *
   * `applied` is a CALL's answer and not a push's silence because it is a
   * data-loss guard: `INERT_ROOT_STATE_PORT`'s own comment says a fixture
   * claiming `true` "would let a retention decision retire the only copy of a
   * document". The caller uses it to decide whether the source's edits are
   * safely in the replacement.
   *
   * `asLocalEdit` is load-bearing: it decides whether the applied update is
   * attributed to this client (and so re-sent) or treated as remote.
   */
  "root/apply": {
    request: {
      readonly update: Uint8Array;
      readonly asLocalEdit: boolean;
    };
    response: { readonly applied: boolean };
  };

  /**
   * Enqueue one epic write command on the runtime's queue.
   *
   * A CALL and not a `runtime/command` push, because the caller needs two
   * answers the worker alone can give: the queue MINTS the id
   * (`CommandQueue.enqueue` - "Mints an id, records the command as pending"),
   * and it REFUSES from queue state the main thread does not hold. Pushing an
   * intent and minting an id on main would hand back an id for a command the
   * queue may have refused, and the caller's `waitForWriteCommand` would then
   * watch the projection for a record that never arrives.
   *
   * Its own kind rather than a `mutation/apply` member: write commands ride the
   * host-command queue, the metadata mutations ride the records doc. Two
   * planes, two vocabularies.
   *
   * `intent` is `unknown` for the same reason `main/write-command`'s is - it is
   * the caller's clonable wire form, and the worker carries it opaquely.
   */
  "command/enqueue": {
    request: { readonly intent: unknown };
    /**
     * The refusal is its OWN arm, not a nullable id. A bare `string | null`
     * makes "refused" and "something went wrong" the same value at the call
     * site, and this is the one place where telling them apart decides whether
     * the caller waits forever.
     */
    response:
      | { readonly outcome: "enqueued"; readonly commandId: string }
      | { readonly outcome: "refused" };
  };

  /**
   * One metadata mutation, applied by the replica.
   *
   * A single member carrying {@link EpicMutation} rather than eight members,
   * so the call vocabulary does not grow by eight for one relocation. The
   * per-kind typing lives in {@link EpicMutationMap}, and callers narrow on the
   * `kind` the answer carries back.
   */
  "mutation/apply": {
    request: EpicMutation;
    response: EpicMutationResult;
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
      /**
       * The document identity these bytes were cut at, or `null` on the
       * not-held arm - which has no document to identify.
       *
       * Rides the response so a later demote can be REFUSED when the body was
       * replaced in between: a deleted-and-recreated body arrives under the
       * same artifact id with a new guid and a history sharing no ancestor,
       * and merging the two is unrecoverable rather than lossy. `generation`
       * beside it answers a different question - the bridge's own ordering -
       * and the demote arm refuses on either.
       */
      readonly docGuid: string | null;
      readonly seedMode: ArtifactBodySeedMode;
      /**
       * The host watermark the bytes were encoded against, base64, or `null`
       * for the named not-established state. Never a defaulted `""` - T12
       * ruled that a null watermark is a state with its own meaning.
       */
      readonly hostStateVector: string | null;
      /**
       * The room's currently-known REMOTE peers, for main's fresh `Awareness`.
       *
       * Rides the RESPONSE rather than arriving as a `body/awareness-in` push,
       * and that is an ordering fact rather than a preference. `Awareness`
       * notifies on change, so an observer attached to a room that already has
       * peers hears nothing until one of them next moves - up to a heartbeat
       * of looking alone in a room that is not empty. But the observer is
       * attached INSIDE this handler, so a push from there would reach main
       * before `install` created the `Awareness` to receive it and be dropped
       * as an unknown docKey. Carried here, main installs the doc and applies
       * presence in the same step.
       *
       * Empty on the not-held arm, and empty for a room with no peers - both
       * are "nothing to replay" and neither is an error.
       */
      readonly awarenessFrames: readonly Uint8Array[];
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
  /**
   * Let go of a FORWARD-ONLY body: the worker releases its retained hold.
   *
   * The counterpart to `body/demote`, and deliberately a different shape
   * rather than a flag on it. `body/demote` NAMES an identity and settles
   * bytes back; a forward-only body has neither, and routing it through that
   * call would be refused on the identity it cannot supply - which is why it
   * was skipped, and why its memory then leaked.
   *
   * A body has exactly ONE of the two lifecycles, decided by whether its seed
   * stated an identity: identity-named bodies settle, forward-only bodies
   * release. Neither handler may touch the other's state.
   *
   * **A CALL, not an event, and the ordering argument had to be redone.** As
   * an event its justification was `postMessage` FIFO - "a release can never
   * overtake its replacement". That argument does not transfer as written:
   * the worker dispatches calls with `void serve(...)`, so handlers are
   * INVOKED in arrival order but an async one's continuation can interleave
   * with a later handler. What makes this safe is causal rather than
   * positional: main posts a release only for a docKey whose `body/materialize`
   * has already RESOLVED - the grant it releases comes from that resolution -
   * so a release can never overtake the materialize that created the hold it
   * names. The release handler is synchronous at the worker, so once invoked
   * it completes without interleaving at all.
   *
   * It answers because the tier can REFUSE it. A forward-only body still has
   * pins that live in tier state (local divergence, remote presence), and with
   * no settle to be refused this is the only channel they have; the reason
   * vocabulary is shared with `body/demote` so "the tier says no" has one
   * shape.
   */
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
       * WHY a demote was refused. `null` when it was accepted.
       *
       * Main's behaviour is the same for every refusal - keep the live doc,
       * re-arm the window - so this does not branch anything today. It crosses
       * because the reasons are not interchangeable to a READER: `pinned` says
       * the room is still in use and will settle later, `newer-generation`
       * says these bytes belong to a body that has been replaced, and
       * `not-held` says the worker has nothing to settle into. A demote
       * refused for identity where you expected pinned is a real bug, and
       * without this it is indistinguishable at the seam.
       */
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
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
 * The calls the WORKER may issue to the main thread. TWO, and the count is the
 * contract - see the header's rule.
 *
 * This doc used to describe `main/auth-revalidate` and `main/mint-credential`,
 * which were deleted with the socket-relocation plan. It survived them, which
 * is worth naming rather than quietly fixing: a member list in prose does not
 * fail to compile when its members go, so the file's own introduction to this
 * interface named two calls neither of which existed, while the member below
 * correctly said the count was one. Prose describing a set is stale the moment
 * the set moves, and this one had been stale since the deletion.
 *
 * Both surviving members are unaries on the MAIN-THREAD REQUESTER, and that is
 * the single fact that forces the direction for both: the unary messenger
 * shares the same module-scoped process-wide `RemoteSession` cache the stream
 * client does, so a worker copy is a second Noise session and relay socket per
 * (hostId, userId) - the identical fact that kept the socket on main. Every
 * other member of the composition root's options is a value, a push or an
 * event; these two are the only "ask, and act on the answer" shapes, which has
 * no push or event spelling.
 *
 * MAIN OWNS THE ERROR in both, for one reason: an `Error` does not survive
 * structured clone. So main catches, reduces the failure to a clonable value,
 * and the worker acts on that - never on a thrown object it would have to
 * reconstruct.
 */
export interface MainCallMap {
  /**
   * Send one epic write command through the main thread's unary requester.
   *
   * The ONE worker->main call, and the count is the contract. Every other
   * member of the composition root's options is a value, a push or an event;
   * this one is not, and the difference is structural rather than stylistic:
   * `send` is async, its RETURN VALUE is consumed (`{ hostId }`), and its
   * typed throws are classified into a verdict the command queue acts on.
   * There is no push or event spelling of "ask, and act on the answer".
   *
   * Why the requester cannot simply move, which is the question the earlier
   * two calls got wrong: the unary messenger shares the same module-scoped
   * process-wide `RemoteSession` the stream client does, so a worker copy is a
   * second Noise session and relay socket per (hostId, userId) - the identical
   * fact that kept the socket on main. See `stream-proxy-protocol.ts`.
   *
   * MAIN CLASSIFIES; the wire carries the verdict. An `Error` does not survive
   * structured clone, so the worker must never see one: main runs the real
   * send, catches, applies `classifyEpicWriteCommandFailure`, and returns the
   * classifier's own union. The worker's `send` re-throws it as a carrier and
   * its `classifyFailure` unwraps it, which leaves the SHARED
   * `CommandQueueOptions` contract untouched.
   *
   * A FURTHER worker->main call must not appear without a paragraph like this
   * one, and `MAIN_CALL_KINDS` pins the count at 2.
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
   * The two unary reads that complete the epic LANE surface -
   * `epic.getWorkspaceContext@1.0` and `epic.retryMigration@1.0` - issued on
   * the main thread's requester.
   *
   * The paragraph this member owes, and it starts with why they are here at
   * all. Both are on `hostRpcRegistry`, not the stream registry: they are
   * unaries, so they ride the main-thread messenger, and the messenger reaches
   * the same process-wide `RemoteSession` cache as the socket. That is the
   * whole justification, and it is the same one `main/write-command` gives -
   * these are not a new kind of coupling, they are two more members of the one
   * class this bridge already carries.
   *
   * Why they cannot be pushes. The workspace context IS a payload the runtime
   * consumes (it is `earlyMeta`, which the legacy arm receives as a frame and
   * projects into `snapshotMeta`), so there is nothing to push. The retry is a
   * COMMAND whose whole reason for becoming a unary was that the monolith's
   * fire-and-forget client frame made "the host refused" and "the host never
   * received it" the same observation - so spelling it as a bridge EVENT here
   * would reintroduce, one layer over, the exact defect the protocol change
   * removed.
   *
   * ONE kind carrying both rather than two kinds, because they are one class
   * and move as one: `lane-unaries.ts` defines them together, the registry
   * degrades them together (`degrade: { kind: "unsupported" }`, both off the
   * released floor), and both are unreachable on the legacy arm. A caller that
   * has one has the other.
   *
   * Neither is on the hot path: the context is read at open and on named
   * refresh triggers, and the retry is a user gesture on a failed migration.
   * Neither is reached while frames are flowing, which is what keeps this from
   * re-creating the stall the relocation removes.
   */
  readonly "main/lane-unary": {
    readonly request: LaneUnaryRequest;
    readonly response: LaneUnaryOutcome;
  };
}

/**
 * Which lane unary to issue.
 *
 * No `epicId`: the SESSION owns it, exactly as it does for
 * `main/write-command`, so main's handler supplies it rather than trusting a
 * value that crossed a boundary. A worker naming an epic would be a worker
 * able to name the WRONG one.
 */
export type LaneUnaryRequest =
  | { readonly kind: "workspace-context" }
  | { readonly kind: "retry-migration" };

/**
 * What main answers a lane unary with.
 *
 * `ok: false` carries a `reason` STRING rather than a classified union,
 * and the asymmetry with `WriteCommandOutcome` is deliberate rather than an
 * omission. A write command's failure drives a queue that retries, defers or
 * rejects, so its arms are load-bearing and are reconstructed field by field.
 * These two have no queue: a failed context read is retried by the refresh
 * policy's next trigger and is otherwise a log line, and a failed retry is a
 * log line too. Inventing arms nothing branches on would be a contract that
 * looks richer than the behaviour behind it.
 *
 * The success arm is DISCRIMINATED because one parser serves both kinds - the
 * pending table is keyed by call id and cannot carry each entry's response
 * type - so `{ ok: true }` alone could not tell a context answer from a retry
 * acknowledgement.
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
 *
 * `failure` is `CommandSendFailure` - the CONTRACT's own type, imported rather
 * than restated. It has THREE arms, not two: `queued` (carrying
 * `boundedRetry`), `unknown-outcome`, and `rejected` (carrying a
 * `CommandResolution`). A response typed `"queued" | "dropped"` would drop
 * `unknown-outcome` - the arm that exists precisely so an ambiguous keyed
 * attempt is NOT retried blindly - and would flatten `rejected`, which carries
 * the authority's own code and reason.
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
 * The worker->main call kinds, DERIVED from the record so there is one place a
 * member can be added - and that place fails to compile when incomplete.
 *
 * A hand-written array beside a coverage record is two lists and only one is
 * checked: TypeScript cannot verify an array's ELEMENTS exhaust a union, so a
 * second member added to the map and the record but not the array leaves the
 * count pin green while the union has grown.
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
 * Response parsers for the worker->main direction, for the same reason the
 * other direction has them: the pending table is keyed by call id and cannot
 * carry each entry's response type.
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
    // The PROTOCOL's own schema, not a hand-rolled walk of it. The two other
    // parsers in this file rebuild their payloads field by field because those
    // payloads are the bridge's own vocabulary and have no schema anywhere
    // else; this one's does exist, is the same schema the legacy `earlyMeta`
    // frame is decoded with, and carries five nested collections. A second
    // hand-written narrowing of it here would be a copy that rots against the
    // contract - silently, by admitting a shape the host stopped sending.
    const parsed = earlyMetaEpicSchema.safeParse(value.context);
    return parsed.success
      ? { ok: true, kind: "workspace-context", context: parsed.data }
      : null;
  },
};

/**
 * Narrows the classifier's verdict without asserting.
 *
 * Rebuilt arm by arm, and the verbosity is the check: `boundedRetry` decides
 * whether a queued command may wait offline without a deadline, and a payload
 * that merely CLAIMED `queued` while missing it would reach the queue as a
 * command with no retry policy at all.
 */
function parseCommandSendFailure(value: unknown): CommandSendFailure | null {
  if (!isRecord(value)) return null;
  if (value.kind === "queued") {
    return typeof value.reason === "string" &&
      typeof value.boundedRetry === "boolean"
      ? {
          kind: "queued",
          reason: value.reason,
          boundedRetry: value.boundedRetry,
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
 *
 * Three arms, all plain data - checked at source rather than assumed, because
 * `rejected` is the one that would have carried a live object across if the
 * authority's answer had ever been wrapped.
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
 *
 * The same job {@link MAIN_TO_WORKER_EVENT_KINDS} does for events, and it did
 * not exist until a call was added without the version moving. Events were
 * coupled to the version and calls were not, so `mutation/apply` could have
 * shipped against a stale worker that answers `ready` and then `unserved` for
 * every mutation - which presents as renames that silently do nothing.
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
 * inside the union - a frame naming `"attachment/read"` cannot carry
 * `body/demote`'s request.
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
      /** The main thread ANSWERING the worker's one call. */
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
       * The worker ASKING the main thread. Exactly ONE kind - see
       * {@link MainCallMap}. Its own frame tag rather than reusing `"call"`, so
       * a reader of either union never has to work out which direction a `call`
       * frame was travelling.
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
    // Validated per kind against the SAME map the types come from, so a
    // response whose shape does not match its kind is rejected rather than
    // handed on as a widened record. The three answer shapes are the three
    // this vocabulary has; a fourth arrives with its own line.
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
    // NARROWED, not passed through: the reason is a closed set, and a foreign
    // string reaching a reader that switches on it would be a silent default
    // rather than a refusal. An unrecognised value is REFUSED here, because a
    // demote answer whose verdict we cannot read is not one to act on.
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
