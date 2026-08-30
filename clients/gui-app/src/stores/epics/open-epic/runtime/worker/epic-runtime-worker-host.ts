/**
 * What runs inside the runtime worker.
 *
 * Everything except the two lines that reach for the ambient worker scope,
 * which live in `epic-runtime-worker-entry.ts`. The split is what makes this
 * testable: the suites drive THIS against a real bridge endpoint over a fake
 * port pair, so the frames, the correlation, the stream proxy and the
 * lifecycle are all the production ones - only the pipe is a stand-in.
 *
 * The composition root itself (stream clients, lane and legacy adapters, root
 * replica, projection kernel, cold tier, durable store) is not here yet. It
 * arrives through {@link EpicRuntimeWorkerHost.installCore}, which is the one
 * named seam that phase adds. Until something installs a core, the host is a
 * fully working bridge over an empty runtime: it records the bootstrap's facts,
 * it forwards logs, and it answers the reads it can answer - `{ bytes: null }`
 * for an attachment, which is the honest "not available from here" every
 * surviving caller already handles, and not a throw.
 *
 * The two things a core needs from OUTSIDE the worker are reachable here before
 * it exists: `bootstrapFacts()` (the window it serves), and `streams` -
 * the `IStreamClient` proxy the four typed wrappers are constructed over. The
 * socket behind it never leaves the main thread.
 */
