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
  type RuntimeWorkerLogEntry,
  type WorkerToMainEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { NO_TRANSFER } from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";

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

export interface SpawnEpicRuntimeWorkerOptions<TProjection> {
  readonly createWorker: () => RuntimeWorkerLike;
  /**
   * Where a worker's log lines and its fatal go. A fatal is NOT just another
   * log line: the runtime behind the bridge is gone, so a UI waiting on
   * projections must be told rather than left waiting.
   */
  readonly relay: RuntimeWorkerLogRelay;
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
  /** Idempotent. Stops the pump, asks the worker to stop, then terminates it. */
  dispose(): void;
}

export function spawnEpicRuntimeWorker<TProjection>(
  options: SpawnEpicRuntimeWorkerOptions<TProjection>,
): EpicRuntimeWorkerHandle {
  const worker = options.createWorker();
  const bridge = createMainBridgeEndpoint(createMessageTargetTransport(worker));
  // The proxy host owns the REAL sessions the worker opens. It is the object
  // this side detaches, not the socket.
  const proxy: StreamProxyHost = createStreamProxyHost(
    options.streams,
    (event, transfer) => {
      bridge.emit(event, transfer);
    },
  );

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
        proxy.handle(event);
        return;
      case "fatal":
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
        windowLabel: options.windowLabel,
      },
    },
    NO_TRANSFER,
  );

  let disposed = false;
  return {
    port: bridge,
    ready,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeEvents();
      // Ask before killing. `shutdown` lets the worker dispose its own core -
      // a durable store mid-write, a transport mid-close - whereas
      // `terminate()` stops it between two machine instructions.
      bridge.emit({ kind: "shutdown" }, NO_TRANSFER);
      bridge.dispose();
      // Every real session this worker opened, closed here. A worker that was
      // terminated mid-life never sends its own closes, and a session left
      // subscribed is a socket carrying frames nothing reads.
      proxy.dispose();
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
