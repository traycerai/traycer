/**
 * Starting the runtime worker from the main thread, and everything that has to
 * be true the moment it exists.
 *
 * Four jobs, in order, because each depends on the previous one:
 *
 *  1. construct the worker and put a typed endpoint over it;
 *  2. build the stream proxy host over the session's REAL stream client, so
 *     the worker's `IStreamClient` has something behind it;
 *  3. hand it the bootstrap it validates its protocol against;
 *  4. relay what comes back - logs, a fatal, projections, and the proxy's own
 *     traffic.
 *
 * The socket is NOT among those jobs, and that is the design rather than an
 * omission: the durable transport stays exactly where it is, because
 * `buildHostStreamClient`'s remote branch reaches a module-scoped process-wide
 * `RemoteSession` cache and a worker copy of it is a second Noise session and
 * relay socket per (hostId, userId). What moves is the four typed wrappers and
 * their decode - see `stream-proxy-protocol.ts`.
 *
 * The worker constructor is INJECTED rather than called here. That is what
 * lets the suites drive a real endpoint over a fake worker; it is also what
 * keeps `new Worker(...)` out of every module a test imports, since jsdom has
 * no `Worker` at all.
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
  type WriteCommandOutcome,
  type RuntimeWorkerLogEntry,
  type RuntimeCommand,
  type WorkerToMainEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import {
  NO_TRANSFER,
  takeBytesForTransfer,
} from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import { createMainAccountingBridge } from "./main-accounting-bridge";
import type { EpicRuntimeAccountingPort } from "../epic-runtime-accounting-port";

/** The part of `Worker` this module uses. */
export interface RuntimeWorkerLike extends BridgeMessageTargetLike {
  terminate(): void;
}

/**
 * Where a worker's log lines and its fatal go.
 *
 * A sink rather than a direct `appLogger` import, so this module stays
 * constructible in a suite and so the relay's own behaviour (a fatal is not
 * just another log line) is visible at the call site.
 */
export interface RuntimeWorkerLogRelay {
  log(entry: RuntimeWorkerLogEntry): void;
  fatal(message: string, stack: string | null): void;
}

/**
 * Where the body plane's RETURN leg lands.
 *
 * Named and exported because two modules must agree on it and neither owns
 * both ends: the spawner RECEIVES it, and the store PROVIDES it (it is the
 * store that holds the live docs). A structural copy on each side would let
 * one drift without the other noticing - the same reason `projection` is a
 * named contract rather than an inline shape.
 */
export interface EpicRuntimeBodyReturnTarget {
  applyDocUpdate(docKey: string, update: Uint8Array): void;
  applyAwareness(docKey: string, frame: Uint8Array): void;
}

export interface SpawnEpicRuntimeWorkerOptions<TProjection> {
  readonly createWorker: () => RuntimeWorkerLike;
  /**
   * Where a worker's log lines and its fatal go. A fatal is NOT just another
   * log line: the runtime behind the bridge is gone, so a UI waiting on
   * projections must be told rather than left waiting.
   */
  readonly relay: RuntimeWorkerLogRelay;
  /**
   * Sends one epic write command on this session's unary requester, and
   * CLASSIFIES its failure here on the main thread.
   *
   * Classification is main's because an `Error` does not survive structured
   * clone: the worker must receive `CommandSendFailure` - the classifier's own
   * union - never a thrown object it would have to reconstruct. The worker's
   * command queue then re-throws it as a carrier and unwraps it in its own
   * `classifyFailure`, which leaves the SHARED `CommandQueueOptions` contract
   * untouched.
   */
  readonly writeCommand: (
    commandId: string,
    intent: unknown,
  ) => Promise<WriteCommandOutcome>;
  /**
   * The session's REAL stream client, which stays on this thread.
   *
   * The worker gets a proxy over it, never the thing itself: the durable
   * transport underneath reaches a module-scoped process-wide `RemoteSession`
   * cache, so a second copy in a worker is a second Noise session and relay
   * socket per (hostId, userId).
   */
  readonly streams: IStreamClient<HostStreamRpcRegistry>;
  /** Identifies this renderer window in the worker's log lines. */
  /**
   * What to do with published projection slices.
   *
   * Handlers rather than a raw callback, because the spawner constructs the
   * ONE reducer that orders them. Handing a caller `(revision, value)` would
   * let it build a second reducer with a second watermark over the same
   * stream, and two watermarks drop each other's deliveries as stale - a
   * projection that updates half the time. The spawner still does not NARROW:
   * `accept` is the caller's, because the slice's shape is the store's.
   */
  readonly projection: RuntimeProjectionHandlers<TProjection>;
  /**
   * The process-backed books this worker's runtime reports into.
   *
   * Built by the CALLER on main, exactly as the in-process store builds it, so
   * both arms draw their runtime token from the one process-wide sequence.
   * Nothing about it crosses the bridge - the worker pushes byte facts in the
   * runtime's own vocabulary and this side names the holders.
   */
  /**
   * A collaborator's edit and a remote presence frame, both for the live doc
   * main holds. See {@link EpicRuntimeBodyReturnTarget} for who provides it.
   *
   * An unknown `docKey` is dropped by the implementation, silently - presence
   * and edits for a body main is not holding have nowhere to go, and there is
   * no answer a fire-and-forget sender could act on.
   */
  readonly body: EpicRuntimeBodyReturnTarget;
  readonly accounting: EpicRuntimeAccountingPort;
  /** The epic this worker serves for its whole life. */
  readonly epicId: string;
  readonly windowLabel: string;
}