import {
  createWorkerBridgeEndpoint,
  type BridgeTransport,
  type MainThreadPort,
  type RuntimeWorkerCallHandlers,
  type WorkerBridgeEndpoint,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  inertMutationResult,
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  type ArtifactBodySeedMode,
  type EpicMutation,
  type EpicMutationResult,
  type RuntimeCommand,
  type RuntimeWorkerCallResponse,
  type MainToWorkerEvent,
  type RuntimeWorkerBootstrap,
  type RuntimeWorkerLogEntry,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import {
  NO_TRANSFER,
  takeBytesForTransfer,
} from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import {
  createWorkerStreamClient,
  type WorkerStreamClientHandle,
} from "@traycer-clients/shared/replica-runtime/worker/worker-stream-client";
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime/runtime-environment";
import { createWorkerRuntimeEnvironment } from "../worker-runtime-environment";
import { createWorkerAccountingPort } from "./worker-accounting-port";
import type { EpicRuntimeAccountingPort } from "../epic-runtime-accounting-port";

/**
 * The relocated composition root, as the bridge sees it.
 *
 * Deliberately tiny and deliberately not the runtime's own interface: what the
 * bridge needs is the set of operations a MAIN-THREAD caller can ask for, and
 * that set is much smaller than the runtime's surface because everything else
 * the runtime does travels outward as events.
 */
/** What the queue answered: a minted id, or an explicit refusal. */
export type EnqueuedWriteCommand = RuntimeWorkerCallResponse<"command/enqueue">;

export interface EpicRuntimeWorkerCore {
  /**
   * Content-addressed attachment bytes from the root replica, or `null` when
   * this replica does not hold the hash.
   *
   * Returns the bytes; the host owns handing over the buffer. A core that
   * returned a view into a live decode buffer would otherwise have that buffer
   * transferred out from under it.
   */
  readAttachmentBytes(hash: string): Promise<Uint8Array | null>;
  /**
   * The cold bytes for an artifact body, or `null` when this replica cannot
   * serve one. The live `Y.Doc` is built from these on the MAIN thread, which
   * is where Tiptap needs it.
   */
  materializeBody(
    artifactId: string,
  ): Promise<ArtifactBodyMaterialization | null>;
  /**
   * Take an artifact body's encoded state back and settle it.
   *
   * Answers only once the bytes are durably held: the main thread keeps the
   * live doc until this resolves, so an early `accepted: true` is a window in
   * which an edit exists nowhere. `accepted: false` tells the main thread to
   * keep the doc.
   */
  demoteBody(input: {
    readonly docKey: string;
    readonly generation: number;
    /** What the caller materialized at; a moved identity is refused. */
    readonly docGuid: string;
    readonly update: Uint8Array;
  }): Promise<{
    readonly accepted: boolean;
    readonly settledBytes: number;
    /** WHY, when refused. `null` when accepted. Shared with `body/release`. */
    readonly reason: "not-held" | "newer-generation" | "pinned" | null;
  }>;
  /**
   * A local edit from the main-thread doc, on its way to the body lane.
   *
   * Answers the lane's own `SendOutcome` unchanged - `queued` is not a failure
   * and must not be retried; only `dropped` is loss.
   */
  updateBody(input: {
    readonly docKey: string;
    readonly update: Uint8Array;
  }): Promise<{ readonly outcome: SendOutcome }>;
  /**
   * One metadata mutation against the replica and its optimistic overlay.
   *
   * Async like the rest of this interface even though the replica answers
   * synchronously: the caller is across a bridge either way, and a synchronous
   * member here would be a promise the host has to make on the replica's
   * behalf that the bridge cannot keep.
   *
   * MAY THROW. `reparent-artifact` rejects an illegal move by throwing, and
   * the endpoint turns that into an `error` result carrying the error's own
   * `name` - which is how the caller still tells a cycle from a missing node.
   */
  applyMutation(mutation: EpicMutation): Promise<EpicMutationResult>;
  /**
   * One fire-and-forget command. `void` on both sides of the boundary: the
   * caller already expected `void`, and the projection stream is the feedback.
   */
  applyCommand(command: RuntimeCommand): void;
  /** Relay a local presence frame for one body to the arm's mechanism. */
  applyBodyAwareness(
    docKey: string,
    frame: Uint8Array,
    localClientId: number,
  ): void;
  /**
   * Let go of a forward-only body. Settles nothing; see `body/release`.
   */
  releaseBody(docKey: string): {
    readonly released: boolean;
    readonly reason: "not-held" | "newer-generation" | "pinned" | null;
  };
  /** The retained body holds. The lifetime leak's only honest observable. */
  heldBodyDocKeysForTests(): readonly string[];
  /**
   * Enqueue one write command. The QUEUE mints the id and may refuse from its
   * own state, which is why this is a call and not a push.
   */
  enqueueWriteCommand(intent: unknown): Promise<EnqueuedWriteCommand>;
  /** The root replica's encoded state, for a transfer into another session. */
  /**
   * Wait for attachment bytes. Settles `null` on cancel or teardown, never on
   * a timeout - "resolves when they land" is the contract.
   */
  awaitAttachmentBytes(
    awaitId: number,
    hash: string,
  ): Promise<Uint8Array | null>;
  /** Stop a wait. `false` when the id was never pending or has settled. */
  cancelAttachmentAwait(awaitId: number): boolean;
  encodeRootState(): Promise<Uint8Array>;
  /** Take a root state in. `applied` is a data-loss guard, never optimistic. */
  applyRootUpdate(update: Uint8Array, asLocalEdit: boolean): Promise<boolean>;
  dispose(): void;
}

export interface ArtifactBodyMaterialization {
  readonly docKey: string;
  readonly update: Uint8Array;
  /**
   * The identity these bytes were cut at, or `null` when the arm states none.
   *
   * `null` is the `@1` arm's truth carried forward, never a value invented
   * here - `artifact-room-tier.ts:325` forbids fabricating one. A `null` guid
   * marks the body FORWARD-ONLY: the lease bridge installs it and never posts
   * a demote for it, because `settleColdState` decides its refusal on an
   * identity and would refuse these bytes anyway.
   */
  readonly docGuid: string | null;
  readonly seedMode: ArtifactBodySeedMode;
  readonly hostStateVector: string | null;
  /** The room's known remote peers. See the protocol field for the ordering. */
  readonly awarenessFrames: readonly Uint8Array[];
}

export interface EpicRuntimeWorkerHost {
  /**
   * The environment every relocated module is constructed with. Available
   * before a core is installed, because building the core needs it.
   */
  readonly environment: RuntimeEnvironment;
  /**
   * The stream client the relocated composition root is built on: a PROXY whose
   * frames cross the bridge while the real socket, its process-wide session
   * cache, its wake and endpoint re-dial wiring and its credential recovery all
   * stay on the main thread. See `stream-proxy-protocol.ts` for why.
   */
  readonly streams: WorkerStreamClientHandle;
  /**
   * What the main thread told this worker about the surface it serves, or
   * `null` before the bootstrap arrives.
   *
   * A read rather than a constructor argument because the host is started by
   * the entry module, which has nothing to tell it - the facts arrive on the
   * wire. The core builder is what waits for them.
   */
  bootstrapFacts(): RuntimeWorkerBootstrap | null;
  /**
   * The signed-in user, replicated from main. Its own push, because its
   * producer is `useAuthStore` and not the transport.
   */
  currentUserId(): string | null;
  /**
   * The worker->main call surface, for the composed runtime's write commands.
   *
   * Narrow by construction: `MainThreadPort` is `call` and nothing else, so a
   * composition cannot reach `emit` and publish a second projection stream
   * beside the one {@link publishProjection} owns.
   */
  readonly main: MainThreadPort;
  /**
   * Publish one projection slice to main.
   *
   * The revision is the HOST's, minted here and strictly increasing per
   * worker, because the main side drops a revision it has already applied. A
   * caller minting its own would be a second sequence over one stream, and two
   * sequences interleave into an order that drops deliveries as stale.
   */
  publishProjection(value: unknown): void;
  /** Push a resident body's update to main's live doc (`body/doc-in`). */
  publishBodyDocUpdate(docKey: string, update: Uint8Array): void;
  /** Push a remote presence frame for one body (`body/awareness-in`). */
  publishBodyAwareness(docKey: string, frame: Uint8Array): void;
  /**
   * Runs `listener` when the bootstrap lands, BEFORE `ready` is emitted.
   *
   * The composition root cannot be built at construction: it needs the epic id,
   * and that arrives on the wire. Running before `ready` is the whole point -
   * `ready` is what makes the main thread start sending calls, so a core
   * installed after it would leave a window in which the worker answers
   * "not held" to reads the runtime could have served. A listener that throws
   * fails the handshake into a `fatal`, which is the honest outcome for a
   * composition that could not be built.
   *
   * Returns an unsubscribe, and does not fire for a SKEWED bootstrap: a
   * version-mismatched worker must compose nothing.
   */
  onBootstrap(listener: (facts: RuntimeWorkerBootstrap) => void): () => void;
  /**
   * Where the composed runtime reports its bytes.
   *
   * Available before a core is installed, for the same reason `environment` is:
   * building the core needs it. Pushes over the bridge - the books themselves
   * are on main, because a worker importing them would COPY the accountant
   * rather than share it.
   */
  readonly accounting: EpicRuntimeAccountingPort;
  /**
   * Installs the relocated composition root. Called once, by the phase that
   * moves it; a second call replaces the core and disposes the previous one.
   */
  installCore(core: EpicRuntimeWorkerCore): void;
  /** Idempotent. Disposes the core, if any, and stops answering. */
  shutdown(): void;
}

export function startEpicRuntimeWorkerHost(
  transport: BridgeTransport,
): EpicRuntimeWorkerHost {
  let core: EpicRuntimeWorkerCore | null = null;
  let bootstrap: RuntimeWorkerBootstrap | null = null;
  // `null` is a real state - nobody signed in - and it is also what this reads
  // before the first push. Both mean the same thing to the projector, which
  // hides chats owned by a different user and shows none while unknown.
  let currentUserId: string | null = null;
  let stopped = false;
  const bootstrapListeners = new Set<(facts: RuntimeWorkerBootstrap) => void>();
  let projectionRevision = 0;

  /**
   * Answer a release. Split out so the handler can stay a one-liner that is
   * obviously synchronous under its promise - releasing touches two maps and
   * never awaits, which is what makes the ordering argument on `body/release`
   * hold: once invoked it completes without interleaving.
   */
  function releaseBodyReply(request: { readonly docKey: string }): {
    value: {
      readonly released: boolean;
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    };
    transfer: readonly ArrayBuffer[];
  } {
    // No core: nothing to release, and `not-held` says so honestly. The hold
    // is created BY a materialize this same core answered, so a release
    // arriving without one names nothing that exists.
    if (core === null) {
      return {
        value: { released: false, reason: "not-held" },
        transfer: NO_TRANSFER,
      };
    }
    return { value: core.releaseBody(request.docKey), transfer: NO_TRANSFER };
  }

  const handlers: RuntimeWorkerCallHandlers = {
    "attachment/read": async (request) => {
      const held =
        core === null ? null : await core.readAttachmentBytes(request.hash);
      if (held === null)
        return { value: { bytes: null }, transfer: NO_TRANSFER };
      // Transfer, never share - and never the raw view, which may be a window
      // onto a buffer the replica is still using.
      const prepared = takeBytesForTransfer(held);
      return {
        value: { bytes: prepared.bytes },
        transfer: prepared.transfer,
      };
    },
    "body/materialize": async (request) => {
      const held =
        core === null ? null : await core.materializeBody(request.artifactId);
      if (held === null) {
        // No core, or no body for that artifact. Both reach the main thread as
        // an `unavailable` grant, which is what a lease with nothing behind it
        // has always been.
        return {
          value: {
            docKey: null,
            update: null,
            docGuid: null,
            seedMode: "full",
            hostStateVector: null,
            // Nothing held, so nobody to be present in it.
            awarenessFrames: [],
          },
          transfer: NO_TRANSFER,
        };
      }
      const prepared = takeBytesForTransfer(held.update);
      return {
        value: {
          docKey: held.docKey,
          update: prepared.bytes,
          docGuid: held.docGuid,
          seedMode: held.seedMode,
          hostStateVector: held.hostStateVector,
          awarenessFrames: held.awarenessFrames,
        },
        transfer: prepared.transfer,
      };
    },
    "body/update": async (request) => {
      if (core === null) {
        // No core: the body lane this update was destined for does not exist
        // here. `dropped` rather than `queued` because nothing in this worker
        // is holding it - the main thread's live doc is, and the edit reaches
        // the host on the next materialize/demote cycle. The reason names the
        // state so a caller can tell a teardown drop from a lane refusing a
        // doc it should have had.
        return {
          value: {
            outcome: {
              kind: "dropped",
              reason: "runtime worker holds no replica",
            },
          },
          transfer: NO_TRANSFER,
        };
      }
      return {
        value: await core.updateBody(request),
        transfer: NO_TRANSFER,
      };
    },
    "attachment/await": async (request) => {
      // `null` without a core, immediately: there is no replica to wait on, and
      // a wait that never settles is the park this pair exists to avoid.
      const bytes =
        core === null
          ? null
          : await core.awaitAttachmentBytes(request.awaitId, request.hash);
      if (bytes === null)
        return { value: { bytes: null }, transfer: NO_TRANSFER };
      const encoded = takeBytesForTransfer(bytes);
      return { value: { bytes: encoded.bytes }, transfer: encoded.transfer };
    },
    "attachment/cancel": (request) => {
      const cancelled =
        core === null ? false : core.cancelAttachmentAwait(request.awaitId);
      return Promise.resolve({ value: { cancelled }, transfer: NO_TRANSFER });
    },
    "root/encode": async () => {
      // Empty bytes without a core, and the caller's `applied` guard is what
      // makes that safe: an empty update applies as nothing rather than as a
      // document, and the transfer site checks the answer before retiring the
      // source.
      const update =
        core === null ? new Uint8Array() : await core.encodeRootState();
      const encoded = takeBytesForTransfer(update);
      return { value: { update: encoded.bytes }, transfer: encoded.transfer };
    },
    "root/apply": async (request) => {
      // FALSE without a core. A `true` here would tell a retention decision
      // the edits are safely in the replacement when nothing received them.
      const applied =
        core === null
          ? false
          : await core.applyRootUpdate(request.update, request.asLocalEdit);
      return { value: { applied }, transfer: NO_TRANSFER };
    },
    "command/enqueue": async (request) => {
      // REFUSED without a core, never a minted id: an id handed back for a
      // command nothing queued is a caller waiting on a record that will never
      // arrive.
      const answer =
        core === null
          ? ({ outcome: "refused" } as const)
          : await core.enqueueWriteCommand(request.intent);
      return { value: answer, transfer: NO_TRANSFER };
    },
    "mutation/apply": async (request) => {
      if (core === null) {
        // Fail-closed, and each arm says the same thing three ways: nothing
        // happened. A no-core `changed: true` would let the caller's follow-on
        // view write run against a mutation the replica never made.
        return { value: inertMutationResult(request), transfer: NO_TRANSFER };
      }
      return {
        value: await core.applyMutation(request),
        transfer: NO_TRANSFER,
      };
    },
    "body/release": (request) => Promise.resolve(releaseBodyReply(request)),
    "body/demote": async (request) => {
      // Refusing is the only safe answer without a core: the main thread keeps
      // the live doc on `accepted: false`, and an unowned `true` would tell it
      // to drop bytes nothing has stored.
      const settled =
        core === null
          ? { accepted: false, settledBytes: 0, reason: "not-held" as const }
          : await core.demoteBody(request);
      return { value: settled, transfer: NO_TRANSFER };
    },
  };

  // Built before the environment, so the log sink can close over a `const`
  // bridge rather than a slot that is null until construction finishes -
  // a log line emitted while the core is being built would otherwise vanish.
  const bridge: WorkerBridgeEndpoint = createWorkerBridgeEndpoint(
    transport,
    handlers,
  );
  const emitLog = (entry: RuntimeWorkerLogEntry): void => {
    bridge.emit({ kind: "log", entry }, NO_TRANSFER);
  };
  // After the bridge for the same reason the log sink is: its emit closes over
  // a `const`, so a frame produced while the core is being built cannot vanish
  // into a slot that is still null.
  const streams = createWorkerStreamClient(
    (event, transfer) => {
      bridge.emit(event, transfer);
    },
    (reason) => {
      // Surfaced, never swallowed: a frame dropped on the hot path reads as a
      // host that went quiet, and this is where a stale chunk arrives.
      emitLog({
        level: "error",
        message: `[epic-runtime-worker] ${reason}`,
        fields: {},
        error: null,
      });
    },
  );
  const environment = createWorkerRuntimeEnvironment(emitLog);
  // After the bridge, like the log sink and the stream client, and for the
  // same reason: its emit closes over a `const`.
  const accounting = createWorkerAccountingPort((event) => {
    bridge.emit(event, NO_TRANSFER);
  });

  const onEvent = (event: MainToWorkerEvent): void => {
    if (stopped) return;
    switch (event.kind) {
      case "bootstrap": {
        if (
          event.bootstrap.protocolVersion !== RUNTIME_BRIDGE_PROTOCOL_VERSION
        ) {
          // Loud, and NOT followed by `ready`. A version-skewed worker that
          // answered `ready` would be adopted by the main thread and then
          // ignore half the traffic it was sent, which reads as a runtime that
          // is merely slow.
          bridge.emit(
            {
              kind: "fatal",
              message: `Runtime worker bridge protocol mismatch: main thread speaks ${String(
                event.bootstrap.protocolVersion,
              )}, worker speaks ${String(RUNTIME_BRIDGE_PROTOCOL_VERSION)}`,
              stack: null,
            },
            NO_TRANSFER,
          );
          return;
        }
        // Recorded only on a MATCHING handshake. A skewed bootstrap's payload
        // is exactly the thing that must not be trusted: storing it and then
        // answering `fatal` would leave the core builder able to construct
        // against facts the two sides do not agree on.
        bootstrap = event.bootstrap;
        // Composition BEFORE `ready`. A throw here propagates to the listener
        // wrapper's catch and becomes a `fatal` with no `ready` - main then
        // rejects its handshake instead of adopting a worker whose runtime
        // does not exist.
        for (const listener of [...bootstrapListeners])
          listener(event.bootstrap);
        bridge.emit(
          { kind: "ready", protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION },
          NO_TRANSFER,
        );
        return;
      }
      case "stream/frame": {
        streams.deliverFrame(event.frame);
        return;
      }
      case "stream/session-version": {
        // Applied before the status it belongs to, which is the order main
        // posts them in - so a handler reacting to `open` already reads the
        // version negotiated for that open.
        streams.deliverSessionVersion(
          event.version.streamId,
          event.version.version,
        );
        return;
      }
      case "stream/status": {
        streams.deliverStatus(
          event.status.streamId,
          event.status.status,
          event.status.reason,
        );
        return;
      }
      case "stream/manifest": {
        streams.deliverManifest(event.manifest);
        return;
      }
      case "current-user": {
        currentUserId = event.userId;
        return;
      }
      case "body/awareness-out": {
        // Dropped without a core, like every other body member: there is no
        // arm to relay presence to, and a frame is self-correcting.
        core?.applyBodyAwareness(
          event.docKey,
          event.frame,
          event.localClientId,
        );
        return;
      }
      case "runtime/command": {
        // Dropped when no core is installed, and that is the honest answer
        // rather than a queue: these commands are driven by main-side state
        // that will re-drive them (an auth change, a record push, a user
        // gesture), and a queue replayed after `installCore` would apply a
        // viewer's records to a session that has since changed viewer.
        core?.applyCommand(event.command);
        return;
      }
      case "accounting/demote": {
        accounting.demote(event.overBytes);
        return;
      }
      case "shutdown": {
        shutdown();
        return;
      }
      default:
        assertNever(event);
    }
  };

  const unsubscribe = bridge.onEvent((event) => {
    try {
      onEvent(event);
    } catch (cause: unknown) {
      // A throw inside a message listener is otherwise an unhandled error with
      // no route back to the main thread, which then waits on a runtime that
      // has already failed.
      bridge.emit(
        {
          kind: "fatal",
          message:
            cause instanceof Error
              ? cause.message
              : "Runtime worker event failed",
          stack:
            cause instanceof Error && cause.stack !== undefined
              ? cause.stack
              : null,
        },
        NO_TRANSFER,
      );
    }
  });

  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    const disposing = core;
    core = null;
    disposing?.dispose();
    // Before the bridge: the closes have to reach main, and a disposed bridge
    // drops what is posted through it. A session left open on the other side is
    // a live subscription carrying frames nothing reads.
    streams.disposeAll();
    bridge.dispose();
  }

  return {
    environment,
    streams,
    accounting: accounting.port,
    bootstrapFacts: () => bootstrap,
    main: bridge,
    publishBodyDocUpdate(docKey, update): void {
      if (stopped) return;
      const encoded = takeBytesForTransfer(update);
      bridge.emit(
        { kind: "body/doc-in", docKey, update: encoded.bytes },
        encoded.transfer,
      );
    },
    publishBodyAwareness(docKey, frame): void {
      if (stopped) return;
      const encoded = takeBytesForTransfer(frame);
      bridge.emit(
        { kind: "body/awareness-in", docKey, frame: encoded.bytes },
        encoded.transfer,
      );
    },
    publishProjection(value): void {
      if (stopped) return;
      projectionRevision += 1;
      bridge.emit(
        { kind: "projection", revision: projectionRevision, value },
        NO_TRANSFER,
      );
    },
    onBootstrap(listener): () => void {
      bootstrapListeners.add(listener);
      return () => bootstrapListeners.delete(listener);
    },
    currentUserId: () => currentUserId,
    installCore(next): void {
      const previous = core;
      core = next;
      previous?.dispose();
    },
    shutdown,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime worker event ${JSON.stringify(value)}`);
}
