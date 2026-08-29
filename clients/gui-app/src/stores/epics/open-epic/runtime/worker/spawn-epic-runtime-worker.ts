/**
 * Starting the runtime worker from the main thread, and everything that has to
 * be true the moment it exists.
 *
 * Three jobs, in order, because each depends on the previous one:
 *
 *  1. construct the worker and put a typed endpoint over it;
 *  2. hand it the bootstrap it validates its protocol against;
 *  3. start the bearer pump, so the worker holds a credential before anything
 *     it owns tries to dial.
 *
 * Order (3)-after-(2) is not load-bearing (the worker applies a bearer push
 * whether or not it has seen the bootstrap), but order (3)-before-any-work is:
 * a worker that opened a transport before its first push would fail its first
 * dial and enter backoff for no reason.
 *
 * The worker constructor is INJECTED rather than called here. That is what
 * lets the suites drive a real endpoint over a fake worker; it is also what
 * keeps `new Worker(...)` out of every module a test imports, since jsdom has
 * no `Worker` at all.
 */
import {
  createMainBridgeEndpoint,
  type MainBridgeEndpoint,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
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
import {
  startBearerPump,
  type BearerPumpHostClient,
} from "./epic-runtime-bearer-pump";

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

export interface SpawnEpicRuntimeWorkerOptions {
  readonly createWorker: () => RuntimeWorkerLike;
  readonly hostClient: BearerPumpHostClient;
  readonly relay: RuntimeWorkerLogRelay;
  /**
   * Where published projection slices go.
   *
   * The spawner owns the ONE subscription to this stream and forwards it here
   * verbatim, un-narrowed. It does not narrow because the slice's shape is the
   * store's, and it does not hold a watermark because the ordering belongs to
   * exactly one place (`createRuntimeProjectionOrdering`) - two watermarks over
   * one stream drop each other's deliveries as stale, which presents as a
   * projection that updates half the time.
   */
  readonly onProjection: (revision: number, value: unknown) => void;
  /** Identifies this renderer window in the worker's log lines. */
  readonly windowLabel: string;
}

export interface EpicRuntimeWorkerHandle {
  /** The typed bridge. The composition root that moves in speaks through it. */
  readonly bridge: MainBridgeEndpoint;
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

export function spawnEpicRuntimeWorker(
  options: SpawnEpicRuntimeWorkerOptions,
): EpicRuntimeWorkerHandle {
  const worker = options.createWorker();
  const bridge = createMainBridgeEndpoint(createMessageTargetTransport(worker));

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

  const unsubscribeEvents = bridge.onEvent((event: WorkerToMainEvent) => {
    switch (event.kind) {
      case "ready":
        settleReady?.();
        return;
      case "log":
        options.relay.log(event.entry);
        return;
      case "projection":
        options.onProjection(event.revision, event.value);
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

  const stopPump = startBearerPump({
    hostClient: options.hostClient,
    push: (bearer) => {
      bridge.emit({ kind: "bearer", bearer }, NO_TRANSFER);
    },
    onReadFailure: (cause) => {
      options.relay.log({
        level: "error",
        message: "[epic-runtime-worker] bearer read failed; pushed absent",
        fields: { windowLabel: options.windowLabel },
        error: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });

  let disposed = false;
  return {
    bridge,
    ready,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Pump first: a push landing after the endpoint is disposed is dropped
      // silently, and a credential quietly going nowhere is the wrong last
      // thing to happen on this bridge.
      stopPump();
      unsubscribeEvents();
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