export interface EpicRuntimeWorkerHandle {
  /**
   * The ask half of the bridge - `call` and nothing else.
   *
   * Deliberately NOT the endpoint. Handing out `onEvent` would let a caller
   * subscribe a second projection reducer beside the one this spawner owns,
   * which is the two-watermark defect; a narrower type makes that unreachable
   * instead of merely discouraged.
   */
  readonly port: RuntimeWorkerPort;
  /**
   * Resolves when the worker has acknowledged the bootstrap, and rejects if it
   * reported a protocol mismatch instead.
   *
   * A promise rather than a flag because every caller has to decide what to do
   * about a worker that never answered, and a flag lets that decision be
   * skipped by accident.
   */
  readonly ready: Promise<void>;
  /**
   * Ends the TRANSPORT while the worker lives on - path 2 (`detachTransport`),
   * where a retained-dirty buffer must stop dialling a host this window has
   * left but keeps its replica. Every real session is reported closed to the
   * worker first. Idempotent.
   *
   * Must run BEFORE `closeSessionTransport()` at the call site: closing the
   * transport first kills the sessions before they can be reported.
   */
  /**
   * Send one fire-and-forget command to the relocated runtime.
   *
   * Narrow on purpose, like `port`: this is the ONE way to push a
   * `runtime/command`, so a caller cannot reach `emit` and publish something
   * else on the same channel. Ordering across these and the stream frames is
   * `postMessage` FIFO - see `RuntimeCommandMap`.
   */
  command(command: RuntimeCommand): void;
  /**
   * Send a local presence frame for one body.
   *
   * Its own member rather than a `runtime/command` payload: presence is not a
   * runtime COMMAND, it is a frame for the arm, and folding it in would put a
   * per-keystroke-rate channel through a vocabulary whose members are user
   * gestures and record pushes.
   */
  awarenessOut(docKey: string, frame: Uint8Array, localClientId: number): void;
  /**
   * Tell the worker who is signed in.
   *
   * The worker's projector folds on `getCurrentUserId()`, which is fed by this
   * event and by nothing else - and until now NOTHING EMITTED IT. The protocol
   * declared the event and the worker host handled it; the producer was simply
   * never written, so the fold ran with a null user for the whole session and
   * a null user is the fail-OPEN direction: foreign chats and terminal agents
   * are not hidden, and same-account role claims do not project.
   *
   * Pushed rather than answered on demand, because the worker needs it before
   * its first projection and identity arrives on main's own schedule (the auth
   * profile hydrates after the session is constructed).
   */
  currentUser(userId: string | null): void;
  detach(): void;
  /**
   * Re-binds the worker to a NEW transport after a detach - a fresh proxy host,
   * never a swap of the old one's client, because `streamId`s are the worker's
   * and two generations in one map would collide.
   */
  attach(streams: IStreamClient<HostStreamRpcRegistry>): void;
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
  // Built from what the caller holds. The one worker->main call, answered by
  // the session's own requester - see `MainCallMap` for why it is a call.
  const mainCallHandlers: MainCallHandlers = {
    "main/write-command": (request) =>
      options.writeCommand(request.commandId, request.intent),
  };
  const bridge = createMainBridgeEndpoint(
    createMessageTargetTransport(worker),
    mainCallHandlers,
  );
  // The proxy host owns the REAL sessions the worker opens. It is the object
  // this side detaches, not the socket - and it is a SLOT rather than a
  // constant, because a re-attach binds a NEW host over the new transport:
  // `streamId`s are the worker's, so two generations sharing one host would
  // collide in one map.
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
  // A caller may legitimately never await `ready` - a surface that only wants
  // projections has nothing to do about a slow handshake. Attaching a handler
  // here keeps that from becoming an unhandled rejection on dispose, while
  // leaving the rejection visible to anyone who does await.
  void ready.catch(() => undefined);

  // The one reducer for this worker's projection stream, constructed here so
  // there can be no second one.
  const projections = createRuntimeProjectionOrdering(options.projection);

