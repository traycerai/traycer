/**
 * What runs inside the runtime worker.
 *
 * Everything except the two lines that reach for the ambient worker scope,
 * which live in `epic-runtime-worker-entry.ts`. The split is what makes this
 * testable: the suites drive THIS against a real bridge endpoint over a fake
 * port pair, so the frames, the correlation, the bearer holder and the
 * lifecycle are all the production ones - only the pipe is a stand-in.
 *
 * The composition root itself (stream clients, lane and legacy adapters, root
 * replica, projection kernel, cold tier, durable store) is not here yet. It
 * arrives through {@link EpicRuntimeWorkerHost.installCore}, which is the one
 * named seam that phase adds. Until something installs a core, the host is a
 * fully working bridge over an empty runtime: it holds the bearer, it forwards
 * logs, and it answers the reads it can answer - `{ bytes: null }` for an
 * attachment, which is the honest "not available from here" every surviving
 * caller already handles, and not a throw.
 */
import {
  createWorkerBridgeEndpoint,
  type BridgeTransport,
  type RuntimeWorkerCallHandlers,
  type WorkerBridgeEndpoint,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  type MainToWorkerEvent,
  type RuntimeWorkerLogEntry,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import {
  NO_TRANSFER,
  takeBytesForTransfer,
} from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import {
  createWorkerBearerHolder,
  type WorkerBearerHolder,
} from "@traycer-clients/shared/replica-runtime/worker/worker-bearer-holder";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime/runtime-environment";
import { createWorkerRuntimeEnvironment } from "../worker-runtime-environment";

/**
 * The relocated composition root, as the bridge sees it.
 *
 * Deliberately tiny and deliberately not the runtime's own interface: what the
 * bridge needs is the set of operations a MAIN-THREAD caller can ask for, and
 * that set is much smaller than the runtime's surface because everything else
 * the runtime does travels outward as events.
 */
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
  dispose(): void;
}

export interface EpicRuntimeWorkerHost {
  /**
   * The environment every relocated module is constructed with. Available
   * before a core is installed, because building the core needs it.
   */
  readonly environment: RuntimeEnvironment;
  readonly bearer: WorkerBearerHolder;
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
  const bearer = createWorkerBearerHolder();
  let core: EpicRuntimeWorkerCore | null = null;
  let stopped = false;

  const handlers: RuntimeWorkerCallHandlers = {
    "bearer/probe": () =>
      Promise.resolve({ value: bearer.probe(), transfer: NO_TRANSFER }),
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
  };

  // Built before the environment, so the log sink can close over a `const`
  // endpoint rather than a slot that is null until construction finishes -
  // a log line emitted while the core is being built would otherwise vanish.
  const endpoint: WorkerBridgeEndpoint = createWorkerBridgeEndpoint(
    transport,
    handlers,
  );
  const emitLog = (entry: RuntimeWorkerLogEntry): void => {
    endpoint.emit({ kind: "log", entry }, NO_TRANSFER);
  };
  const environment = createWorkerRuntimeEnvironment(emitLog);

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
          endpoint.emit(
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
        endpoint.emit(
          { kind: "ready", protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION },
          NO_TRANSFER,
        );
        return;
      }
      case "bearer": {
        // Applied whether or not `bootstrap` has been seen. The spawner sends
        // bootstrap first and the pipe preserves order, but a holder that
        // dropped a credential because a handshake had not completed would be
        // failing closed for a reason that is not about credentials at all.
        bearer.apply(event.bearer);
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

  const unsubscribe = endpoint.onEvent((event) => {
    try {
      onEvent(event);
    } catch (cause: unknown) {
      // A throw inside a message listener is otherwise an unhandled error with
      // no route back to the main thread, which then waits on a runtime that
      // has already failed.
      endpoint.emit(
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
    endpoint.dispose();
  }

  return {
    environment,
    bearer,
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
