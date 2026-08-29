/**
 * Starting the runtime worker from the main thread, and everything that has to
 * be true the moment it exists.
 *
 * Four jobs, in order, because each depends on the previous one:
 *
 *  1. construct the worker, put a typed endpoint over it, and give that
 *     endpoint the main side of the two worker->main calls;
 *  2. hand it the bootstrap it validates its protocol against;
 *  3. start the pumps, so the worker holds a credential AND an address before
 *     anything it owns tries to dial;
 *  4. relay what comes back - logs, a fatal, projections, and the one piece of
 *     evidence the main thread owns the decision about (host recovery).
 *
 * Order (3)-after-(2) is not load-bearing (the worker applies a push whether or
 * not it has seen the bootstrap), but order (3)-before-any-work is: a worker
 * that opened a transport before its first push would fail its first dial and
 * enter backoff for no reason.
 *
 * The two call handlers in (1) are built from instances the CALLER holds. That
 * is the whole content of the ruling behind them - both are app-wide
 * single-flights, and an app-wide single-flight that gets constructed per
 * worker is not one. See `MainCallMap` for why exactly two.
 *
 * The worker constructor is INJECTED rather than called here. That is what
 * lets the suites drive a real endpoint over a fake worker; it is also what
 * keeps `new Worker(...)` out of every module a test imports, since jsdom has
 * no `Worker` at all.
 */
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { HostCredentialMintFlow } from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import {
  createMainBridgeEndpoint,
  type MainCallHandlers,
  type RuntimeWorkerPort,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
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
import {
  startBearerPump,
  type BearerPumpHostClient,
} from "./epic-runtime-bearer-pump";
import { startEndpointPump } from "./epic-runtime-endpoint-pump";

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
  readonly hostClient: BearerPumpHostClient;
  readonly relay: RuntimeWorkerLogRelay;
  /** The host this worker's transport dials, for its whole life. */
  readonly hostId: string;
  /** The signed-in user the session is bound to. Also fixed for life. */
  readonly userId: string;
  /**
   * THE app-wide stream auth revalidator - the instance the caller already
   * holds, never a fresh one.
   *
   * This is passed rather than constructed, and the distinction is the entire
   * reason `main/auth-revalidate` exists as a call instead of as code the
   * worker runs. `revalidateForReconnect` is single-flighted with the same
   * shared refresh unary RPC uses across 13 consumers; a worker that built its
   * own would mint one refresh per open epic on a single expiry, which is the
   * thundering herd the single-flight was written to stop.
   */
  readonly auth: StreamAuthRevalidator;
  /**
   * THE app-wide host-credential mint flow - `appHostCredentialMintFlow`.
   *
   * Single-flight PER HOST across the whole app, and the server supersedes
   * older credentials on every mint, so two concurrent mints revoke each
   * other's rows and settle as 409s - leaving the host with nothing. Its
   * single-flight state (the attempt map, the adoption claim, the escalation
   * ladder) lives in MODULE scope, which means a worker that imported the
   * module would get a second copy of all of it rather than a second reference
   * to one. That is why this crosses as a call and why nothing under the worker
   * tree may import the provisioning module.
   */
  readonly mint: HostCredentialMintFlow;
  /** The live dialable-endpoint read, pushed into the worker on change. */
  readonly endpoint: HostEndpointProvider;
  /** Subscribes to host-directory changes; fires on ANY change. */
  readonly subscribeEndpointChange: (onChange: () => void) => () => void;
  /**
   * Called when the worker's own transport evidences THIS host recovering.
   *
   * Routed to `HostClient.notifyHostAvailabilityRecovered(hostId)` by the
   * caller, exactly as the main-thread durable transport does today. An event
   * rather than a call because nothing is answered and nothing waits: the
   * selection authority lives on the main thread and the worker does not care
   * what it decides.
   */
  readonly onHostRecovered: () => void;
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
  /** Identifies this renderer window in the worker's log lines. */
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
  // Built from the instances the CALLER holds, and from nothing else. There is
  // no construction in this map on purpose: a `createStreamAuthRevalidator(...)`
  // or an import of the mint module here would compile, pass every behavioural
  // test, and quietly give each worker its own single-flight - which is the one
  // failure both of these calls exist to prevent.
  const mainCallHandlers: MainCallHandlers = {
    "main/auth-revalidate": async () => ({
      outcome: await options.auth.revalidateForReconnect(),
    }),
    "main/mint-credential": async (request) => ({
      outcome: await options.mint(request.mint),
    }),
  };
  const bridge = createMainBridgeEndpoint(
    createMessageTargetTransport(worker),
    mainCallHandlers,
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
      case "host-recovered":
        options.onHostRecovered();
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
        hostId: options.hostId,
        userId: options.userId,
        windowLabel: options.windowLabel,
      },
    },
    NO_TRANSFER,
  );

  const stopEndpointPump = startEndpointPump({
    endpoint: options.endpoint,
    subscribeEndpointChange: options.subscribeEndpointChange,
    push: (endpoint) => {
      bridge.emit({ kind: "endpoint", endpoint }, NO_TRANSFER);
    },
    onReadFailure: (cause) => {
      options.relay.log({
        level: "error",
        message: "[epic-runtime-worker] endpoint read failed; pushed null",
        fields: { windowLabel: options.windowLabel },
        error: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });

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
    port: bridge,
    ready,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Pumps first: a push landing after the endpoint is disposed is dropped
      // silently, and a credential quietly going nowhere is the wrong last
      // thing to happen on this bridge.
      stopPump();
      stopEndpointPump();
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
