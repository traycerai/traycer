/**
 * Starting the runtime worker from the main thread, and everything that has to be true the moment
 * it exists. Four jobs, in order, because each depends on the previous one:
 */
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createMainBridgeEndpoint,
  type MainCallHandlers,
  type RuntimeWorkerPort,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  createStreamProxyHost,
  type StreamProxyHost,
} from "@traycer-clients/shared/replica-runtime/worker/stream-proxy-host";
import {
  createRuntimeProjectionOrdering,
  type RuntimeProjectionHandlers,
} from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";
import {
  createMessageTargetTransport,
  type BridgeMessageTargetLike,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";
import {
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  type LaneUnaryOutcome,
  type LaneUnaryRequest,
  type WriteCommandOutcome,
  type RuntimeWorkerLogEntry,
  type RuntimeCommand,
  type WorkerToMainEvent,
  isStreamProxyEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { StreamMethodSupportSource } from "@traycer-clients/shared/host-transport/host-stream-client";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { EPIC_LANE_METHODS } from "@traycer-clients/shared/epic-lanes";
import { readEpicDocRecordArms } from "@/stores/epics/open-epic/doc-record-arms";
import {
  NO_TRANSFER,
  takeBytesForTransfer,
} from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import { createMainAccountingBridge } from "./main-accounting-bridge";
import type { EpicRuntimeAccountingPort } from "../epic-runtime-accounting-port";

/** The part of `Worker` this module uses. */
export interface RuntimeWorkerLike extends BridgeMessageTargetLike {
  terminate(): void;
  /**
   * Subscribes to the faults a worker reports as EVENTS rather than as bridge messages. A separate
   * member, and REQUIRED, because the bridge cannot carry this class of failure by construction.
   */
  onWorkerFault(listener: (message: string) => void): void;
}

/**
 * The CLOSED method set a replicated manifest names. The four stream methods an epic runtime can
 * open, and nothing else.
 */
const EPIC_MANIFEST_METHODS: readonly (keyof HostStreamRpcRegistry & string)[] =
  ["epic.subscribe", ...EPIC_LANE_METHODS];

/** Where a worker's log lines and its fatal go. */
export interface RuntimeWorkerLogRelay {
  log(entry: RuntimeWorkerLogEntry): void;
  fatal(message: string, stack: string | null): void;
}

/** Where the body plane's RETURN leg lands. */
export interface EpicRuntimeBodyReturnTarget {
  applyDocUpdate(docKey: string, update: Uint8Array): void;
  applyAwareness(docKey: string, frame: Uint8Array): void;
}

export interface SpawnEpicRuntimeWorkerOptions<TProjection> {
  readonly createWorker: () => RuntimeWorkerLike;
  /**
   * Where a worker's log lines and its fatal go. A fatal is NOT just another log line: the runtime
   * behind the bridge is gone, so a UI waiting on projections must be told rather than left waiting.
   */
  readonly relay: RuntimeWorkerLogRelay;
  /**
   * Sends one epic write command on this session's unary requester, and CLASSIFIES its failure here
   * on the main thread.
   */
  readonly writeCommand: (
    commandId: string,
    intent: unknown,
  ) => Promise<WriteCommandOutcome>;
  /**
   * Issues one lane unary on this session's requester, and reduces its failure to a clonable value
   * HERE, on the main thread - the same rule {@link writeCommand} states, for the same reason.
   */
  readonly laneUnary: (request: LaneUnaryRequest) => Promise<LaneUnaryOutcome>;
  /** This connection's negotiated per-method support, and a notification when it moves. */
  readonly methodSupport: StreamMethodSupportSource<HostStreamRpcRegistry>;
  /** The session's REAL stream client, which stays on this thread. */
  readonly streams: IStreamClient<HostStreamRpcRegistry>;
  /** Identifies this renderer window in the worker's log lines. */
  /**
   * What to do with published projection slices. Handlers rather than a raw callback, because the
   * spawner constructs the ONE reducer that orders them.
   */
  readonly projection: RuntimeProjectionHandlers<TProjection>;
  /** The process-backed books this worker's runtime reports into. */
  /**
   * A collaborator's edit and a remote presence frame, both for the live doc main holds. See {@link
   * EpicRuntimeBodyReturnTarget} for who provides it.
   */
  readonly body: EpicRuntimeBodyReturnTarget;
  readonly accounting: EpicRuntimeAccountingPort;
  /** The epic this worker serves for its whole life. */
  readonly epicId: string;
  /** The host this session is bound to, for its whole life. */
  readonly hostId: string;
  readonly windowLabel: string;
}

export interface EpicRuntimeWorkerHandle {
  /** The ask half of the bridge - `call` and nothing else. Deliberately NOT the endpoint. */
  readonly port: RuntimeWorkerPort;
  /**
   * Resolves when the worker has acknowledged the bootstrap, and rejects if it reported a protocol
   * mismatch instead.
   */
  readonly ready: Promise<void>;
  /**
   * Ends the TRANSPORT while the worker lives on - path 2 (`detachTransport`), where a
   * retained-dirty buffer must stop dialling a host this window has left but keeps its replica.
   */
  /** Send one fire-and-forget command to the relocated runtime. */
  command(command: RuntimeCommand): void;
  /** Send a local presence frame for one body. */
  awarenessOut(docKey: string, frame: Uint8Array, localClientId: number): void;
  /**
   * Tell the worker who is signed in. The worker's projector folds on `getCurrentUserId()`, which is
   * fed by this event and by nothing else - and until now NOTHING EMITTED IT.
   */
  currentUser(userId: string | null): void;
  detach(): void;
  /**
   * Idempotent. Detaches (so the worker observes every close), then asks the
   * worker to stop and terminates it. Paths 1, 3, 4 and 5.
   */
  dispose(): void;
}

export function spawnEpicRuntimeWorker<TProjection>(
  options: SpawnEpicRuntimeWorkerOptions<TProjection>,
): EpicRuntimeWorkerHandle {
  const worker = options.createWorker();
  // Built from what the caller holds. Both worker->main calls, answered by the
  // session's own requester - see `MainCallMap` for why they are calls.
  const mainCallHandlers: MainCallHandlers = {
    "main/write-command": (request) =>
      options.writeCommand(request.commandId, request.intent),
    "main/lane-unary": (request) => options.laneUnary(request),
  };
  const bridge = createMainBridgeEndpoint(
    createMessageTargetTransport(worker),
    mainCallHandlers,
  );
  // The proxy host owns the REAL sessions the worker opens. It is the object this side detaches, not
  // the socket.
  const buildProxy = (
    streams: IStreamClient<HostStreamRpcRegistry>,
  ): StreamProxyHost =>
    createStreamProxyHost(
      streams,
      (event, transfer) => {
        bridge.emit(event, transfer);
      },
      (reason) => {
        options.relay.log({
          level: "error",
          message: `[epic-runtime-worker] ${reason}`,
          fields: { windowLabel: options.windowLabel },
          error: null,
        });
      },
    );
  let proxy: StreamProxyHost | null = buildProxy(options.streams);

  let settleReady: (() => void) | null = null;
  let failReady: ((cause: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });
  // A caller may legitimately never await `ready` - a surface that only wants projections has
  // nothing to do about a slow handshake.
  void ready.catch(() => undefined);

  // The one reducer for this worker's projection stream, constructed here so
  // there can be no second one.
  const projections = createRuntimeProjectionOrdering(options.projection);

  // Turns the worker's byte pushes back into calls on the real books, and answers the accountant's
  // synchronous reads from the snapshot each push carries.
  const accounting = createMainAccountingBridge({
    port: options.accounting,
    dispatchDemote: (overBytes) => {
      bridge.emit({ kind: "accounting/demote", overBytes }, NO_TRANSFER);
    },
  });

  /**
   * The ONE way a dead runtime is surfaced, reached from both entries: the worker's own `fatal`
   * bridge event, and a fault the worker reports as a DOM event because no code of ours is running
   */
  /** Whether construction has reached the point where `disposeHandle` can run. */
  const fatalTeardown = { constructionComplete: false, deferred: false };

  const surfaceFatal = (message: string, stack: string | null): void => {
    // The runtime behind the bridge is gone, so its books must not stay attached to the process
    // planes.
    accounting.dispose();
    options.relay.fatal(message, stack);
    // A fatal before the handshake is the handshake's answer. After it, the promise has already
    // settled and this is a no-op - the relay is what surfaces a mid-life fatal.
    failReady?.(new Error(message));
    // AND RELEASE THE TRANSPORT.
    if (fatalTeardown.constructionComplete) {
      disposeHandle();
      return;
    }
    fatalTeardown.deferred = true;
  };

  // The failure the bridge cannot carry.
  worker.onWorkerFault((message) => {
    // No stack: this arrives as a DOM `ErrorEvent`, whose `error` is `null` for a module that never
    // evaluated, and the worker had no chance to build one of its own.
    surfaceFatal(message, null);
  });

  const unsubscribeEvents = bridge.onEvent((event: WorkerToMainEvent) => {
    // The stream-proxy family, recognised as ONE thing, and peeled here rather than given five labels
    // in the switch below: `complexity` counts case labels, and five sharing a one-line body pushed
    if (isStreamProxyEvent(event)) {
      // Every unknown id is dropped inside the host, silently and on purpose: a frame can be in flight
      // when a session closes, and a throw here is an unhandled error in a `message` listener with no
      proxy?.handle(event);
      return;
    }
    switch (event.kind) {
      case "ready":
        settleReady?.();
        return;
      case "log":
        options.relay.log(event.entry);
        return;
      case "projection":
        projections.deliver(event.revision, event.value);
        return;

      case "body/doc-in":
        // The return leg. Main stamps these with its own private origin on
        // apply, which is what stops its observer sending them straight back.
        options.body.applyDocUpdate(event.docKey, event.update);
        return;
      case "body/awareness-in":
        options.body.applyAwareness(event.docKey, event.frame);
        return;
      case "accounting/books":
      case "accounting/settle":
        accounting.handle(event);
        return;
      case "fatal":
        surfaceFatal(event.message, event.stack);
        return;
      default:
        assertNever(event);
    }
  });

  bridge.emit(
    {
      kind: "bootstrap",
      bootstrap: {
        protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION,
        epicId: options.epicId,
        hostId: options.hostId,
        windowLabel: options.windowLabel,
      },
    },
    NO_TRANSFER,
  );

  /** The negotiated manifest, replicated into the worker so it can SELECT an arm at all. */
  let disposed = false;

  function emitManifest(): void {
    if (disposed) return;
    bridge.emit(
      {
        kind: "stream/manifest",
        manifest: {
          methodVersions: EPIC_MANIFEST_METHODS.map((method) => ({
            method,
            version: options.streams.getMethodSchemaVersion(method),
          })),
          methodSupport: EPIC_MANIFEST_METHODS.map((method) => ({
            method,
            support: options.methodSupport.getMethodSupport(method),
          })),
          docArm: readEpicDocRecordArms(options.hostId),
        },
      },
      NO_TRANSFER,
    );
  }

  // ONCE before any change, because `subscribeMethodSupport` reports movement and not state: a
  // connection whose handshake resolved before this worker was spawned - a second tab on a warm
  emitManifest();
  const unsubscribeMethodSupport =
    options.methodSupport.subscribeMethodSupport(emitManifest);
  const unsubscribeNegotiatedManifests =
    subscribeNegotiatedManifests(emitManifest);

  function detach(): void {
    // The WORKER first, before main's proxy goes away.
    if (!disposed) {
      bridge.emit(
        {
          kind: "runtime/command",
          command: { kind: "detach-transport", payload: {} },
        },
        NO_TRANSFER,
      );
    }
    const detaching = proxy;
    proxy = null;
    // While the bridge is still LIVE and its events still routed.
    detaching?.dispose();
  }

  // A hoisted declaration rather than a method on the object below, because `surfaceFatal` calls it
  // and is defined earlier: the fatal path now releases the transport, not just the books.
  function disposeHandle(): void {
    if (disposed) return;
    disposed = true;
    // Detach FIRST, and through the same function the detach-only path uses - one copy of the
    // close-then-teardown ordering, because a second copy is what got it wrong the first time.
    detach();
    // Only then stop routing. Unsubscribing before the detach drops every
    // report even on a live bridge.
    unsubscribeEvents();
    // The transport outlives this worker on the retained-buffer path, so a manifest listener left
    // behind would emit onto a disposed bridge every time that connection re-handshakes.
    unsubscribeMethodSupport();
    unsubscribeNegotiatedManifests();
    // The worker will not get to say `accounting/books registered: false` -
    // it is about to be terminated - so main releases the holders itself.
    accounting.dispose();
    // Ask before killing. `shutdown` lets the worker dispose its own core - a durable store mid-write,
    // a transport mid-close - whereas `terminate()` stops it between two machine instructions.
    bridge.emit({ kind: "shutdown" }, NO_TRANSFER);
    bridge.dispose();
    worker.terminate();
    // A never-settled `ready` outlives the handle otherwise, and its awaiter hangs on a worker that no
    // longer exists. A no-op when a fatal already rejected it with the real cause.
    failReady?.(
      new Error("The epic runtime worker was disposed before it was ready"),
    );
  }

  // Everything `disposeHandle` touches now exists, so the deferral above can be discharged.
  fatalTeardown.constructionComplete = true;
  if (fatalTeardown.deferred) {
    disposeHandle();
  }

  return {
    port: bridge,
    ready,
    currentUser(userId): void {
      if (disposed) return;
      bridge.emit({ kind: "current-user", userId }, NO_TRANSFER);
    },
    awarenessOut(docKey, frame, localClientId): void {
      if (disposed) return;
      const encoded = takeBytesForTransfer(frame);
      bridge.emit(
        {
          kind: "body/awareness-out",
          docKey,
          frame: encoded.bytes,
          localClientId,
        },
        encoded.transfer,
      );
    },
    command(command): void {
      if (disposed) return;
      bridge.emit({ kind: "runtime/command", command }, NO_TRANSFER);
    },
    detach,
    dispose: disposeHandle,
  };
}

/**
 * The production worker. The literal form matters and is not stylistic: Vite recognises a worker
 * only when `new URL(<static string>, import.meta.url)` appears DIRECTLY inside `new Worker(...)`.
 */
export function createEpicRuntimeWorker(): RuntimeWorkerLike {
  const worker = new Worker(
    new URL("./epic-runtime-worker-entry.ts", import.meta.url),
    {
      type: "module",
      name: "traycer-epic-runtime",
    },
  );
  // Forwarded rather than returned directly, and this is the ONE place the DOM-event shape of a
  // worker fault is known.
  return {
    postMessage: (message, transfer) => {
      worker.postMessage(message, transfer);
    },
    addEventListener: (type, listener) => {
      worker.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      worker.removeEventListener(type, listener);
    },
    terminate: () => {
      worker.terminate();
    },
    onWorkerFault: (listener) => {
      worker.addEventListener("error", (event) => {
        listener(
          event.message === ""
            ? "the epic runtime worker module failed to load"
            : event.message,
        );
      });
      worker.addEventListener("messageerror", () => {
        listener("the epic runtime worker sent an undeserializable message");
      });
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime worker event ${JSON.stringify(value)}`);
}