  // Turns the worker's byte pushes back into calls on the real books, and
  // answers the accountant's synchronous reads from the snapshot each push
  // carries. The demote it dispatches is the one inbound member.
  const accounting = createMainAccountingBridge({
    port: options.accounting,
    dispatchDemote: (overBytes) => {
      bridge.emit({ kind: "accounting/demote", overBytes }, NO_TRANSFER);
    },
  });

  const unsubscribeEvents = bridge.onEvent((event: WorkerToMainEvent) => {
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
      case "stream/open":
      case "stream/params":
      case "stream/send":
      case "stream/reconnect":
      case "stream/close":
        // Every unknown id is dropped inside the host, silently and on purpose:
        // a frame can be in flight when a session closes, and a throw here is
        // an unhandled error in a `message` listener with no route back.
        proxy?.handle(event);
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
        // The runtime behind the bridge is gone, so its books must not stay
        // attached to the process planes. Without this the accountant keeps a
        // dead runtime's cached numbers and dispatches demote requests into a
        // bridge nothing is listening on - a plane that never reclaims and
        // never explains why. Idempotent, so the `dispose()` that follows a
        // surfaced fatal is not a second deregistration.
        accounting.dispose();
        options.relay.fatal(event.message, event.stack);
        // A fatal before the handshake is the handshake's answer. After it,
        // the promise has already settled and this is a no-op - the relay is
        // what surfaces a mid-life fatal.
        failReady?.(new Error(event.message));
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
        windowLabel: options.windowLabel,
      },
    },
    NO_TRANSFER,
  );

  let disposed = false;

  function detach(): void {
    const detaching = proxy;
    proxy = null;
    // While the bridge is still LIVE and its events still routed. Every real
    // session gets its `closed` + `caller` report on the way out, and the
    // worker's adapters run their close handling instead of watching a stream
    // go quiet - which is indistinguishable from a slow host.
    //
    // This ordering was wrong once, in exactly the way that is invisible: the
    // teardown ran first, so the reports were posted into a disposed bridge
    // and dropped, and the pin missed it because it drove the proxy host
    // directly rather than this handle.
    detaching?.dispose();
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
    attach(streams): void {
      if (disposed) return;
      // A FRESH host, never a swap of the old one's client.
      detach();
      proxy = buildProxy(streams);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Detach FIRST, and through the same function the detach-only path uses -
      // one copy of the close-then-teardown ordering, because a second copy is
      // what got it wrong the first time.
      detach();
      // Only then stop routing. Unsubscribing before the detach drops every
      // report even on a live bridge.
      unsubscribeEvents();
      // The worker will not get to say `accounting/books registered: false` -
      // it is about to be terminated - so main releases the holders itself.
      accounting.dispose();
      // Ask before killing. `shutdown` lets the worker dispose its own core -
      // a durable store mid-write, a transport mid-close - whereas
      // `terminate()` stops it between two machine instructions.
      bridge.emit({ kind: "shutdown" }, NO_TRANSFER);
      bridge.dispose();
      // Nothing waits on the shutdown being observed: a worker that stopped
      // answering is exactly the case `terminate()` is for, and holding the
      // window open on it would make disposal depend on the health of the
      // thing being disposed.
      worker.terminate();
      // A never-settled `ready` outlives the handle otherwise, and its awaiter
      // hangs on a worker that no longer exists.
      failReady?.(
        new Error("The epic runtime worker was disposed before it was ready"),
      );
    },
  };
}

/**
 * The production worker.
 *
 * The literal form matters and is not stylistic: Vite recognises a worker only
 * when `new URL(<static string>, import.meta.url)` appears DIRECTLY inside
 * `new Worker(...)`. A URL built in a variable first, or a template with an
 * interpolation, compiles fine and resolves at runtime to a path that does not
 * exist in the bundle. Both bundles that build this app (the desktop
 * renderer's `vite.renderer.config.ts` and mobile's `vite.config.ts`) rely on
 * that same recognition, so the shape has to survive edits in both.
 *
 * `type: "module"` is carried through to the constructed worker verbatim -
 * Vite rewrites the URL and leaves the options alone - and the emitted worker
 * is a same-origin asset file, never a `blob:` or `data:` URL. That is what
 * makes this work under the desktop's CSP unchanged: the policy has no
 * `worker-src`, so a worker falls back to `script-src 'self'`, and the
 * renderer's own origin (`app://renderer/`, a standard secure scheme) covers
 * it. An inline worker (`?worker&inline`) is the form that would need a policy
 * line, and this is deliberately not it.
 */
export function createEpicRuntimeWorker(): RuntimeWorkerLike {
  return new Worker(
    new URL("./epic-runtime-worker-entry.ts", import.meta.url),
    {
      type: "module",
      name: "traycer-epic-runtime",
    },
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime worker event ${JSON.stringify(value)}`);
}
